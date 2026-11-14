import type {
  BoundaryResult,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { isSubagentFinished, type SubagentManager, type SubagentRecord } from "./manager.ts";

/** Custom message type of automatically delivered results (S5). */
export const SUBAGENT_RESULT_MESSAGE = "subagents-result";

/** Longest result text the main model receives automatically (S5). */
export const SUBAGENT_RESULT_LIMIT = 8000;

/** Longest wait for siblings in grouped delivery, from the first ready result (S5). */
const GROUP_WAIT_MS = 60_000;

/** Snapshots shown by the result block. They keep the full text for expansion. */
export interface SubagentResultDetails {
  records: SubagentRecord[];
}

/** Cuts automatically delivered text at the limit and points to the full result (S5). */
function cutSubagentResult(text: string, name: string): string {
  if (text.length <= SUBAGENT_RESULT_LIMIT) return text;
  return (
    text.slice(0, SUBAGENT_RESULT_LIMIT) +
    `\n\n[Result cut at ${SUBAGENT_RESULT_LIMIT} characters. Call get_subagent_result with name "${name}" for the full text.]`
  );
}

function resultText(record: SubagentRecord): string {
  const partial = record.partial ? " (partial: turn limit reached)" : "";
  const header = `Agent ${record.name} (${record.agentType}) ${record.status}${partial}.`;
  if (record.stoppedBy === "user") {
    const result = cutSubagentResult(record.result, record.name);
    return `${header} The user stopped it.${result ? `\n\n${result}` : ""}`;
  }
  let body = record.result || record.error || "(no answer)";
  if (record.error && record.result) body += `\nError: ${record.error}`;
  return `${header}\n\n${cutSubagentResult(body, record.name)}`;
}

/** Decides when and how finished background results reach the main model (S5). */
export class SubagentDelivery {
  private busy = false;
  private disposed = false;
  /** Ready results the model has not read yet, in completion order. */
  private ready: SubagentRecord[] = [];
  /** When each request's first unread result became ready, for the grouped deadline. */
  private readyAt = new Map<number, number>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    private readonly manager: SubagentManager,
  ) {
    manager.onRunSettled = (record) => this.settled(record);
  }

  private settled(record: SubagentRecord): void {
    if (this.disposed) return;
    if (record.receipt === "unread") {
      // A continued agent can still wait here with its earlier result. Its newest result replaces
      // that one, so the agent is reported once.
      this.ready = this.ready.filter((waiting) => waiting !== record);
      this.ready.push(record);
      if (!this.readyAt.has(record.requestId)) this.readyAt.set(record.requestId, Date.now());
    }
    // A suppressed sibling can also complete a waiting group.
    if (!this.busy && this.ctx.isIdle()) this.flushIdle();
  }

  /**
   * After a reload or a resumed session: delivers results that had finished before it but were
   * still waiting, for example for a sibling in grouped mode (S5).
   */
  deliverRestored(): void {
    for (const record of this.manager.list()) {
      if (record.receipt !== "unread") continue;
      this.ready.push(record);
      if (!this.readyAt.has(record.requestId)) this.readyAt.set(record.requestId, Date.now());
    }
    if (!this.busy && this.ctx.isIdle()) this.flushIdle();
  }

  /** The main session started a run, so ready results wait for a boundary instead. */
  agentStarted(): void {
    this.busy = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** At a turn boundary that continues, add ready results to the next request without an extra one. */
  turnEnded(event: TurnEndEvent): BoundaryResult | undefined {
    if (this.disposed || event.toolResults.length === 0) return undefined;
    const batch = this.take(this.ready);
    if (!batch.length) return undefined;
    const draft: CustomMessageEntryDraft = {
      type: "custom_message",
      customType: SUBAGENT_RESULT_MESSAGE,
      content: batch.map(resultText).join("\n\n---\n\n"),
      display: true,
      details: { records: batch.map((record) => ({ ...record })) } satisfies SubagentResultDetails,
    };
    for (const record of batch) this.manager.markReceipt(record, "delivered");
    return { entries: [...event.entries, draft] };
  }

  /** The main session stopped. Results it did not read are now idle deliveries. */
  agentSettled(): void {
    this.busy = false;
    this.flushIdle();
  }

  private flushIdle(): void {
    if (this.disposed) return;
    this.forgetDelivered();
    if (this.manager.settings.delivery.mode === "immediate") {
      this.send(this.take(this.ready));
      return;
    }
    const requests = new Set(this.ready.map((record) => record.requestId));
    for (const requestId of requests) {
      const group = this.ready.filter((record) => record.requestId === requestId);
      const outstanding = this.manager
        .list()
        .some(
          (record) =>
            record.requestId === requestId &&
            record.background &&
            record.receipt === "pending" &&
            !isSubagentFinished(record.status),
        );
      if (!outstanding) {
        this.sendGroup(group);
        continue;
      }
      if (this.timers.has(requestId)) continue;
      const deadline = (this.readyAt.get(requestId) ?? Date.now()) + GROUP_WAIT_MS;
      const timer = setTimeout(
        () => {
          this.timers.delete(requestId);
          if (this.busy || this.disposed) return;
          // Report what finished. Stragglers form the next batch.
          this.sendGroup(this.ready.filter((record) => record.requestId === requestId));
        },
        Math.max(0, deadline - Date.now()),
      );
      this.timers.set(requestId, timer);
    }
  }

  private sendGroup(group: SubagentRecord[]): void {
    this.send(this.take(group));
  }

  /** Removes the given records from the ready list and keeps only those still unread. */
  private take(records: SubagentRecord[]): SubagentRecord[] {
    const taken = new Set(records);
    this.ready = this.ready.filter((record) => !taken.has(record));
    this.forgetDelivered();
    return records.filter((record) => record.receipt === "unread");
  }

  /**
   * Drops results that no longer wait, such as one the model read with get_subagent_result. A
   * request with no waiting result loses its 60-second clock, so its next result starts a new wait.
   */
  private forgetDelivered(): void {
    this.ready = this.ready.filter((record) => record.receipt === "unread");
    for (const requestId of this.readyAt.keys()) {
      if (!this.ready.some((record) => record.requestId === requestId)) {
        this.readyAt.delete(requestId);
      }
    }
  }

  private send(batch: SubagentRecord[]): void {
    if (!batch.length) return;
    // Agents the user stopped report without starting a main-model turn (S5).
    const triggerTurn = batch.some((record) => record.stoppedBy !== "user");
    for (const record of batch) this.manager.markReceipt(record, "delivered");
    this.pi.sendMessage(
      {
        customType: SUBAGENT_RESULT_MESSAGE,
        content: batch.map(resultText).join("\n\n---\n\n"),
        display: true,
        details: {
          records: batch.map((record) => ({ ...record })),
        } satisfies SubagentResultDetails,
      },
      { triggerTurn },
    );
  }

  /** Stops delivery before shutdown aborts any agent, so nothing arrives late (S7). */
  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.ready = [];
  }
}
