import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { AgentDefinition } from "./agents.ts";

export const thinkingSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);

export type Thinking = Static<typeof thinkingSchema>;

/** Zero means unlimited. The same rule applies to settings, definitions, and tool calls. */
export const turnLimitSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

export const usageSchema = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  cost: Type.Number(),
});

export type Usage = Static<typeof usageSchema>;

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

export type AttemptState =
  | "queued"
  | "starting"
  | "running"
  | "settling"
  | "completed"
  | "failed"
  | "cancelled";

/** Activity of a queued attempt that found no free capacity slot. */
export const waitingForCapacity = "Waiting for capacity";

/**
 * A new attempt is "queued" while its record is saved, before it asks for a slot.
 * Only an attempt that asked and found every slot taken is really waiting.
 */
export function isWaiting(view: Pick<AgentView, "state" | "activity">): boolean {
  return view.state === "queued" && view.activity === waitingForCapacity;
}

export function isSettled(state: AttemptState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

/** The main session (`{ id: sessionId }`) or the parent attempt that owns an attempt. */
export interface Owner {
  readonly id: string;
  readonly attemptId?: string;
}

export function sameOwner(a: Owner, b: Owner): boolean {
  return a.id === b.id && a.attemptId === b.attemptId;
}

type AssistantMessage = Extract<AgentSession["messages"][number], { role: "assistant" }>;

export type TranscriptRow =
  | { readonly id: string; readonly kind: "user"; readonly text: string }
  | {
      readonly id: string;
      readonly kind: "extension";
      readonly text: string;
      readonly notice?: "turn-budget";
    }
  | {
      readonly id: string;
      readonly kind: "assistant";
      readonly message: AssistantMessage;
      readonly streaming: boolean;
    }
  | {
      readonly id: string;
      readonly kind: "tool";
      readonly name: string;
      readonly args: Record<string, unknown>;
      readonly text: string;
      readonly pending: boolean;
      readonly error: boolean;
    };

/** Everything the UI and tools know about one attempt. Replaced, never changed in place. */
export interface AgentView {
  readonly id: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly owner: Owner;
  readonly depth: number;
  readonly name: string;
  readonly agentType: string;
  readonly displayName: string;
  readonly task: string;
  readonly prompt: string;
  readonly state: AttemptState;
  readonly activity: string;
  readonly background: boolean;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly result: string;
  readonly error?: string;
  readonly model?: string;
  readonly thinking?: Thinking;
  readonly usage: Readonly<Usage>;
  readonly lifetimeUsage: Readonly<Usage>;
  readonly turns: number;
  readonly toolCalls: number;
  readonly outputFile: string;
  readonly sessionFile?: string;
  readonly definition: Readonly<AgentDefinition>;
  readonly transcript: readonly TranscriptRow[];
  readonly transcriptLoaded: boolean;
  readonly resumeBlocked?: string;
}

/** The snapshot stored in tool results and completion messages, for inline cards. */
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
> &
  Partial<Pick<AgentView, "toolCalls">>;

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
    toolCalls: view.toolCalls,
  };
}
