import type { Theme } from "@earendil-works/pi-coding-agent";

import type { SubagentRecord } from "../manager.ts";
import { cutPlainText } from "./text-layout.ts";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** How long a foreground agent runs before its row suggests Ctrl+B. */
export const BACKGROUND_HINT_DELAY_MS = 3000;

// CSI and OSC sequences, then any other escape or control character except newline and tab.
const CONTROL_SEQUENCES =
  // oxlint-disable-next-line no-control-regex -- matching terminal control sequences is the point.
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b.|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Removes terminal control sequences from agent output before it is displayed. */
export function cleanSubagentText(text: string): string {
  return text.replace(CONTROL_SEQUENCES, "");
}

/**
 * Cleans every string inside a value from an agent, such as tool-call arguments or result details.
 * Pi's tool renderers print these as they are, so they are cleaned before a renderer sees them.
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

/** The color of an agent's status mark and status word. */
function subagentStatusColor(record: SubagentRecord) {
  if (record.status === "running") return "accent" as const;
  // A partial answer is still an answer, but it stopped at the turn limit.
  return record.partial ? ("warning" as const) : STATUS_MARKS[record.status][0];
}

/** The one status mark the widget, cards, and `/agents` share. */
export function subagentStatusMark(record: SubagentRecord, theme: Theme): string {
  if (record.status === "running") {
    return theme.fg("accent", SPINNER[Math.floor(Date.now() / 80) % SPINNER.length] ?? "⠋");
  }
  return theme.fg(subagentStatusColor(record), STATUS_MARKS[record.status][1]);
}

const STATUS_WORDS = {
  queued: "Queued",
  running: "Running",
  stopping: "Stopping",
  completed: "Done",
  stopped: "Stopped",
  failed: "Failed",
  interrupted: "Interrupted",
} as const;

/** Width of the longest status badge, "! Interrupted", so badges line up in a column. */
export const SUBAGENT_BADGE_WIDTH = 13;

/** Status mark and status word in the status color, such as "✓ Done", for the `/agents` list. */
export function subagentBadge(record: SubagentRecord, theme: Theme): string {
  const word =
    record.partial && record.status === "completed" ? "Partial" : STATUS_WORDS[record.status];
  return `${subagentStatusMark(record, theme)} ${theme.fg(subagentStatusColor(record), word)}`;
}

/** The model and thinking level an agent runs on, such as "openai/gpt-6.1-sol · thinking medium". */
export function subagentModelLabel(record: SubagentRecord): string {
  return `${record.model || "model pending"} · thinking ${record.thinking}`;
}

/** The agent's task on one line: the first line of its prompt, cleaned for display. */
export function subagentTaskTitle(record: SubagentRecord): string {
  const title = cleanSubagentText(record.task).replace(/\s+/g, " ").trim().slice(0, 160);
  return title || record.name;
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

/**
 * What a working agent is doing, such as "bash sleep 100", cut to `room` columns. Callers give it
 * the room that is left after the counters, so a long command cannot push the counters off the
 * line. It keeps at least 16 columns, enough to name the tool and the start of its input.
 */
export function subagentActivity(record: SubagentRecord, room: number): string {
  return cutPlainText(cleanSubagentText(record.activity), Math.max(16, room));
}

/**
 * Turns, tool uses, tokens with context percentage, and elapsed time, joined with dots. Pass
 * `elapsed: false` where the elapsed time is already shown next to it.
 */
export function subagentCounters(record: SubagentRecord, options = { elapsed: true }): string {
  const context = record.contextPercent === null ? "" : ` (${Math.round(record.contextPercent)}%)`;
  const parts = [
    `↻${record.turns}${record.maxTurns ? `/${record.maxTurns}` : ""}`,
    `${record.toolUses} tool use${record.toolUses === 1 ? "" : "s"}`,
    `${formatTokens(record.tokens.total)} tokens${context}`,
  ];
  const elapsed = options.elapsed ? subagentElapsed(record) : "";
  if (elapsed) parts.push(elapsed);
  return parts.join(" · ");
}

/** Whether a foreground row should show the Ctrl+B hint now. */
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
