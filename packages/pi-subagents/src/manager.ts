import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import { Attempt } from "./attempts.ts";
import type { Catalog } from "./catalog.ts";
import { record, withStateLock } from "./io.ts";
import { childSessionContext } from "./sessions.ts";
import {
  emptyUsage,
  matches,
  rejectWorktree,
  spawnParameters,
  type AgentService,
  type SpawnRequest,
  type Usage,
} from "./tools.ts";
import { immutable as freeze, isSettled, taskTitle, type AgentView } from "./transcript.ts";

export type AttemptState =
  | "queued"
  | "starting"
  | "running"
  | "settling"
  | "completed"
  | "failed"
  | "cancelled";

export interface Owner {
  readonly id: string;
  readonly attemptId?: string;
}

interface Agent {
  id: string;
  attempts: Attempt[];
}

export class AgentManager implements AgentService {
  readonly root: Owner;
  readonly directory: string;
  private agents = new Map<string, Agent>();
  readonly attempts = new Map<string, Attempt>();
  private listeners = new Set<() => void>();
  private tasks = new Set<Promise<void>>();
  readonly pending = new Set<Attempt>();
  readonly active = new Set<Attempt>();
  private capacity = "";
  private closing = false;
  private pumping = false;
  private changedPending = false;
  onComplete?: (view: AgentView) => void;

  constructor(
    readonly pi: ExtensionAPI,
    public context: ExtensionContext,
    readonly catalog: Catalog,
  ) {
    this.root = freeze({ id: context.sessionManager.getSessionId() });
    this.directory = join(getAgentDir(), "subagents", this.root.id, "v1");
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  changed(): void {
    if (this.changedPending) return;
    this.changedPending = true;
    queueMicrotask(() => {
      this.changedPending = false;
      for (const listener of this.listeners) this.observe(listener);
      const settings = this.catalog.settings;
      const capacity = `${settings.maxConcurrent}:${settings.maxConcurrentForeground}:${settings.maxConcurrentNestedPerDepth}`;
      if (capacity !== this.capacity) {
        this.capacity = capacity;
        this.pump();
      }
    });
  }

  observe(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      console.error(`[pi-subagents] Observer failed: ${String(error)}`);
    }
  }

  list(): readonly AgentView[] {
    return Object.freeze(
      [...this.agents.values()].flatMap((agent) => agent.attempts.at(-1)?.view ?? []),
    );
  }

  get(id: string, owner?: Owner): AgentView {
    const candidates = this.list().filter(
      (view) =>
        (!owner || (view.owner.id === owner.id && view.owner.attemptId === owner.attemptId)) &&
        (view.id === id || view.name.toLowerCase() === id.replace(/^@/, "").toLowerCase()),
    );
    if (candidates.length !== 1 || !candidates[0])
      throw new Error(`Agent '${id}' is unknown or ambiguous for this caller.`);
    return candidates[0];
  }

  attempt(id: string, attemptId: string): AgentView | undefined {
    const attempt = this.attempts.get(attemptId);
    return attempt?.view.id === id ? attempt.view : undefined;
  }

  history(id: string): readonly AgentView[] {
    return Object.freeze((this.agents.get(id)?.attempts ?? []).map((attempt) => attempt.view));
  }

  private entry(id: string, attemptId?: string, owner?: Owner): Attempt {
    const view = this.get(id, owner);
    const attempt = this.attempts.get(attemptId ?? view.attemptId);
    if (
      !attempt ||
      attempt.view.id !== view.id ||
      (owner &&
        (attempt.view.owner.id !== owner.id || attempt.view.owner.attemptId !== owner.attemptId))
    )
      throw new Error("That attempt is unavailable to this caller.");
    return attempt;
  }

  private authorize(owner: Owner): Attempt | undefined {
    if (owner.id === this.root.id && owner.attemptId === undefined) return undefined;
    const parent = owner.attemptId ? this.attempts.get(owner.attemptId) : undefined;
    if (
      !parent ||
      parent.view.id !== owner.id ||
      parent.view.state !== "running" ||
      parent.controller.signal.aborted
    )
      throw new Error("The owning parent attempt is no longer running.");
    return parent;
  }

