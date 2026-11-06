import { join } from "node:path";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { emit, subject } from "./events.ts";
import type { AgentManager } from "./manager.ts";
import { openSession, type SessionDriver } from "./sessions.ts";
import { readTranscript, writeAttempt } from "./storage.ts";
import { createAgentTools, type SpawnRequest } from "./tools.ts";
import { TranscriptProjection, toolActivity } from "./transcript.ts";
import { addUsage, emptyUsage, isSettled, type AgentView, type Usage } from "./types.ts";

export class Attempt {
  instructions?: string;
  readonly controller = new AbortController();
  driver?: SessionDriver;
  readonly done: Promise<AgentView>;
  resolve!: (view: AgentView) => void;
  finalizing?: Promise<void>;
  consumed = false;
  permit?: string;
  readonly children = new Set<string>();
  readonly waitingChildren = new Set<string>();
  readonly childUsage = emptyUsage();
  ownUsage = emptyUsage();
  readonly baselineLifetime: Readonly<Usage>;
  readonly projection = new TranscriptProjection();
  cleanupSafe = true;
  writeTail: Promise<void> = Promise.resolve();
  readonly request: SpawnRequest;

  constructor(
    readonly manager: AgentManager,
    public view: AgentView,
    request: SpawnRequest,
  ) {
    this.request = structuredClone(request);
    this.baselineLifetime = view.lifetimeUsage;
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  publish(patch: Partial<AgentView>): void {
    this.view = { ...this.view, ...patch };
    this.manager.changed();
  }

  async run(): Promise<void> {
    const manager = this.manager;
    const signal = this.controller.signal;
    const timeout = setTimeout(() => {
      if (this.view.state === "starting")
        this.controller.abort(new Error("Session startup exceeded 60 seconds."));
    }, 60_000);
    let failure: unknown;
    try {
      const parent = this.view.owner.attemptId
        ? manager.attempts.get(this.view.owner.attemptId)
        : undefined;
      const owner = { id: this.view.id, attemptId: this.view.attemptId };
      const customTools =
        this.view.definition.allowedSubagents.length &&
        this.view.depth < manager.catalog.settings.maxDepth
          ? [...createAgentTools(manager, owner, false)]
          : [];
      const driver = await manager.interruptible(
        openSession(
          {
            pi: manager.pi,
            ctx: manager.context,
            catalog: manager.catalog,
            request: this.request,
            definition: this.view.definition,
            signal,
            sessionDirectory: join(manager.directory, "sessions", this.view.attemptId),
            sessionFile: this.view.sessionFile,
            instructions: this.instructions,
            parentSession: parent?.driver?.session,
            customTools,
          },
          {
            created: (created) => {
              this.driver = created;
              this.instructions = created.instructions;
              this.publish({
                sessionFile: created.sessionFile,
                model: created.model,
                thinking: created.thinking,
              });
              this.progress();
            },

            event: (event) => this.project(event),
            boundary: (state, ctx) => manager.onBoundary?.(owner, state, ctx),

            usage: (usage) => this.updateUsage(usage),
          },
        ),
        signal,
      );
      clearTimeout(timeout);
      signal.throwIfAborted();
      this.driver = driver;
      this.instructions = driver.instructions;
      this.publish({
        state: "running",
        activity: "Working",
        sessionFile: driver.sessionFile,
        model: driver.model,
        thinking: driver.thinking,
      });
      emit(manager.pi, "subagents:started", subject(this.view));
      this.progress();
      const result = await manager.interruptible(driver.run(), signal);
      this.publish({ result });
    } catch (error) {
      if (signal.aborted && !this.driver) this.cleanupSafe = false;
      failure = signal.reason ?? error;
    } finally {
      clearTimeout(timeout);
      await this.finalize(failure);
    }
  }

  private updateUsage(own: Usage): void {
    if (isSettled(this.view.state)) return;
    this.ownUsage = { ...own };
    const usage = { ...own };
    addUsage(usage, this.childUsage);
    const lifetime = { ...this.baselineLifetime };
    addUsage(lifetime, usage);
    this.publish({ usage, lifetimeUsage: lifetime });
  }

  private project(event: AgentSessionEvent): void {
    if (isSettled(this.view.state)) return;
    if (event.type === "turn_start" && !this.controller.signal.aborted)
      this.publish({ turns: this.view.turns + 1, activity: "Thinking" });
    if (event.type === "tool_execution_start" && !this.controller.signal.aborted)
      this.publish({
        toolCalls: this.view.toolCalls + 1,
        activity: toolActivity(event.toolName, event.args),
      });
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta" &&
      !this.controller.signal.aborted
    )
      this.publish({ activity: "Responding" });
    const update = this.projection.apply(event);
    if (update)
      this.publish({
        transcript: update.rows,
        ...(update.result ? { result: update.result } : {}),
      });
  }

