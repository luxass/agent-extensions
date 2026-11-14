import type { Theme } from "@earendil-works/pi-coding-agent";

import type { SubagentRecord } from "../manager.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** How long a foreground agent runs before its row suggests Ctrl+B (S6). */
export const BACKGROUND_HINT_DELAY_MS = 3000;

// CSI and OSC sequences, then any other escape or control character except newline and tab.
const CONTROL_SEQUENCES =
  // oxlint-disable-next-line no-control-regex -- matching terminal control sequences is the point.
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b.|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Removes terminal control sequences from agent output before it is displayed (S8). */
export function cleanSubagentText(text: string): string {
  return text.replace(CONTROL_SEQUENCES, "");
}

/**
 * Cleans every string inside a value from an agent, such as tool-call arguments or result details.
 * Pi's tool renderers print these as they are, so they are cleaned before a renderer sees them (S8).
 */
export function cleanSubagentValue<Value>(value: Value): Value {
  // The shape stays the same. Only the strings inside it change.
  return cleanStrings(value) as Value;
}

function cleanStrings(value: unknown): unknown {
  if (typeof value === "string") return cleanSubagentText(value);
  if (Array.isArray(value)) return value.map((item: unknown) => cleanStrings(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]: [string, unknown]) => [
        cleanSubagentText(key),
        cleanStrings(item),
      ]),
    );
  }
  return value;
}

/** First line of agent text with words in it, cleaned for one-line display. Code fences are skipped. */
export function firstSubagentLine(text: string): string {
  const lines = cleanSubagentText(text).split("\n");
  return lines.find((line) => line.trim() && !line.trim().startsWith("```"))?.trim() ?? "";
}

const STATUS_MARKS = {
  queued: ["dim", "◌"],
  stopping: ["warning", "■"],
  completed: ["success", "✓"],
  stopped: ["warning", "■"],
  failed: ["error", "✗"],
  interrupted: ["warning", "!"],
} as const;

/** The one status mark the widget, cards, and `/agents` share (S8). */
export function subagentStatusMark(record: SubagentRecord, theme: Theme): string {
  if (record.status === "running") {
    return theme.fg("accent", SPINNER[Math.floor(Date.now() / 80) % SPINNER.length] ?? "⠋");
  }
  const [color, mark] = STATUS_MARKS[record.status];
  // A partial answer is still an answer, but it stopped at the turn limit.
  return theme.fg(record.partial ? "warning" : color, mark);
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Elapsed time of the latest run, such as 42s or 3m 05s. */
export function subagentElapsed(record: SubagentRecord): string {
  if (!record.startedAt) return "";
  const seconds = Math.max(
    0,
    Math.round(((record.endedAt ?? Date.now()) - record.startedAt) / 1000),
  );
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Turns, tool uses, tokens with context percentage, and elapsed time, joined with dots. */
export function subagentCounters(record: SubagentRecord): string {
  const context = record.contextPercent === null ? "" : ` (${Math.round(record.contextPercent)}%)`;
  const parts = [
    `↻${record.turns}${record.maxTurns ? `/${record.maxTurns}` : ""}`,
    `${record.toolUses} tool use${record.toolUses === 1 ? "" : "s"}`,
    `${formatTokens(record.tokens.total)} tokens${context}`,
  ];
  const elapsed = subagentElapsed(record);
  if (elapsed) parts.push(elapsed);
  return parts.join(" · ");
}

/** Whether a foreground row should show the Ctrl+B hint now (S6). */
export function showsBackgroundHint(record: SubagentRecord): boolean {
  return (
    !record.background &&
    record.status === "running" &&
    Date.now() - (record.startedAt ?? Date.now()) >= BACKGROUND_HINT_DELAY_MS
  );
}

/** Status word for the latest run, with partial results marked. */
export function subagentStatusLabel(record: SubagentRecord): string {
  return record.partial && record.status === "completed" ? "partial" : record.status;
}
