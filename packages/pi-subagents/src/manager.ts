import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  getAgentDir,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { isSubagentName, type SubagentDefinition } from "./agents.ts";
import type { SubagentsEventMap, SubagentStatus, SubagentThinking, SubagentTokens } from "./api.ts";
import {
  createSubagentRuntime,
  createSubagentSession,
  resolveSubagentPolicy,
  type SubagentOverrides,
  type SubagentPolicy,
  type SubagentSession,
} from "./session.ts";
import type { SubagentSettings } from "./settings.ts";

type AgentMessage = AgentSession["messages"][number];

/** Custom entry type that stores agent records in the main session (S7). */
export const SUBAGENT_RECORD_ENTRY = "subagents-record";

/** Whether the main model may still receive this run's result automatically (S5). */
export type SubagentReceipt = "pending" | "unread" | "consumed" | "delivered" | "suppressed";

/** One named agent and its latest run. Saved in the main session with `pi.appendEntry`. */
export interface SubagentRecord {
  sessionId: string;
  id: string;
  name: string;
  agentType: string;
  /** First line of the latest prompt, shown in the UI. */
  task: string;
  status: SubagentStatus;
  run: number;
  requestId: number;
  background: boolean;
  receipt: SubagentReceipt;
  stoppedBy?: "model" | "user";
  sessionFile?: string;
  model: string;
  thinking: SubagentThinking;
  maxTurns: number;
  tools: string[];
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  activity: string;
  turns: number;
  toolUses: number;
  tokens: SubagentTokens;
  contextPercent: number | null;
  partial: boolean;
  result: string;
  error?: string;
}

/** Statuses after which a run can no longer change. */
export function isSubagentFinished(status: SubagentStatus): boolean {
  return (
    status === "completed" ||
    status === "stopped" ||
    status === "failed" ||
    status === "interrupted"
  );
}

/** Parameters of one `Agent` call after schema validation. */
export interface SubagentLaunch extends SubagentOverrides {
  subagent_type?: string;
  name?: string;
  prompt: string;
  resume?: string;
  run_in_background?: boolean;
}

interface LiveRun {
  policy: SubagentPolicy;
  prompt: string;
  child?: SubagentSession;
  /** Messages the conversation held before this run, so its result comes only from this run. */
  firstMessage?: number;
  /** Corrections that arrived before the session existed. */
  pendingSteers: string[];
  /** Resolves a waiting foreground `Agent` call. */
  release?: (outcome: "finished" | "background") => void;
}

function emptyTokens(): SubagentTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

/**
 * The last answer of one run. `firstMessage` is the message count before the run's prompt, so a
 * continued run that writes nothing reports nothing, not the previous run's answer or error.
 */
function lastAssistantText(
  messages: readonly AgentMessage[],
  firstMessage: number,
): { text: string; error?: string } {
  for (let index = messages.length - 1; index >= firstMessage; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim();
    if (message.stopReason === "error")
      return { text, error: message.errorMessage ?? "The model request failed." };
    if (text) return { text };
  }
  return { text: "" };
}

function describeToolCall(name: string, args: unknown): string {
  const input = (args ?? {}) as Record<string, unknown>;
  const detail = [input.path, input.command, input.pattern, input.query].find(
    (value): value is string => typeof value === "string",
  );
  return detail ? `${name} ${detail.split("\n")[0]}` : name;
}