  async finalize(failure?: unknown): Promise<void> {
    const manager = this.manager;
    if (this.finalizing) return this.finalizing;
    if (isSettled(this.view.state)) return;
    this.finalizing = (async () => {
      manager.pending.delete(this);
      this.publish({ state: "settling", activity: "Finishing and saving results" });
      for (const childId of this.children) {
        const child = manager.attempts.get(childId);
        if (child && !isSettled(child.view.state)) {
          child.controller.abort(
            new Error("Parent attempt finished; unfinished children are cancelled."),
          );
          if (child.view.state === "queued") await child.finalize(child.controller.signal.reason);
          await child.done;
        }
      }
      if (this.driver) {
        try {
          await deadline(this.driver.dispose(), 5000);
        } catch (error) {
          this.cleanupSafe = false;
          failure ??= new Error(`Session cleanup could not be confirmed: ${String(error)}`);
        }
        this.publish({ sessionFile: this.driver.sessionFile });
      }
      if (this.controller.signal.aborted) failure ??= this.controller.signal.reason;
      let outcome: AgentView["state"] = this.controller.signal.aborted
        ? "cancelled"
        : failure
          ? "failed"
          : "completed";
      // oxlint-disable-next-line typescript/no-base-to-string -- Thrown values may be arbitrary objects; retain their standard string representation.
      let error = failure === undefined ? undefined : String(failure);
      const finishedAt = Date.now();
      this.publish({
        resumeBlocked: this.cleanupSafe
          ? undefined
          : "Cleanup was not confirmed. Start a fresh session explicitly.",
      });
      try {
        await this.persist(outcome, error, finishedAt);
      } catch (saveError) {
        outcome = "failed";
        error = `Result remains available, but saving failed: ${String(saveError)}`;
        this.cleanupSafe = false;
      }
      this.publish({ state: outcome, error, finishedAt, activity: outcome });
      this.permit = undefined;
      manager.active.delete(this);
      const parent = this.view.owner.attemptId
        ? manager.attempts.get(this.view.owner.attemptId)
        : undefined;
      if (parent && !isSettled(parent.view.state)) {
        addUsage(parent.childUsage, this.view.usage);
        parent.updateUsage(parent.ownUsage);
      }
      this.resolve(this.view);
      const view = this.view;
      manager.observe(() =>
        outcome === "completed"
          ? emit(manager.pi, "subagents:completed", {
              ...subject(view),
              state: "completed",
              result: view.result,
            })
          : emit(manager.pi, "subagents:failed", {
              ...subject(view),
              state: outcome === "cancelled" ? "cancelled" : "failed",
              result: view.result,
              error,
            }),
      );
      manager.observe(() =>
        emit(manager.pi, "subagents:usage", { ...subject(view), usage: { ...view.usage } }),
      );
      // `finalizing` guarantees this body runs once, so completion is reported once.
      manager.observe(() => manager.onComplete?.(view));
      manager.pump();
    })();
    return this.finalizing;
  }

  /** Save the record. Writes are serialized, so an older state never replaces a newer one. */
  async persist(
    state: AgentView["state"],
    error?: string,
    finishedAt?: number,
    includeTranscript = true,
  ): Promise<void> {
    const transcript = includeTranscript ? this.view.transcript : undefined;
    const write = this.writeTail.then(() =>
      writeAttempt(this, state, error, finishedAt, transcript),
    );
    this.writeTail = write.catch(() => {});
    await write;
  }

  private progress(): void {
    const manager = this.manager;
    void this.persist(this.view.state).catch((error: unknown) =>
      manager.warn(`Could not save progress: ${String(error)}`),
    );
  }

  saveReceipt(): void {
    const manager = this.manager;
    void this.persist(this.view.state, this.view.error, this.view.finishedAt, false).catch(
      (error: unknown) => manager.warn(`Could not save delivery receipt: ${String(error)}`),
    );
  }

  async loadTranscript(): Promise<void> {
    if (this.view.transcriptLoaded) return;
    const rows = await readTranscript(this.view);
    this.projection.restore(rows);
    this.publish({ transcript: rows, transcriptLoaded: true });
  }
}

async function deadline(promise: Promise<void>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Cleanup timed out.")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
