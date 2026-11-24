import type {
  BoundaryResult,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import {
  isSubagentFinished,
  SUBAGENT_READ_ENTRY,
  SUBAGENT_RECORD_ENTRY,
  type SubagentManager,
  type SubagentRecord,
} from "./manager.ts";

/** Custom message type of automatically delivered results. */
export const SUBAGENT_RESULT_MESSAGE = "subagents-result";

/** Longest result text the main model receives automatically. */
export const SUBAGENT_RESULT_LIMIT = 8000;

/** Longest wait for siblings in grouped delivery, from the first ready result. */
const GROUP_WAIT_MS = 60_000;

/** Time between checks while Pi compacts or summarizes a branch on the user's command. */
const IDLE_CHECK_MS = 1000;

/** Snapshots shown by the result block. They keep the full text for expansion. */
export interface SubagentResultDetails {
  records: SubagentRecord[];
}

function subagentRunKey({ id, run }: Pick<SubagentRecord, "id" | "run">): string {
  return `${id}:${run}`;
}

function savedSubagentRunKey(data: unknown): string | undefined {
  if (
    typeof data !== "object" ||
    data === null ||
    !("id" in data) ||
    typeof data.id !== "string" ||
    !("run" in data) ||
    typeof data.run !== "number"
  )
    return undefined;
  return subagentRunKey({ id: data.id, run: data.run });
}

function readSubagentBranch(ctx: ExtensionContext, sessionId: string) {
  const started = new Set<string>();
  const received = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === SUBAGENT_RECORD_ENTRY) {
      const record = entry.data as Partial<SubagentRecord> | undefined;
      if (record?.sessionId !== sessionId) continue;
      const key = savedSubagentRunKey(record);
      if (!key) continue;
      // Only the launch snapshot is queued. A running or finished snapshot can be saved
      // on a different branch if the user navigated while the subagent was working.
      if (record.status === "queued") started.add(key);
      // Older versions recorded explicit reads as full snapshots.
      if (record.receipt === "consumed") received.add(key);
    } else if (entry.type === "custom" && entry.customType === SUBAGENT_READ_ENTRY) {
      const key = savedSubagentRunKey(entry.data);
      if (key) received.add(key);
    } else if (entry.type === "custom_message" && entry.customType === SUBAGENT_RESULT_MESSAGE) {
      const details = entry.details as Partial<SubagentResultDetails> | undefined;
      if (!Array.isArray(details?.records)) continue;
      for (const record of details.records) {
        const key = savedSubagentRunKey(record);
        if (key) received.add(key);
      }
    }
  }
  return { started, received };
}

/** Cuts automatically delivered text at the limit and points to the full result. */
function cutSubagentResult(text: string, record: SubagentRecord): string {
  if (text.length <= SUBAGENT_RESULT_LIMIT) return text;
  return (
    text.slice(0, SUBAGENT_RESULT_LIMIT) +
    `\n\n[Result cut at ${SUBAGENT_RESULT_LIMIT} characters. Call get_subagent_result with name "${record.name}" and run ${record.run} for the full text.]`
  );
}

function resultText(record: SubagentRecord): string {
  const partial = record.partial ? " (partial: turn limit reached)" : "";
  const header = `Agent ${record.name} (${record.agentType}, run ${record.run}) ${record.status}${partial}.`;
  if (record.stoppedBy === "user") {
    const result = cutSubagentResult(record.result, record);
    return `${header} The user stopped it.${result ? `\n\n${result}` : ""}`;
  }
  let body = record.result || record.error || "(no answer)";
  if (record.error && record.result) body += `\nError: ${record.error}`;
  return `${header}\n\n${cutSubagentResult(body, record)}`;
}

function resultMessage(batch: SubagentRecord[]): CustomMessageEntryDraft {
  return {
    type: "custom_message",
    customType: SUBAGENT_RESULT_MESSAGE,
    content: batch.map(resultText).join("\n\n---\n\n"),
    display: true,
    details: { records: batch } satisfies SubagentResultDetails,
  };
}

