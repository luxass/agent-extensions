import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { AgentDefinition } from "./agents.ts";
import { record } from "./io.ts";
import type { AttemptState, Owner } from "./manager.ts";
import type { Thinking, Usage } from "./tools.ts";

type AssistantMessage = Extract<AgentSession["messages"][number], { role: "assistant" }>;

export type TranscriptRow =
  | { readonly id: string; readonly kind: "user"; readonly text: string }
  | {
      readonly id: string;
      readonly kind: "extension";
      readonly text: string;
      readonly notice?: "turn-budget" | "structured-output";
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

export function isSettled(state: AttemptState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

export function immutable<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) immutable(child);
  return Object.freeze(value);
}

export function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return (value as unknown[])
    .flatMap((part) =>
      record(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

const counter = Type.Number();
const modelUsage = Type.Object({
  input: counter,
  output: counter,
  cacheRead: counter,
  cacheWrite: counter,
  totalTokens: counter,
  cost: Type.Object({
    input: counter,
    output: counter,
    cacheRead: counter,
    cacheWrite: counter,
    total: counter,
  }),
});

const assistant = Type.Object({
  role: Type.Literal("assistant"),
  api: Type.String(),
  provider: Type.String(),
  model: Type.String(),
  timestamp: counter,
  stopReason: Type.String(),
  errorMessage: Type.Optional(Type.String()),
  usage: modelUsage,
  content: Type.Array(
    Type.Union([
      Type.Object({ type: Type.Literal("text"), text: Type.String() }),
      Type.Object({ type: Type.Literal("thinking"), thinking: Type.String() }),
      Type.Object({
        type: Type.Literal("toolCall"),
        id: Type.String(),
        name: Type.String(),
        arguments: Type.Record(Type.String(), Type.Unknown()),
      }),
    ]),
  ),
});

const rowsSchema = Type.Array(
  Type.Union([
    Type.Object({
      id: Type.String(),
      kind: Type.Literal("user"),
      text: Type.String(),
    }),
    Type.Object({
      id: Type.String(),
      kind: Type.Literal("extension"),
      text: Type.String(),
      notice: Type.Optional(
        Type.Union([Type.Literal("turn-budget"), Type.Literal("structured-output")]),
      ),
    }),
    Type.Object({
      id: Type.String(),
      kind: Type.Literal("assistant"),
      message: assistant,
      streaming: Type.Boolean(),
    }),
    Type.Object({
      id: Type.String(),
      kind: Type.Literal("tool"),
      name: Type.String(),
      args: Type.Record(Type.String(), Type.Unknown()),
      text: Type.String(),
      pending: Type.Boolean(),
      error: Type.Boolean(),
    }),
  ]),
);

export function decodeTranscript(value: unknown): readonly TranscriptRow[] {
  if (!Value.Check(rowsSchema, value))
    throw new Error("Invalid saved conversation. The source file was left unchanged.");
  // The persisted provider/API identifiers are strings; presentation never dispatches them.
  return immutable(value as unknown as TranscriptRow[]);
}

/** Projection is updated once per SDK event, never rebuilt on an animation frame. */
export class TranscriptProjection {
  private rows: TranscriptRow[] = [];
  private assistantId?: string;
  private sequence = 0;

  restore(rows: readonly TranscriptRow[]): void {
    this.rows = [...rows];
  }

  snapshot(): readonly TranscriptRow[] {
    return Object.freeze([...this.rows]);
  }

  apply(event: AgentSessionEvent): { rows: readonly TranscriptRow[]; result?: string } | undefined {
    let changed = false;
    let result: string | undefined;
    if (event.type === "tool_execution_start") {
      const args: unknown = event.args;
      this.rows.push(
        immutable({
          id: event.toolCallId,
          kind: "tool",
          name: event.toolName,
          args: record(args) ? structuredClone(args) : {},
          text: "",
          pending: true,
          error: false,
        }),
      );
      changed = true;
    }
    if (event.type === "tool_execution_end" || event.type === "tool_execution_update") {
      const value: unknown =
        event.type === "tool_execution_end" ? event.result : event.partialResult;
      const index = this.rows.findIndex(
        (row) => row.id === event.toolCallId && row.kind === "tool",
      );
      const row = this.rows[index];
      if (row?.kind === "tool") {
        this.rows[index] = immutable({
          ...row,
          text: record(value) ? contentText(value.content) : "",
          pending: event.type === "tool_execution_update",
          error: event.type === "tool_execution_end" && event.isError,
        });
        changed = true;
      }
    }
    if (
      event.type === "message_start" &&
      (event.message.role === "user" || (event.message.role === "custom" && event.message.display))
    ) {
      const value = contentText(event.message.content);
      if (value) {
        const row: TranscriptRow =
          event.message.role === "user"
            ? { id: `user-${++this.sequence}`, kind: "user", text: value }
            : {
                id: `extension-${++this.sequence}`,
                kind: "extension",
                text: value,
                notice:
                  event.message.customType === "subagents:turn-budget"
                    ? "turn-budget"
                    : event.message.customType === "subagents:structured-output"
                      ? "structured-output"
                      : undefined,
              };
        this.rows.push(immutable(row));
        changed = true;
      }
    }
    if (
      (event.type === "message_start" ||
        event.type === "message_update" ||
        event.type === "message_end") &&
      event.message.role === "assistant"
    ) {
      this.assistantId ??= `assistant-${++this.sequence}`;
      const row: TranscriptRow = immutable({
        id: this.assistantId,
        kind: "assistant",
        message: structuredClone(event.message),
        streaming: event.type !== "message_end",
      });
      const index = this.rows.findIndex((item) => item.id === row.id);
      if (index < 0) this.rows.push(row);
      else this.rows[index] = row;
      result = contentText(event.message.content) || undefined;
      if (event.type === "message_end") this.assistantId = undefined;
      changed = true;
    }
    return changed ? { rows: this.snapshot(), result } : undefined;
  }
}

export function toolActivity(name: string, value: unknown): string {
  const args = record(value) ? value : {};
  if (name === "bash" || name === "powershell") return `Running ${name}`;
  const detail =
    typeof args.path === "string"
      ? args.path
      : typeof args.command === "string"
        ? args.command
        : typeof args.pattern === "string"
          ? args.pattern
          : "";
  const safe = Array.from(detail)
    .map((character) => (character.charCodeAt(0) < 32 ? " " : character))
    .join("")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  const verbs: Record<string, string> = {
    read: "Reading",
    write: "Writing",
    edit: "Editing",
    grep: "Searching",
    find: "Finding",
    ls: "Listing",
    bash: "Running",
  };
  return `${verbs[name] ?? `Using ${name}`}${safe ? ` ${safe}` : ""}`;
}

export function taskTitle(view: Pick<AgentView, "task">): string {
  return Array.from(view.task || "Task title unavailable")
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}