/** Owns every agent of one main session: names, queue, runs, persistence, and events (S1, S6, S7, S9). */
export class SubagentManager {
  readonly records = new Map<string, SubagentRecord>();
  private readonly live = new Map<string, LiveRun>();
  private readonly queue: string[] = [];
  private readonly listeners = new Set<() => void>();
  /** Last `subagents:activity` payload sent per agent, so unchanged updates are not repeated. */
  private readonly lastActivity = new Map<string, string>();
  private runtime: Promise<ModelRuntime> | undefined;
  private closed = false;
  /** Main-session request counter, advanced on `agent_start` (S5). */
  requestId = 0;
  /** Called once a run settles, so delivery can decide what the main model receives. */
  onRunSettled: (record: SubagentRecord) => void = () => {};

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    readonly sessionId: string,
    public definitions: Map<string, SubagentDefinition>,
    public settings: SubagentSettings,
  ) {}

  /** Agent types the model may start: loaded definitions minus `disabledAgents` (S9). */
  availableTypes(): SubagentDefinition[] {
    return [...this.definitions.values()].filter(
      (definition) => !this.settings.disabledAgents.includes(definition.name),
    );
  }

  /** Records in creation order, for the widget and `/agents`. */
  list(): SubagentRecord[] {
    return [...this.records.values()];
  }

  /** Finds an agent by the task name returned from `Agent`. */
  find(name: string): SubagentRecord | undefined {
    return this.list().find((record) => record.name === name);
  }

  /** Subscribes UI to record changes. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Restores this session's saved agents. Unfinished runs become interrupted and never deliver (S7). */
  restore(): void {
    for (const entry of this.ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== SUBAGENT_RECORD_ENTRY) continue;
      const record = entry.data as SubagentRecord | undefined;
      if (record?.sessionId !== this.sessionId) continue;
      this.records.set(record.id, { ...record });
    }
    for (const record of this.records.values()) {
      if (!isSubagentFinished(record.status)) {
        record.status = "interrupted";
        record.activity = "interrupted";
        record.endedAt ??= Date.now();
      }
      // Nothing arrives late after a reload or resume.
      if (record.receipt === "pending" || record.receipt === "unread")
        record.receipt = "suppressed";
    }
  }

  /** Starts a new named agent or continues a finished one (S1). Throws before reserving anything if invalid. */
  launch(params: SubagentLaunch): SubagentRecord {
    if (this.closed) throw new Error("Agents are shutting down.");
    const prompt = params.prompt.trim();
    if (!prompt) throw new Error("Agent needs a non-empty prompt.");
    const background = params.run_in_background ?? this.settings.backgroundByDefault;
    if (params.resume) return this.resume(params.resume, prompt, params, background);

    const type = params.subagent_type;
    const name = params.name;
    if (!type || !name)
      throw new Error(
        "A new agent needs subagent_type, name, and prompt. Use resume to continue one.",
      );
    if (!isSubagentName(name))
      throw new Error(`Task name "${name}" must be lowercase words joined by hyphens.`);
    if (this.find(name))
      throw new Error(`Task name "${name}" is already used in this session. Choose a new name.`);
    if (this.definitions.has(name))
      throw new Error(`Task name "${name}" is an agent type. Choose a different name.`);
    const definition = this.requireType(type);
    const policy = resolveSubagentPolicy({
      definition,
      overrides: params,
      ctx: this.ctx,
      pi: this.pi,
      settings: this.settings,
    });

    const record: SubagentRecord = {
      sessionId: this.sessionId,
      id: randomUUID(),
      name,
      agentType: definition.name,
      task: "",
      status: "queued",
      run: 0,
      requestId: this.requestId,
      background,
      receipt: "pending",
      model: "",
      thinking: policy.thinking,
      maxTurns: policy.maxTurns,
      tools: policy.tools,
      queuedAt: Date.now(),
      activity: "queued",
      turns: 0,
      toolUses: 0,
      tokens: emptyTokens(),
      contextPercent: null,
      partial: false,
      result: "",
    };
    this.records.set(record.id, record);
    this.emit("subagents:created", {
      ...this.identity(record),
      task: prompt.split("\n")[0] ?? "",
      background,
    });
    this.schedule(record, policy, prompt);
    return record;
  }

  private resume(
    name: string,
    prompt: string,
    overrides: SubagentOverrides,
    background: boolean,
  ): SubagentRecord {
    const record = this.find(name);
    if (!record) throw new Error(`No agent named "${name}" exists in this session.`);
    if (!isSubagentFinished(record.status)) {
      throw new Error(
        `Agent "${name}" is ${record.status}. Wait for it to finish, or use steer_subagent.`,
      );
    }
    // A run that just ended is still closing its session. A new run started now would be finished
    // by the old one: wrong status, no steering, and its result reported before it exists.
    if (this.live.has(record.id)) {
      throw new Error(`Agent "${name}" is still finishing its last run. Try again in a moment.`);
    }
    if (!record.sessionFile || !existsSync(record.sessionFile)) {
      throw new Error(`Agent "${name}" has no saved conversation to continue.`);
    }
    const definition = this.requireType(record.agentType);
    const policy = resolveSubagentPolicy({
      definition,
      overrides,
      ctx: this.ctx,
      pi: this.pi,
      settings: this.settings,
    });
    Object.assign(record, {
      status: "queued",
      requestId: this.requestId,
      background,
      receipt: "pending",
      stoppedBy: undefined,
      thinking: policy.thinking,
      maxTurns: policy.maxTurns,
      tools: policy.tools,
      queuedAt: Date.now(),
      // The previous run's result and times do not describe the run that is about to start.
      startedAt: undefined,
      endedAt: undefined,
      activity: "queued",
      partial: false,
      result: "",
      error: undefined,
    } satisfies Partial<SubagentRecord>);
    this.schedule(record, policy, prompt);
    return record;
  }

  private requireType(type: string): SubagentDefinition {
    const definition = this.definitions.get(type);
    if (!definition) {
      const known = this.availableTypes()
        .map((item) => item.name)
        .join(", ");
      throw new Error(`Agent type "${type}" is unavailable. Available types: ${known || "none"}.`);
    }
    if (this.settings.disabledAgents.includes(type))
      throw new Error(`Agent type "${type}" is disabled in settings.`);
    return definition;
  }

  private schedule(record: SubagentRecord, policy: SubagentPolicy, prompt: string): void {
    this.live.set(record.id, { policy, prompt, pendingSteers: [] });
    record.task = prompt.split("\n")[0] ?? "";
    this.persist(record);
    // Foreground calls bypass the background cap (S9).
    if (record.background && this.runningBackground() >= this.settings.maxConcurrent) {
      this.queue.push(record.id);
      this.notify();
      return;
    }
    void this.run(record);
  }

  private runningBackground(): number {
    return this.list().filter(
      (record) =>
        record.background && (record.status === "running" || record.status === "stopping"),
    ).length;
  }

  private pump(): void {
    while (
      !this.closed &&
      this.queue.length &&
      this.runningBackground() < this.settings.maxConcurrent
    ) {
      const id = this.queue.shift();
      const record = id ? this.records.get(id) : undefined;
      if (record?.status === "queued") void this.run(record);
    }
  }

  private async run(record: SubagentRecord): Promise<void> {
    const live = this.live.get(record.id);
    if (!live) return;
    Object.assign(record, {
      status: "running",
      run: record.run + 1,
      model: `${live.policy.model.provider}/${live.policy.model.id}`,
      startedAt: Date.now(),
      activity: "starting",
      turns: 0,
      toolUses: 0,
      tokens: emptyTokens(),
      contextPercent: null,
      result: "",
    } satisfies Partial<SubagentRecord>);
    this.persist(record);
    this.emit("subagents:started", {
      ...this.identity(record),
      run: record.run,
      model: record.model,
      thinking: record.thinking,
    });
    try {
      this.runtime ??= createSubagentRuntime(this.ctx);
      const child = await createSubagentSession({
        ctx: this.ctx,
        pi: this.pi,
        runtime: await this.runtime,
        policy: live.policy,
        sessionId: record.id,
        sessionDirectory: join(getAgentDir(), "subagents", this.sessionId),
        sessionFile: record.sessionFile,
        onEvent: (event) => this.track(record, live, event),
      });
      live.child = child;
      live.firstMessage = child.session.messages.length;
      // A reload, /new, or quit can arrive while the session is being created. shutdown() could not
      // dispose a session that did not exist yet, so the run ends here and `finally` disposes it (S7).
      if (this.closed) return;
      record.sessionFile = child.session.sessionManager.getSessionFile();
      if (record.status === "stopping") throw new Error("stopped");
      const steers = live.pendingSteers.splice(0);
      const prompt = steers.length ? `${live.prompt}\n\n${steers.join("\n\n")}` : live.prompt;
      await child.run(prompt);
      const { text, error } = lastAssistantText(child.session.messages, live.firstMessage);
      record.result = text;
      record.partial = child.partial;
      if (record.stoppedBy) record.status = "stopped";
      else if (error)
        Object.assign(record, { status: "failed", error } satisfies Partial<SubagentRecord>);
      else record.status = "completed";
    } catch (error) {
      // After shutdown the record is already saved as interrupted, and stays that way.
      if (this.closed) return;
      if (record.stoppedBy) record.status = "stopped";
      else
        Object.assign(record, {
          status: "failed",
          error: String(error),
        } satisfies Partial<SubagentRecord>);
      if (live.child && live.firstMessage !== undefined) {
        record.result ||= lastAssistantText(live.child.session.messages, live.firstMessage).text;
      }
    } finally {
      await live.child?.dispose().catch(() => undefined);
    }
    if (this.closed) return;
    this.finish(record, live);
  }

  private finish(record: SubagentRecord, live: LiveRun): void {
    record.endedAt = Date.now();
    record.activity = record.status;
    this.live.delete(record.id);
    // A waiting foreground call returns the result itself, so it counts as read (S5).
    const foreground = Boolean(live.release);
    if (foreground) record.receipt = "consumed";
    else if (record.stoppedBy === "model") record.receipt = "suppressed";
    else if (record.receipt === "pending") record.receipt = "unread";
    const outcome = {
      ...this.identity(record),
      run: record.run,
      status: record.status,
      result: record.result,
      partial: record.partial,
      tokens: record.tokens,
      toolUses: record.toolUses,
      durationMs: record.endedAt - (record.startedAt ?? record.endedAt),
    };
    if (record.status === "completed") this.emit("subagents:completed", outcome);
    else this.emit("subagents:failed", { ...outcome, error: record.error });
    live.release?.("finished");
    this.persist(record);
    if (!foreground) this.onRunSettled(record);
    this.pump();
  }

  private track(record: SubagentRecord, live: LiveRun, event: AgentSessionEvent): void {
    if (event.type === "turn_start") record.activity = "thinking";
    else if (event.type === "message_update" && event.message.role === "assistant")
      record.activity = "writing";
    else if (event.type === "tool_execution_start") {
      record.toolUses++;
      record.activity = describeToolCall(event.toolName, event.args);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = event.message.usage;
      // The turn limit stops an extra turn before it says anything. That turn does not count.
      const stoppedBeforeOutput =
        event.message.stopReason === "aborted" && event.message.content.length === 0;
      if (!stoppedBeforeOutput) record.turns++;
      record.tokens = {
        input: record.tokens.input + usage.input,
        output: record.tokens.output + usage.output,
        cacheRead: record.tokens.cacheRead + usage.cacheRead,
        cacheWrite: record.tokens.cacheWrite + usage.cacheWrite,
        total: record.tokens.total + usage.input + usage.output + usage.cacheWrite,
      };
      record.contextPercent =
        live.child?.session.getContextUsage()?.percent ?? record.contextPercent;
      this.emit("subagents:usage", { ...this.identity(record), usage });
    } else return;
    const activity = {
      activity: record.activity,
      turns: record.turns,
      toolUses: record.toolUses,
      contextPercent: record.contextPercent,
    };
    // Streaming updates every few characters. Observers only hear about real changes.
    const signature = JSON.stringify(activity);
    if (this.lastActivity.get(record.id) !== signature) {
      this.lastActivity.set(record.id, signature);
      this.emit("subagents:activity", { ...this.identity(record), ...activity });
    }
    this.notify();
  }

  /** Waits for a foreground run. Resolves early when Ctrl+B moves it to the background (S6). */
  waitForeground(
    record: SubagentRecord,
    signal: AbortSignal | undefined,
  ): Promise<"finished" | "background" | "aborted"> {
    const live = this.live.get(record.id);
    if (!live || isSubagentFinished(record.status)) return Promise.resolve("finished");
    return new Promise((resolvePromise) => {
      const onAbort = () => {
        live.release = undefined;
        // The aborted tool call already tells the model, so nothing arrives later.
        record.receipt = "suppressed";
        // Esc in the main session stops the agents it waits for (S6).
        void this.stop(record.name, "user");
        resolvePromise("aborted");
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      live.release = (outcome) => {
        signal?.removeEventListener("abort", onAbort);
        live.release = undefined;
        resolvePromise(outcome);
      };
    });
  }

  /** Whether a foreground agent is running, for Ctrl+B and the hint (S6). */
  hasForeground(): boolean {
    return this.list().some((record) => !record.background && record.status === "running");
  }

  /** Moves every running foreground agent to the background without stopping it (S6). */
  moveForegroundToBackground(): number {
    let moved = 0;
    for (const record of this.list()) {
      if (record.background || record.status !== "running") continue;
      record.background = true;
      this.persist(record);
      this.live.get(record.id)?.release?.("background");
      moved++;
    }
    this.notify();
    return moved;
  }

  /** Sends a correction from the main model to a running or queued agent (S6). */
  async steer(name: string, message: string): Promise<SubagentRecord> {
    const record = this.find(name);
    if (!record) throw new Error(`No agent named "${name}" exists in this session.`);
    const live = this.live.get(record.id);
    if (!live || isSubagentFinished(record.status) || record.status === "stopping") {
      throw new Error(`Agent "${name}" is ${record.status}. Use Agent with resume to continue it.`);
    }
    if (live.child) await live.child.session.steer(message, undefined, { source: "extension" });
    else live.pendingSteers.push(message);
    this.emit("subagents:steered", { ...this.identity(record), message });
    return record;
  }

  /** Stops one running or queued agent. Other agents are unaffected (S6). */
  async stop(name: string, by: "model" | "user"): Promise<SubagentRecord> {
    const record = this.find(name);
    if (!record) throw new Error(`No agent named "${name}" exists in this session.`);
    // The first stop decides who stopped it. A later stop from the model must not hide the report
    // of an agent the user stopped (S5).
    if (isSubagentFinished(record.status) || record.status === "stopping") return record;
    record.stoppedBy = by;
    const live = this.live.get(record.id);
    if (record.status === "queued") {
      const position = this.queue.indexOf(record.id);
      if (position >= 0) this.queue.splice(position, 1);
      record.status = "stopped";
      if (live) this.finish(record, live);
      return record;
    }
    record.status = "stopping";
    record.activity = "stopping";
    this.notify();
    await live?.child?.session.abort();
    return record;
  }

  /** Marks a result as returned to the model, so it is never delivered again (S5). */
  markReceipt(record: SubagentRecord, receipt: SubagentReceipt): void {
    record.receipt = receipt;
    this.persist(record);
  }

  /** Transcript for `/agents`: the live session, or the saved session file. */
  transcript(record: SubagentRecord): readonly AgentMessage[] {
    const child = this.live.get(record.id)?.child;
    if (child) return child.session.messages;
    if (!record.sessionFile) return [];
    try {
      return SessionManager.open(record.sessionFile).buildSessionContext().messages;
    } catch {
      return [];
    }
  }

  /** Tool definitions of a live agent, so `/agents` draws its calls the way Pi does. */
  toolDefinition(record: SubagentRecord, toolName: string) {
    return this.live.get(record.id)?.child?.session.getToolDefinition(toolName);
  }

  /** Marks unfinished work interrupted, stops it, and emits `subagents:disposed` last (S7, S9). */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    const running: Promise<void>[] = [];
    for (const record of this.list()) {
      if (isSubagentFinished(record.status)) continue;
      Object.assign(record, {
        status: "interrupted",
        activity: "interrupted",
        receipt: "suppressed",
        endedAt: Date.now(),
      } satisfies Partial<SubagentRecord>);
      this.persist(record);
      const live = this.live.get(record.id);
      live?.release?.("finished");
      if (live?.child) running.push(live.child.dispose());
    }
    await Promise.allSettled(running);
    this.live.clear();
    this.listeners.clear();
    this.emit("subagents:disposed", { sessionId: this.sessionId });
  }

  private identity(record: SubagentRecord) {
    return {
      sessionId: this.sessionId,
      id: record.id,
      name: record.name,
      agentType: record.agentType,
    };
  }

  private emit<TName extends keyof SubagentsEventMap>(
    name: TName,
    payload: SubagentsEventMap[TName],
  ): void {
    this.pi.events.emit(name, payload);
  }

  private persist(record: SubagentRecord): void {
    this.pi.appendEntry(SUBAGENT_RECORD_ENTRY, { ...record });
    this.notify();
  }

  /** Tells UI listeners that a record changed. */
  notify(): void {
    for (const listener of this.listeners) listener();
  }
}