  async spawn(
    input: SpawnRequest,
    owner: Owner = this.root,
    restart = false,
    prepareMention = false,
  ): Promise<AgentView> {
    rejectWorktree(input);
    if (this.closing) throw new Error("Subagents are shutting down.");
    if (input.schedule) throw new Error("Scheduling is not supported. No job was created.");
    if (
      !Value.Check(spawnParameters, input) ||
      !input.prompt.trim() ||
      input.prompt.length > 2_000_000
    )
      throw new Error("A valid, nonempty agent request is required (maximum 2 MB).");
    if (input.cwd && !isAbsolute(input.cwd)) throw new Error("Agent cwd must be absolute.");
    await this.catalog.reload();
    if (this.closing) throw new Error("Subagents are shutting down.");
    const parent = this.authorize(owner);
    const depth = (parent?.view.depth ?? 0) + 1;
    if (depth > this.catalog.settings.maxDepth)
      throw new Error("Nested delegation depth limit reached.");
    const previous = input.resume ? this.entry(input.resume, undefined, owner) : undefined;
    if (previous && !isSettled(previous.view.state))
      throw new Error("The previous attempt is still running or settling.");
    if (previous && !restart && (!previous.cleanupSafe || !previous.view.sessionFile))
      throw new Error(
        "This saved run cannot be resumed safely. Its results remain readable; start a new agent explicitly.",
      );
    const type = previous?.view.agentType ?? input.subagent_type ?? "general-purpose";
    const current = this.catalog
      .definitions()
      .find((definition) => definition.name.toLowerCase() === type.toLowerCase());
    if (previous && (!current || !current.enabled))
      throw new Error(
        "The original agent definition is unavailable or disabled. History is readable, but Resume is blocked.",
      );
    const definition = previous && !restart ? previous.view.definition : this.catalog.resolve(type);
    if (definition.source === "project" && !this.context.isProjectTrusted())
      throw new Error("This agent requires project trust.");
    if (parent && !matches(definition.name, parent.view.definition.allowedSubagents))
      throw new Error(`Parent '${parent.view.name}' cannot delegate to '${definition.name}'.`);
    const id = previous?.view.id ?? randomUUID();
    let name = previous?.view.name ?? input.name ?? definition.name.toLowerCase();
    if (!previous && !input.name) {
      let suffix = 2;
      const base = name;
      while (
        this.list().some(
          (view) => view.owner.id === owner.id && view.name.toLowerCase() === name.toLowerCase(),
        )
      )
        name = `${base}-${suffix++}`;
    }
    if (
      !previous &&
      input.name &&
      this.list().some(
        (view) => view.owner.id === owner.id && view.name.toLowerCase() === name.toLowerCase(),
      )
    )
      throw new Error("That handle exists. Resume it or choose a new name.");
    const saved = restart ? undefined : previous;
    const request = structuredClone({
      ...input,
      name,
      subagent_type: definition.name,
      model: input.model ?? saved?.view.model,
      thinking: input.thinking ?? saved?.view.thinking,
      max_turns:
        input.max_turns ??
        saved?.request.max_turns ??
        definition.maxTurns ??
        this.catalog.settings.maxTurns,
      isolated: input.isolated ?? saved?.request.isolated,
      cwd: input.cwd ?? saved?.request.cwd,
      schema: input.schema ?? saved?.request.schema,
    });
    const attemptId = randomUUID();
    const view: AgentView = freeze({
      id,
      attemptId,
      attemptNumber: (this.agents.get(id)?.attempts.length ?? 0) + 1,
      owner: { ...owner },
      depth,
      name,
      agentType: definition.name,
      displayName: definition.displayName ?? definition.name,
      task: taskTitle({
        task: input.description?.trim() || input.prompt.split("\n")[0] || definition.description,
      }),
      prompt: input.prompt,
      state: "queued",
      activity: "Waiting for capacity",
      background: input.run_in_background ?? !parent,
      createdAt: Date.now(),
      result: "",
      usage: emptyUsage(),
      lifetimeUsage: previous?.view.lifetimeUsage ?? emptyUsage(),
      turns: 0,
      toolCalls: 0,
      outputFile: join(this.directory, "attempts", `${attemptId}.json`),
      sessionFile: previous && !restart ? previous.view.sessionFile : undefined,
      definition,
      transcript: [],
      transcriptLoaded: true,
    });
    const attempt = new Attempt(this, view, request);
    attempt.instructions = previous && !restart ? previous.instructions : undefined;
    attempt.prepareMention = prepareMention;
    const agent = this.agents.get(id) ?? { id, attempts: [] };
    agent.attempts.push(attempt);
    this.agents.set(id, agent);
    this.attempts.set(attemptId, attempt);
    parent?.children.add(attemptId);
    this.pi.events.emit("subagents:created", { id, attemptId, parentId: owner.id });
    this.changed();
    try {
      await attempt.persist("queued");
      if (attempt.view.state === "queued" && !this.closing) this.pending.add(attempt);
      this.pump();
    } catch (error) {
      await attempt.finalize(error);
    }
    return attempt.view;
  }

