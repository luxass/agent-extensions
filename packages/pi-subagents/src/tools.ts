import type { Usage as ModelUsage } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentSession,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import type { Catalog } from "./catalog.ts";
import type { Owner } from "./manager.ts";
import { isSettled, type AgentView } from "./transcript.ts";

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const thinkingSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

export const turnLimitSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const agentParameters = Type.Object(
  {
    prompt: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    subagent_type: Type.Optional(Type.String()),
    name: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,80}$" })),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(thinkingSchema),
    max_turns: Type.Optional(turnLimitSchema),
    isolated: Type.Optional(Type.Boolean()),
    inherit_context: Type.Optional(Type.Boolean()),
    run_in_background: Type.Optional(Type.Boolean()),
    resume: Type.Optional(Type.String()),
    schedule: Type.Optional(Type.String()),
    join: Type.Optional(Type.Union([Type.Literal("individual"), Type.Literal("group")])),
  },
  { additionalProperties: false },
);

export type AgentParameters = Static<typeof agentParameters>;

export interface SpawnRequest {
  prompt: string;
  description?: string;
  subagent_type?: string;
  name?: string;
  model?: string;
  thinking?: Thinking;
  max_turns?: number;
  isolated?: boolean;
  inherit_context?: boolean;
  run_in_background?: boolean;
  resume?: string;
  cwd?: string;
  isolation?: string;
  schedule?: string;
  schema?: unknown;
  join?: "individual" | "group";
}

export const usageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  cost: Type.Number(),
});

export const spawnParameters = Type.Object({
  ...agentParameters.properties,
  cwd: Type.Optional(Type.String()),
  schema: Type.Optional(Type.Unknown()),
  isolation: Type.Optional(Type.String()),
});

export const resultParameters = Type.Object({
  agent_id: Type.String(),
  wait: Type.Optional(Type.Boolean()),
  verbose: Type.Optional(Type.Boolean()),
});

export const steerParameters = Type.Object({
  agent_id: Type.String(),
  message: Type.String({ minLength: 1 }),
});

export function rejectWorktree(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const entries: [string, unknown][] = Object.entries(value);
  for (const [key, item] of entries) {
    if (
      (key === "isolation" || key === "isolationMode") &&
      item !== undefined &&
      item !== "off" &&
      item !== "none"
    )
      throw new Error(
        "Worktree isolation is not supported. No agent was started. Agents normally share the checkout.",
      );
  }
  if (entries.some(([key]) => /worktree/i.test(key)))
    throw new Error("Worktree configuration is not supported. No agent was started.");
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});

export function addUsage(target: Usage, delta: Usage): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.cost += delta.cost;
}

export function usageSnapshot(session: AgentSession): Usage {
  const stats = session.getSessionStats();
  return { ...stats.tokens, cost: stats.cost };
}

export function usageDelta(now: Usage, baseline: Usage): Usage {
  return {
    input: Math.max(0, now.input - baseline.input),
    output: Math.max(0, now.output - baseline.output),
    cacheRead: Math.max(0, now.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, now.cacheWrite - baseline.cacheWrite),
    cost: Math.max(0, now.cost - baseline.cost),
  };
}

export function matches(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
      "i",
    ).test(name),
  );
}

export const receiptSchema = Type.Union([
  Type.Object({
    version: Type.Literal(1),
    kind: Type.Literal("collection"),
    attemptId: Type.String(),
  }),
  Type.Object({
    version: Type.Literal(1),
    kind: Type.Literal("usage"),
    attemptId: Type.String(),
    toolCallId: Type.String(),
  }),
]);

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