/** Delivers finished background runs only to branches that started them and still need the result. */
export class SubagentDelivery {
  private busy = false;
  private disposed = false;
  private idleCheck: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    private readonly manager: SubagentManager,
  ) {
    manager.onRunSettled = () => this.scheduleIdleCheck(0);
  }

  /** Recheck saved results after opening a session or navigating its tree. */
  branchChanged(): void {
    // Let Pi finish installing the new branch and updating its UI before starting a turn.
    this.scheduleIdleCheck(0);
  }

  /** The main session started a run, so ready results wait for a boundary instead. */
  agentStarted(): void {
    this.busy = true;
    clearTimeout(this.idleCheck);
    this.idleCheck = undefined;
  }

  /** At a turn boundary that continues, add ready results to the next request without an extra one. */
  turnEnded(event: TurnEndEvent): BoundaryResult | undefined {
    if (this.disposed || event.toolResults.length === 0) return undefined;
    const { ready } = this.branchResults();
    if (!ready.length) return undefined;
    return { entries: [...event.entries, resultMessage(ready)] };
  }

  /** The main session stopped. Results it did not read are now idle deliveries. */
  agentSettled(): void {
    this.busy = false;
    // In the TUI, check the branch after Pi finishes the event. Pi defers sends made inside
    // agent_settled, so the branch could change before a send made here actually runs.
    if (this.ctx.mode === "tui") this.scheduleIdleCheck(0);
    else this.flushIdle();
  }

  private branchResults() {
    const finished = this.manager.finishedBackgroundRuns();
    if (!finished.length) return { ready: [], started: new Set<string>() };
    const { started, received } = readSubagentBranch(this.ctx, this.manager.sessionId);
    const ready = finished.filter((record) => {
      const key = subagentRunKey(record);
      return started.has(key) && !received.has(key);
    });
    return { ready, started };
  }

  private scheduleIdleCheck(delay: number): void {
    if (this.disposed || this.busy) return;
    clearTimeout(this.idleCheck);
    this.idleCheck = setTimeout(() => this.flushIdle(), delay);
  }

  private flushIdle(): void {
    clearTimeout(this.idleCheck);
    this.idleCheck = undefined;
    if (this.disposed || this.busy) return;
    const { ready, started } = this.branchResults();
    if (!ready.length) return;
    if (!this.ctx.isIdle()) {
      // Compaction and branch summaries can keep Pi busy without an agent_settled event.
      this.scheduleIdleCheck(IDLE_CHECK_MS);
      return;
    }

    if (this.manager.settings.delivery.mode === "immediate") {
      this.send(ready);
      return;
    }

    const outstanding = new Set<number>();
    for (const record of this.manager.list()) {
      if (
        record.background &&
        !isSubagentFinished(record.status) &&
        started.has(subagentRunKey(record))
      ) {
        outstanding.add(record.requestId);
      }
    }
    const deadlines = new Map<number, number>();
    const now = Date.now();
    for (const record of ready) {
      if (!outstanding.has(record.requestId)) continue;
      const deadline = (record.endedAt ?? now) + GROUP_WAIT_MS;
      deadlines.set(
        record.requestId,
        Math.min(deadlines.get(record.requestId) ?? deadline, deadline),
      );
    }
    const batch = ready.filter((record) => (deadlines.get(record.requestId) ?? now) <= now);
    const nextDeadline = Math.min(...[...deadlines.values()].filter((deadline) => deadline > now));
    if (Number.isFinite(nextDeadline)) this.scheduleIdleCheck(nextDeadline - now);
    if (batch.length) this.send(batch);
  }

  private send(batch: SubagentRecord[]): void {
    // Agents the user stopped report without starting a main-model turn.
    const triggerTurn = batch.some((record) => record.stoppedBy !== "user");
    this.pi.sendMessage(resultMessage(batch), { triggerTurn });
  }

  /** Stops delivery before shutdown aborts any agent, so nothing arrives late. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.idleCheck);
    this.idleCheck = undefined;
  }
}