  private pool(attempt: Attempt): string {
    return attempt.view.depth > 1
      ? `nested:${attempt.view.depth}`
      : attempt.view.background
        ? "background"
        : "foreground";
  }

  private room(attempt: Attempt): boolean {
    const pool = this.pool(attempt);
    const limit =
      pool === "background"
        ? this.catalog.settings.maxConcurrent
        : pool === "foreground"
          ? this.catalog.settings.maxConcurrentForeground
          : this.catalog.settings.maxConcurrentNestedPerDepth;
    return limit === 0 || [...this.active].filter((item) => item.permit === pool).length < limit;
  }

  pump(): void {
    if (this.pumping || this.closing) return;
    this.pumping = true;
    try {
      for (const attempt of this.pending) {
        if (attempt.view.state !== "queued" || attempt.finalizing || !this.room(attempt)) continue;
        this.pending.delete(attempt);
        attempt.permit = this.pool(attempt);
        this.active.add(attempt);
        attempt.publish({
          state: "starting",
          activity: "Starting session",
          startedAt: Date.now(),
        });
        const task = withStateLock(join(this.directory, "agents", attempt.view.id), () =>
          attempt.run(),
        )
          .catch((error: unknown) => attempt.finalize(error))
          .finally(() => {
            this.tasks.delete(task);
            this.pump();
          });
        this.tasks.add(task);
      }
    } finally {
      this.pumping = false;
    }
  }

  async wait(id: string, attemptId: string, signal?: AbortSignal): Promise<AgentView> {
    const attempt = this.entry(id, attemptId);
    return this.interruptible(attempt.done, signal);
  }