export function receivedAttempts(ctx: ExtensionContext): Set<string> {
  const ids = new Set<string>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (
      entry.type === "custom" &&
      entry.customType === "subagent-receipt" &&
      Value.Check(receiptSchema, entry.data) &&
      entry.data.kind === "collection"
    )
      ids.add(entry.data.attemptId);
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

export function hasReportedUsage(ctx: ExtensionContext, attemptId: string): boolean {
  const entries = ctx.sessionManager.getEntries();
  const calls = new Set<string>();
  for (const entry of entries)
    if (
      entry.type === "custom" &&
      entry.customType === "subagent-receipt" &&
      Value.Check(receiptSchema, entry.data) &&
      entry.data.kind === "usage" &&
      entry.data.attemptId === attemptId
    )
      calls.add(entry.data.toolCallId);
  return entries.some(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.usage !== undefined &&
      (calls.has(entry.message.toolCallId) ||
        (Value.Check(collectionReceipt, entry.message.details) &&
          entry.message.details.attemptId === attemptId)),
  );
}

export interface AgentService {
  readonly context: ExtensionContext;
  readonly root: Owner;
  readonly catalog: Catalog;
  spawn(request: SpawnRequest, owner?: Owner, restart?: boolean): Promise<AgentView>;
  get(id: string, owner?: Owner): AgentView;
  attempt(id: string, attemptId: string): AgentView | undefined;
  list(): readonly AgentView[];
  history(id: string): readonly AgentView[];
  wait(id: string, attemptId: string, signal?: AbortSignal): Promise<AgentView>;
  stop(id: string, owner?: Owner, attemptId?: string): Promise<void>;
  steer(id: string, message: string, owner?: Owner, attemptId?: string): Promise<void>;
  handoff(id: string, attemptId: string): boolean;
  consume(id: string, attemptId: string, owner: Owner, toolCallId: string): Usage | undefined;
  waiting(owner: Owner, attemptId: string, active: boolean): void;
  loadTranscript(id: string, attemptId: string): Promise<void>;
  mention(name: string, text: string): Promise<AgentView>;
  subscribe(listener: () => void): () => void;
  changed(): void;
}

export const coreAgentParameters = Type.Omit(agentParameters, ["schedule"]);
export type InlineView = Pick<
  AgentView,
  | "id"
  | "attemptId"
  | "name"
  | "displayName"
  | "task"
  | "state"
  | "activity"
  | "background"
  | "createdAt"
  | "startedAt"
  | "finishedAt"
  | "result"
  | "error"
  | "usage"
>;

export function inlineView(view: AgentView): InlineView {
  return {
    id: view.id,
    attemptId: view.attemptId,
    name: view.name,
    displayName: view.displayName,
    task: view.task,
    state: view.state,
    activity: view.activity,
    background: view.background,
    createdAt: view.createdAt,
    startedAt: view.startedAt,
    finishedAt: view.finishedAt,
    result: view.result,
    error: view.error,
    usage: { ...view.usage },
  };
}

/** Session statistics expose total cost, not provider-specific cost attribution. */
function toolUsage(usage: Usage): ModelUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
  };
}

function result(view: AgentView, usage?: ReturnType<typeof toolUsage>) {
  const body = `${view.displayName} · ${view.task}\nState: ${view.state}${view.error ? `\n${view.error}` : ""}\n${view.result || view.activity}\nAgent: ${view.id}\nAttempt: ${view.attemptId}\nRecord: ${view.outputFile}`;
  return {
    content: [
      {
        type: "text" as const,
        text:
          body.length > 24000
            ? `${body.slice(0, 23800)}\n[Preview truncated; read ${view.outputFile} for the full result.]`
            : body,
      },
    ],
    details: { id: view.id, attemptId: view.attemptId, snapshot: inlineView(view) },
    usage,
    isError: view.state === "failed" || view.state === "cancelled",
  };
}

async function foreground(
  service: AgentService,
  view: AgentView,
  owner: Owner,
  signal?: AbortSignal,
): Promise<AgentView> {
  const abort = () => {
    const current = service.attempt(view.id, view.attemptId);
    if (current && !current.background)
      void service.stop(view.id, owner, view.attemptId).catch(() => {});
  };

  signal?.addEventListener("abort", abort, { once: true });
  let unsubscribe: (() => void) | undefined;
  service.waiting(owner, view.attemptId, true);
  const handedOff = new Promise<AgentView>((done) => {
    const check = () => {
      const current = service.attempt(view.id, view.attemptId);
      if (current?.background) done(current);
    };

    unsubscribe = service.subscribe(check);
    check();
  });
  try {
    if (signal?.aborted) abort();
    return await Promise.race([service.wait(view.id, view.attemptId, signal), handedOff]);
  } catch (error) {
    if (signal?.aborted && !service.attempt(view.id, view.attemptId)?.background) {
      await service.stop(view.id, owner, view.attemptId);
      return service.attempt(view.id, view.attemptId) ?? view;
    }
    throw error;
  } finally {
    unsubscribe?.();
    signal?.removeEventListener("abort", abort);
    service.waiting(owner, view.attemptId, false);
  }
}

