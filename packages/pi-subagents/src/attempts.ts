import { mkdir, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { defineTool, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { parseAgent, serializeAgent } from "./agents.ts";
import { atomicWrite, contained, isMissing, readText } from "./io.ts";
import type { AgentManager } from "./manager.ts";
import { openSession, type SessionDriver } from "./sessions.ts";
import {
  addUsage,
  createAgentTools,
  emptyUsage,
  spawnParameters,
  thinkingSchema,
  usageSchema,
  type SpawnRequest,
  type Usage,
} from "./tools.ts";
import {
  decodeTranscript,
  immutable as freeze,
  isSettled,
  TranscriptProjection,
  taskTitle,
  toolActivity,
  type AgentView,
} from "./transcript.ts";

const savedSchema = Type.Object({
  version: Type.Literal(1),
  id: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
  attemptId: Type.String({ pattern: "^[a-f0-9-]{36}$" }),
  attemptNumber: Type.Integer({ minimum: 1 }),
  name: Type.String(),
  owner: Type.Object({ id: Type.String(), attemptId: Type.Optional(Type.String()) }),
  depth: Type.Integer({ minimum: 1 }),
  request: spawnParameters,
  definition: Type.String(),
  instructions: Type.Optional(Type.String()),
  source: Type.Union([
    Type.Literal("builtin"),
    Type.Literal("project"),
    Type.Literal("user"),
    Type.Literal("package"),
  ]),
  state: Type.String(),
  activity: Type.String(),
  createdAt: Type.Number(),
  startedAt: Type.Optional(Type.Number()),
  finishedAt: Type.Optional(Type.Number()),
  result: Type.String(),
  error: Type.Optional(Type.String()),
  background: Type.Boolean(),
  usage: usageSchema,
  lifetimeUsage: usageSchema,
  turns: Type.Number(),
  toolCalls: Type.Number(),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(thinkingSchema),
  sessionFile: Type.Optional(Type.String()),
  outputFile: Type.String(),
  cleanupSafe: Type.Boolean(),
  delivery: Type.Union([Type.Literal("inline"), Type.Literal("pending"), Type.Literal("consumed")]),
});

const attemptReference = Type.Object({ attemptId: Type.String() });
const completionReceipt = Type.Object({ agents: Type.Array(attemptReference) });
const collectionReceipt = Type.Object({
  attemptId: Type.String(),
  snapshot: Type.Object({
    state: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
  }),
});

export class Attempt {
  instructions?: string;
  readonly controller = new AbortController();
  driver?: SessionDriver;
  readonly done: Promise<AgentView>;
  resolve!: (view: AgentView) => void;
  finalizing?: Promise<void>;
  notified = false;
  consumed = false;
  usageReported = false;
  permit?: string;
  readonly children = new Set<string>();
  readonly waitingChildren = new Set<string>();
  readonly childUsage = emptyUsage();
  ownUsage = emptyUsage();
  readonly baselineLifetime: Readonly<Usage>;
  preparationUsage = emptyUsage();
  prepareMention = false;
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
    this.view = freeze({ ...this.view, ...patch });
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
      const prompt = this.prepareMention ? await this.prepareTask() : this.request.prompt;
      signal.throwIfAborted();
      const driver = await manager.interruptible(
        openSession(
          {
            pi: manager.pi,
            ctx: manager.context,
            catalog: manager.catalog,
            request: { ...this.request, prompt },
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

            usage: (usage) => {
              const own = { ...usage };
              addUsage(own, this.preparationUsage);
              this.updateUsage(own);
            },
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
      manager.pi.events.emit("subagents:started", {
        id: this.view.id,
        attemptId: this.view.attemptId,
      });
      this.progress();
      const response = await manager.interruptible(driver.run(), signal);
      this.publish({ result: response.text });
    } catch (error) {
      if (signal.aborted && !this.driver) this.cleanupSafe = false;
      failure = signal.reason ?? error;
    } finally {
      clearTimeout(timeout);
      await this.finalize(failure);
    }
  }

  private async prepareTask(): Promise<string> {
    const manager = this.manager;
    this.publish({ activity: "Preparing task from conversation" });
    let prompt: string | undefined;
    const route = defineTool({
      name: "Agent",
      label: "Prepare agent task",
      description:
        "Submit exactly one self-contained task for the requested agent, using relevant conversation context. Do not answer the task.",
      parameters: Type.Object(
        { prompt: Type.String({ minLength: 1, maxLength: 2_000_000 }) },
        { additionalProperties: false },
      ),

      execute: async (_id, params) => {
        this.controller.signal.throwIfAborted();
        if (prompt !== undefined) throw new Error("This mention already has a prepared task.");
        prompt = params.prompt;
        return {
          content: [{ type: "text", text: "Task prepared." }],
          details: undefined,
          terminate: true,
        };
      },
    });
    const driver = await openSession(
      {
        pi: manager.pi,
        ctx: manager.context,
        catalog: manager.catalog,
        signal: this.controller.signal,
        sessionDirectory: join(manager.directory, "sessions", this.view.attemptId, "routing"),
        customTools: [route],
        request: {
          prompt: `Route @${this.view.agentType}: ${this.request.prompt}`,
          inherit_context: true,
          max_turns: 2,
          isolated: true,
        },
        definition: {
          name: "mention-router",
          description: "Prepare a self-contained agent task",
          source: "builtin",
          enabled: true,
          isolated: true,
          promptMode: "replace",
          prompt: `${manager.context.getSystemPrompt()}\nRoute the user mention through Agent exactly once. Do not perform the task yourself.`,
          tools: ["Agent"],
          disallowedTools: [],
          allowedSubagents: [this.view.agentType],
          skills: [],
        },
      },
      {
        created: (created) => {
          this.driver = created;
        },

        event: () => {},

        usage: (usage) => {
          this.preparationUsage = { ...usage };
          this.updateUsage(usage);
        },
      },
    );
    await driver.run();
    try {
      await deadline(driver.dispose(), 5000);
    } catch (error) {
      this.cleanupSafe = false;
      throw error;
    }
    this.driver = undefined;
    if (!prompt)
      throw new Error("The mention could not prepare a task. Retry in direct mention mode.");
    await manager.catalog.reload();
    if (
      !manager.catalog
        .definitions()
        .some((definition) => definition.name === this.view.agentType && definition.enabled)
    )
      throw new Error("The agent was disabled or removed while preparing the mention.");
    if (this.view.definition.source === "project" && !manager.context.isProjectTrusted())
      throw new Error("Project trust was revoked while preparing the mention.");
    return prompt;
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
      manager.observe(() =>
        manager.pi.events.emit(
          outcome === "completed" ? "subagents:completed" : "subagents:failed",
          {
            id: this.view.id,
            attemptId: this.view.attemptId,
            result: this.view.result,
            error,
          },
        ),
      );
      manager.observe(() =>
        manager.pi.events.emit("subagents:usage", {
          id: this.view.id,
          attemptId: this.view.attemptId,
          usage: this.view.usage,
        }),
      );
      if (!this.notified) {
        this.notified = true;
        manager.observe(() => manager.onComplete?.(this.view));
      }
      manager.pump();
    })();
    return this.finalizing;
  }

  async persist(
    state: AgentView["state"],
    error?: string,
    finishedAt?: number,
    includeTranscript = true,
  ): Promise<void> {
    const view = this.view;
    const { transcript, ...metadata } = view;
    const value = {
      ...metadata,
      version: 1,
      request: this.request,
      definition: serializeAgent(view.definition),
      source: view.definition.source,
      instructions: this.instructions,
      state,
      error,
      finishedAt,
      cleanupSafe: this.cleanupSafe,
      delivery: this.consumed ? "consumed" : view.background ? "pending" : "inline",
    };
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > 8_000_000)
      throw new Error(
        "Attempt metadata exceeds 8 MB; read the SDK session file for the conversation.",
      );
    const write = this.writeTail.then(async () => {
      if (isSettled(state) && includeTranscript) {
        const conversation = JSON.stringify(transcript);
        if (Buffer.byteLength(conversation) > 8_000_000)
          throw new Error(
            "Conversation projection exceeds 8 MB; the SDK session file remains available.",
          );
        await atomicWrite(view.outputFile.replace(/\.json$/, ".transcript.json"), conversation);
      }
      await atomicWrite(view.outputFile, data);
    });
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
    const rows = decodeTranscript(
      JSON.parse(
        await readText(this.view.outputFile.replace(/\.json$/, ".transcript.json"), 8_000_000),
      ),
    );
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

function receivedAttempts(manager: AgentManager): Set<string> {
  const ids = new Set<string>();
  for (const entry of manager.context.sessionManager.getEntries()) {
    if (entry.type === "custom_message" && entry.customType === "subagent-completion") {
      const details: unknown = entry.details;
      if (Value.Check(completionReceipt, details))
        for (const value of details.agents) ids.add(value.attemptId);
    }
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const details: unknown = entry.message.details;
      if (Value.Check(collectionReceipt, details)) ids.add(details.attemptId);
    }
  }
  return ids;
}

export async function restoreAttempts(manager: AgentManager): Promise<void> {
  await mkdir(join(manager.directory, "attempts"), { recursive: true, mode: 0o700 });
  const files = await readdir(join(manager.directory, "attempts"));
  const restored: Attempt[] = [];
  const received = receivedAttempts(manager);
  for (const file of files.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))) {
    try {
      const value: unknown = JSON.parse(
        await readText(join(manager.directory, "attempts", file), 8_000_000),
      );
      if (!Value.Check(savedSchema, value)) throw new Error("Invalid attempt record.");
      const definition = parseAgent(value.definition, `${value.id}.md`, value.source);
      let sessionIssue: string | undefined;
      if (value.sessionFile) {
        const root = join(manager.directory, "sessions");
        try {
          if (
            !contained(root, resolve(value.sessionFile)) ||
            !contained(await realpath(root), await realpath(value.sessionFile))
          )
            sessionIssue = "The saved session is outside the owned directory.";
        } catch (error) {
          if (!isMissing(error)) throw error;
          sessionIssue = "The saved SDK session file is missing. Its result remains readable.";
        }
      }
      const state =
        value.state === "completed" || value.state === "cancelled" || value.state === "failed"
          ? value.state
          : "failed";
      const view: AgentView = freeze({
        ...value,
        definition,
        agentType: definition.name,
        displayName: definition.displayName ?? definition.name,
        task: taskTitle({
          task:
            value.request.description ||
            value.request.prompt.split("\n")[0] ||
            "Task title unavailable",
        }),
        prompt: value.request.prompt,
        thinking: value.thinking,
        outputFile: join(manager.directory, "attempts", file),
        state,
        error:
          state !== value.state
            ? "Saved execution was not settled. It is not controlled by this instance; Resume is blocked until cleanup can be established. Start a new attempt explicitly if appropriate."
            : value.error,
        transcript: [],
        transcriptLoaded: false,
      });
      const attempt = new Attempt(manager, view, value.request);
      attempt.instructions = value.instructions;
      attempt.cleanupSafe = value.cleanupSafe && state === value.state && !sessionIssue;
      attempt.publish({
        resumeBlocked: attempt.cleanupSafe
          ? undefined
          : (sessionIssue ??
            "Saved cleanup could not be confirmed. Start a fresh session explicitly."),
      });
      attempt.consumed =
        value.delivery === "inline" ||
        state !== value.state ||
        value.owner.id !== manager.root.id ||
        value.owner.attemptId !== undefined ||
        received.has(value.attemptId);
      attempt.resolve(attempt.view);
      restored.push(attempt);
    } catch (error) {
      manager.warn(`Cannot restore ${file}: ${String(error)}. The file was left unchanged.`);
    }
  }
  for (const attempt of restored.toSorted((a, b) => a.view.createdAt - b.view.createdAt))
    manager.insertRestored(attempt);
  manager.changed();
}