  async interruptible<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let rejectAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () =>
        reject(signal?.reason ?? new Error("Stopped waiting; the child continues."));
      signal?.addEventListener("abort", rejectAbort, { once: true });
    });
    try {
      return await Promise.race([promise, cancelled]);
    } finally {
      signal?.removeEventListener("abort", rejectAbort);
    }
  }

  async stop(id: string, owner?: Owner, attemptId?: string): Promise<void> {
    const attempt = this.entry(id, attemptId, owner);
    if (isSettled(attempt.view.state) || attempt.view.state === "settling") {
      await attempt.done;
      return;
    }
    attempt.publish({ activity: "Stopping" });
    attempt.controller.abort(
      new Error("Agent explicitly stopped. Do not restart it automatically."),
    );
    if (attempt.view.state === "queued") await attempt.finalize(attempt.controller.signal.reason);
    await attempt.done;
  }

  async steer(id: string, message: string, owner?: Owner, attemptId?: string): Promise<void> {
    const attempt = this.entry(id, attemptId, owner);
    if (attempt.view.state !== "running" || !attempt.driver)
      throw new Error("This attempt is not running.");
    await attempt.driver.steer(message);
    this.pi.events.emit("subagents:steered", {
      id: attempt.view.id,
      attemptId: attempt.view.attemptId,
    });
  }

  handoff(id: string, attemptId: string): boolean {
    const attempt = this.entry(id, attemptId);
    if (attempt.view.state !== "running" || attempt.view.background) return false;
    if (attempt.view.depth === 1) attempt.permit = "background";
    attempt.publish({ background: true });
    this.pump();
    return true;
  }

  consume(id: string, attemptId: string, owner?: Owner): Usage | undefined {
    const attempt = this.entry(id, attemptId, owner);
    if (!isSettled(attempt.view.state))
      throw new Error("A running or settling attempt has no final result.");
    if (!attempt.consumed) {
      attempt.consumed = true;
      attempt.saveReceipt();
    }
    if (attempt.usageReported || (owner && owner.id !== this.root.id)) return undefined;
    const recorded = this.context.sessionManager.getEntries().some((entry) => {
      if (entry.type !== "message" || entry.message.role !== "toolResult") return false;
      const details: unknown = entry.message.details;
      return (
        record(details) && details.attemptId === attemptId && entry.message.usage !== undefined
      );
    });
    if (recorded) {
      attempt.usageReported = true;
      return undefined;
    }
    attempt.usageReported = true;
    return { ...attempt.view.usage };
  }

  waiting(owner: Owner, attemptId: string, active: boolean): void {
    const parent = owner.attemptId ? this.attempts.get(owner.attemptId) : undefined;
    if (!parent || parent.view.id !== owner.id || isSettled(parent.view.state)) return;
    if (active) parent.waitingChildren.add(attemptId);
    else parent.waitingChildren.delete(attemptId);
    if (parent.controller.signal.aborted) return;
    parent.publish({
      activity: parent.waitingChildren.size
        ? `Waiting for child (${parent.waitingChildren.size})`
        : "Working",
    });
  }

  async notifyOwner(view: AgentView): Promise<void> {
    const parent = view.owner.attemptId ? this.attempts.get(view.owner.attemptId) : undefined;
    if (parent?.view.state !== "running" || !parent.driver || this.closing) return;
    const session = parent.driver.session;
    await childSessionContext.run(true, () =>
      session.sendCustomMessage(
        {
          customType: "subagent-completion",
          content: `${view.displayName} · ${view.task} · ${view.state}\n${view.result || view.error || view.activity}\nAgent: ${view.id}\nRecord: ${view.outputFile}`,
          display: true,
          details: { id: view.id, attemptId: view.attemptId },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      ),
    );
  }

  delivered(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (attempt && !attempt.consumed) {
      attempt.consumed = true;
      attempt.saveReceipt();
    }
  }

  undelivered(): readonly AgentView[] {
    return [...this.attempts.values()]
      .map((attempt) => attempt.view)
      .filter(
        (view) =>
          view.background &&
          view.owner.id === this.root.id &&
          !view.owner.attemptId &&
          isSettled(view.state) &&
          !this.isConsumed(view.attemptId),
      );
  }

  deliveryMode(attemptId: string): "individual" | "group" {
    return this.attempts.get(attemptId)?.request.join ?? "individual";
  }

  joinedPending(): boolean {
    return [...this.attempts.values()].some(
      (attempt) =>
        attempt.view.owner.id === this.root.id &&
        attempt.request.join === "group" &&
        !isSettled(attempt.view.state),
    );
  }

  isConsumed(attemptId: string): boolean {
    return this.attempts.get(attemptId)?.consumed ?? true;
  }

  async loadTranscript(id: string, attemptId: string): Promise<void> {
    await this.entry(id, attemptId).loadTranscript();
  }

  async mention(name: string, prompt: string): Promise<AgentView> {
    const matches = this.list().filter(
      (view) =>
        view.owner.id === this.root.id &&
        (view.id === name || view.name.toLowerCase() === name.toLowerCase()),
    );
    if (matches.length > 1) throw new Error("Use the agent ID to resolve this ambiguous mention.");
    const prior = matches[0];
    if (prior) {
      if (!isSettled(prior.state)) {
        await this.steer(prior.id, prompt, this.root, prior.attemptId);
        return this.get(prior.id);
      }
      return this.spawn({ prompt, resume: prior.id });
    }
    return this.spawn(
      { prompt, subagent_type: name },
      this.root,
      false,
      this.catalog.settings.mentionMode === "clone",
    );
  }

  insertRestored(attempt: Attempt): void {
    const agent = this.agents.get(attempt.view.id) ?? { id: attempt.view.id, attempts: [] };
    agent.attempts.push(attempt);
    agent.attempts = agent.attempts.toSorted(
      (a, b) => a.view.attemptNumber - b.view.attemptNumber || a.view.createdAt - b.view.createdAt,
    );
    this.agents.set(agent.id, agent);
    this.attempts.set(attempt.view.attemptId, attempt);
  }

  warn(message: string): void {
    this.observe(() => {
      if (this.context.hasUI) this.context.ui.notify(message, "warning");
      else console.error(`[pi-subagents] ${message}`);
    });
  }

  async dispose(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await Promise.allSettled(
      this.list()
        .filter((view) => !isSettled(view.state))
        .map((view) => this.stop(view.id, undefined, view.attemptId)),
    );
    await Promise.allSettled(this.tasks);
    await Promise.allSettled([...this.attempts.values()].map((attempt) => attempt.writeTail));
    this.listeners.clear();
  }
}