/** Root and nested tools share behavior; only their captured owner/default differs. */
export function createAgentTools(
  provider: AgentService | ((ctx: ExtensionContext) => Promise<AgentService>),
  capturedOwner: Owner | undefined,
  root: boolean,
) {
  return [
    defineTool({
      name: "Agent",
      label: "Agent",
      parameters: coreAgentParameters,
      description: root
        ? "Start a focused child agent. Background is the default; completion arrives automatically. Use foreground when your next action needs the result. Agents share the checkout. Use a stable ID or handle to collect, steer, or resume. Resume keeps saved instructions and tool permissions."
        : "Delegate to an allowed child. Nested calls wait in foreground by default so you can collect their results. Explicit background children are cancelled when your attempt finishes; collect needed results before finishing. Children share the checkout.",

      prepareArguments: (raw) => {
        rejectWorktree(raw);
        if (!Value.Check(agentParameters, raw)) throw new Error("Invalid agent arguments.");
        if (raw.schedule !== undefined)
          throw new Error("Scheduling is not supported. No job was created.");
        return raw;
      },

      execute: async (_id, params, signal, onUpdate, ctx) => {
        signal?.throwIfAborted();
        const service = typeof provider === "function" ? await provider(ctx) : provider;
        const owner = capturedOwner ?? service.root;
        const view = await service.spawn(params, owner);
        if (isSettled(view.state)) {
          const usage = service.consume(view.id, view.attemptId, owner, _id);
          return result(view, usage ? toolUsage(usage) : undefined);
        }
        if (view.background) return result(view);
        const unsubscribe = service.subscribe(() => {
          const current = service.attempt(view.id, view.attemptId);
          if (current) onUpdate?.(result(current));
        });
        try {
          const completed = await foreground(service, view, owner, signal);
          const usage = isSettled(completed.state)
            ? service.consume(completed.id, completed.attemptId, owner, _id)
            : undefined;
          return result(completed, usage ? toolUsage(usage) : undefined);
        } finally {
          unsubscribe();
        }
      },
    }),
    defineTool({
      name: "get_subagent_result",
      label: "Agent result",
      parameters: resultParameters,
      description:
        "Read one of your own agents' state and result. wait waits for this attempt, without cancelling it if waiting is interrupted. Terminal collection consumes its pending completion notification. verbose includes conversation data when available.",

      execute: async (_id, params, signal, _update, ctx) => {
        const service = typeof provider === "function" ? await provider(ctx) : provider;
        const owner = capturedOwner ?? service.root;
        let view = service.get(params.agent_id, owner);
        if (params.wait) {
          service.waiting(owner, view.attemptId, true);
          try {
            view = await service.wait(view.id, view.attemptId, signal);
          } finally {
            service.waiting(owner, view.attemptId, false);
          }
        }
        const usage = isSettled(view.state)
          ? service.consume(view.id, view.attemptId, owner, _id)
          : undefined;
        const response = result(view, usage ? toolUsage(usage) : undefined);
        if (params.verbose) {
          await service.loadTranscript(view.id, view.attemptId).catch((error: unknown) => {
            response.content.push({ type: "text", text: String(error) });
          });
          const transcript = JSON.stringify(service.attempt(view.id, view.attemptId)?.transcript);
          if (transcript)
            response.content.push({
              type: "text",
              text:
                transcript.length <= 100000
                  ? transcript
                  : `Conversation is large; read ${view.sessionFile ?? view.outputFile}.`,
            });
        }
        return response;
      },
    }),
    defineTool({
      name: "steer_subagent",
      label: "Steer agent",
      parameters: steerParameters,
      description:
        "Send instructions to one of your running child attempts. Steering takes effect at the next safe execution boundary.",

      execute: async (_id, params, signal, _update, ctx) => {
        const service = typeof provider === "function" ? await provider(ctx) : provider;
        const owner = capturedOwner ?? service.root;
        signal?.throwIfAborted();
        const view = service.get(params.agent_id, owner);
        await service.steer(view.id, params.message, owner, view.attemptId);
        return { content: [{ type: "text", text: "Instructions queued." }], details: undefined };
      },
    }),
  ] as const;
}
