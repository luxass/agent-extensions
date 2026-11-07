import {
  getMarkdownTheme,
  type AgentToolResult,
  type ToolDefinition,
  type ToolRenderResultOptions,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  Text,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

import { record } from "./io.ts";
import type { AgentManager } from "./manager.ts";
import { contentText, promptTitle, taskTitle } from "./transcript.ts";
import { inlineView, isSettled, isWaiting, type AgentView, type InlineView } from "./types.ts";

const inlineSchema = Type.Object({
  id: Type.String(),
  attemptId: Type.String(),
  name: Type.String(),
  displayName: Type.String(),
  task: Type.String(),
  state: Type.Union([
    Type.Literal("queued"),
    Type.Literal("starting"),
    Type.Literal("running"),
    Type.Literal("settling"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
  activity: Type.String(),
  background: Type.Boolean(),
  createdAt: Type.Number(),
  startedAt: Type.Optional(Type.Number()),
  finishedAt: Type.Optional(Type.Number()),
  result: Type.String(),
  error: Type.Optional(Type.String()),
  toolCalls: Type.Optional(Type.Integer({ minimum: 0 })),
  usage: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    cost: Type.Number(),
  }),
});

const inlineDetailsSchema = Type.Object({ snapshot: inlineSchema });

/**
 * The first line of actual text in an answer. Headings, rules, and code fences are skipped,
 * because a line such as "Purpose" says nothing about the result.
 */
function answerLine(result: string): string {
  const lines = plain(result)
    .split("\n")
    .map((text) => text.trim())
    .filter(Boolean);
  const line =
    lines.find((text) => !/^(?:#{1,6}\s|```|~~~|[-*_]{3,}$)/.test(text)) ?? lines[0] ?? "";
  return line
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ");
}

export function plain(value: string): string {
  return stripTerminalSequences(value).replace(
    // oxlint-disable-next-line eslint/no-control-regex -- Keep printable text, tabs and line breaks.
    /[\x00-\x08\u000b-\x1f\u007f-\u009f\ufff9-\ufffb]/g,
    "",
  );
}

function heading(
  role: string,
  task: string,
  icon: string,
  time: string,
  theme: Theme,
  width: number,
  tone: ReturnType<typeof agentBadge>["tone"] = "accent",
): string {
  const label = `${theme.fg(tone, icon)} ${theme.bold(plain(role))} ${theme.fg("dim", "·")} ${plain(task).replace(/\s+/g, " ")}`;
  const budget = Math.max(1, width - visibleWidth(time) - 2);
  if (width < 24) return truncateToWidth(label, width);
  const left = truncateToWidth(label, budget);
  return `${left}${" ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(time)))}${theme.fg("dim", time)}`;
}

/** An inline card is pinned to an attempt, not the latest run with the same handle. */
export class AgentCard implements Component {
  private service?: AgentManager;
  private unsubscribe?: () => void;
  private markdown?: Markdown;
  private body?: string;
  private cached?: {
    view: InlineView;
    width: number;
    theme: Theme;
    expanded: boolean;
    frame: number;
    lines: string[];
  };
  expanded = false;

  constructor(
    private snapshot: InlineView,
    private theme: Theme,
    private readonly getService?: () => AgentManager | undefined,
    private readonly redraw: () => void = () => {},
  ) {
    this.syncService();
  }

  private syncService(): void {
    const service = this.getService?.();
    if (service === this.service) return;

    this.dispose();
    this.service = service;

    const update = (): void => {
      const current = service?.attempt(this.snapshot.id, this.snapshot.attemptId);
      if (current) this.snapshot = inlineView(current);
      this.invalidate();
    };

    update();

    if (service && !isSettled(this.snapshot.state)) {
      this.unsubscribe = service.subscribe(() => {
        update();
        if (isSettled(this.snapshot.state)) this.dispose();
        this.redraw();
      });
    }
  }

  configure(expanded: boolean, theme: Theme): void {
    this.expanded = expanded;
    this.theme = theme;
  }

  render(width: number): string[] {
    this.syncService();
    const view = this.service?.attempt(this.snapshot.id, this.snapshot.attemptId) ?? this.snapshot;
    const active = !isSettled(view.state);
    const frame = active ? Math.floor(Date.now() / 150) : 0;
    if (
      this.cached?.view === view &&
      this.cached.width === width &&
      this.cached.theme === this.theme &&
      this.cached.expanded === this.expanded &&
      this.cached.frame === frame
    )
      return this.cached.lines;
    const badge = agentBadge(view);
    const lines = [
      this.theme.fg(badge.tone, `${badge.icon} `) +
        this.theme.bold(taskTitle({ task: plain(view.task) })),
    ];
    const tokens =
      view.usage.input + view.usage.output + view.usage.cacheRead + view.usage.cacheWrite;
    const tokenCount =
      tokens >= 1_000_000
        ? `${(tokens / 1_000_000).toFixed(1)}m`
        : tokens >= 1_000
          ? `${(tokens / 1_000).toFixed(1)}k`
          : String(tokens);
    let summary: string;
    if (active) {
      summary = between(
        plain(view.activity).replace(/\s+/g, " "),
        `· ${elapsed(view)}`,
        Math.max(0, width - 2),
      );
    } else {
      const statistics = [
        ...(view.toolCalls !== undefined
          ? [`${view.toolCalls} tool use${view.toolCalls === 1 ? "" : "s"}`]
          : []),
        `${tokenCount} token${tokens === 1 ? "" : "s"}`,
      ];
      summary = [badge.label, ...statistics, elapsed(view)].join(" · ");
      while (statistics.length && visibleWidth(summary) > Math.max(0, width - 2)) {
        statistics.pop();
        summary = [badge.label, ...statistics, elapsed(view)].join(" · ");
      }
    }
    lines.push(this.theme.fg(view.state === "failed" ? "error" : "muted", `  ${summary}`));
    const text = plain(
      active
        ? this.expanded
          ? view.result || view.activity
          : view.activity
        : view.result || view.error || (view.state === "completed" ? "Done" : "Stopped"),
    );
    if (!this.expanded && view.error) {
      const error = plain(view.error).replace(/\s+/g, " ");
      lines.push(this.theme.fg("error", `  ${error}`));
    } else if (!this.expanded && !active) {
      // One line of the answer. The full answer stays behind the expand control.
      const answer = answerLine(view.result);
      if (answer) lines.push(`  ${answer}`);
    } else if (this.expanded && (!active || view.result)) {
      if (this.body !== text) {
        this.body = text;
        this.markdown = new Markdown(text, 0, 0, getMarkdownTheme());
      }
      lines.push(
        ...(this.markdown?.render(Math.max(1, width - 2)) ?? []).map((line) => `  ${line}`),
      );
      if (view.error && view.result) lines.push(this.theme.fg("error", `  ${plain(view.error)}`));
      lines.push(
        this.theme.fg(
          "dim",
          `  ${plain(view.displayName).replace(/\s+/g, " ")} · @${plain(view.name).replace(/\s+/g, " ")}`,
        ),
      );
    }
    const rendered = lines.map((line) => truncateToWidth(line, width));
    this.cached = {
      view,
      width,
      theme: this.theme,
      expanded: this.expanded,
      frame,
      lines: rendered,
    };
    return rendered;
  }

  invalidate(): void {
    this.cached = undefined;
    this.body = undefined;
    this.markdown?.invalidate();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

interface InlineState {
  resultSeen?: boolean;
  modelCount?: number;
  hasCard?: boolean;
}

type Context = Parameters<
  NonNullable<ToolDefinition<TSchema, unknown, InlineState>["renderCall"]>
>[2];

export function agentRenderers(
  service: () => AgentManager | undefined,
  label: "Agent" | "Agent result" | "Steer agent" | "Subagent models" = "Agent",
) {
  return {
    renderShell: "self" as const,

    renderCall(input: unknown, theme: Theme, context: Context): Component {
      const state = context.state;
      const args = record(input) ? input : {};
      return {
        render(width) {
          if (state.hasCard && (label === "Agent" || label === "Agent result")) return [];
          let role: string = label;
          let task: string;
          if (label === "Agent") {
            role = typeof args.subagent_type === "string" ? args.subagent_type : label;
            task =
              typeof args.description === "string" && args.description.trim()
                ? args.description
                : typeof args.prompt === "string"
                  ? promptTitle(args.prompt) || "Preparing task…"
                  : "Preparing task…";
          } else if (label === "Subagent models") {
            task = context.isError
              ? "Failed"
              : state.modelCount !== undefined
                ? `${state.modelCount} available`
                : state.resultSeen
                  ? "Finished"
                  : "Reading available models…";
          } else {
            const id = typeof args.agent_id === "string" ? args.agent_id : "";
            const view = service()
              ?.list()
              .find((view) => view.id === id || view.name === id);
            task = view ? `@${view.name}` : id || "Selecting agent…";
          }
          const icon = context.isError ? "✕" : state.resultSeen ? "✓" : "◌";
          const tone = context.isError ? "error" : state.resultSeen ? "success" : "accent";
          const lines = [
            label === "Agent"
              ? truncateToWidth(
                  theme.fg(tone, `${icon} `) +
                    theme.bold(taskTitle({ task: plain(task) }) || "Preparing task…"),
                  width,
                )
              : heading(
                  plain(role).replace(/\s+/g, " "),
                  taskTitle({ task: plain(task) }),
                  icon,
                  "",
                  theme,
                  width,
                  tone,
                ),
          ];
          if (label === "Steer agent" && context.expanded && typeof args.message === "string")
            lines.push(
              ...wrapTextWithAnsi(plain(args.message), Math.max(1, width - 2)).map((line) =>
                truncateToWidth(`  ${line}`, Math.max(0, width)),
              ),
            );
          return lines;
        },

        invalidate() {},
      };
    },

    renderResult(
      result: AgentToolResult<unknown>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: Context,
    ): Component {
      context.state.resultSeen = true;
      if (label === "Subagent models") {
        const details: unknown = result.details;
        context.state.modelCount = Value.Check(
          Type.Object({ models: Type.Array(Type.String()) }),
          details,
        )
          ? details.models.length
          : undefined;
        if (context.state.modelCount !== undefined && !options.expanded && !context.isError)
          return new Text("", 0, 0);
      }
      const details: unknown = result.details;
      context.state.hasCard = false;
      if (Value.Check(inlineDetailsSchema, details)) {
        context.state.hasCard = true;
        const card =
          context.lastComponent instanceof AgentCard
            ? context.lastComponent
            : new AgentCard(details.snapshot, theme, service, context.invalidate);
        card.configure(options.expanded, theme);
        return card;
      }
      if (context.lastComponent instanceof AgentCard) context.lastComponent.dispose();
      const text = new Text(
        result.content
          .flatMap((part) => (part.type === "text" ? [plain(part.text)] : []))
          .join("\n")
          .slice(0, options.expanded ? 24000 : 160),
        0,
        0,
      );
      return {
        render(width) {
          const lines = text.render(Math.max(1, width - 2));
          return (options.expanded ? lines : lines.slice(0, 2)).map((line) =>
            truncateToWidth(
              theme.fg(context.isError ? "error" : "muted", `  ${line}`),
              Math.max(0, width),
            ),
          );
        },
        invalidate: () => text.invalidate(),
      };
    },
  };
}

export function completionCards(
  value: unknown,
  theme: Theme,
  expanded: boolean,
  getService?: () => AgentManager | undefined,
): Component | undefined {
  if (!Value.Check(Type.Object({ agents: Type.Array(inlineSchema) }), value)) return undefined;
  const cards = value.agents.map((snapshot) => {
    const card = new AgentCard(snapshot, theme, getService);
    card.configure(expanded, theme);
    return { snapshot, card };
  });
  let visible = cards;
  let previousService: AgentManager | undefined;
  let previousLeaf: string | null | undefined;
  return {
    render(width) {
      const service = getService?.();
      const leaf = service?.context.sessionManager.getLeafId();
      if (service !== previousService || leaf !== previousLeaf) {
        previousService = service;
        previousLeaf = leaf;
        const represented = new Set<string>();
        for (const entry of service?.context.sessionManager.buildContextEntries() ?? []) {
          if (
            entry.type !== "message" ||
            entry.message.role !== "toolResult" ||
            (entry.message.toolName !== "Agent" && entry.message.toolName !== "get_subagent_result")
          )
            continue;
          const details: unknown = entry.message.details;
          if (Value.Check(inlineDetailsSchema, details))
            represented.add(`${details.snapshot.id}/${details.snapshot.attemptId}`);
        }
        visible = cards.filter(
          ({ snapshot }) => !represented.has(`${snapshot.id}/${snapshot.attemptId}`),
        );
      }
      const lines: string[] = [];
      for (const { card } of visible) {
        if (lines.length) lines.push("");
        lines.push(...card.render(width));
      }
      return lines;
    },

    invalidate() {
      previousService = undefined;
      previousLeaf = undefined;
      visible = cards;
      for (const { card } of cards) card.invalidate();
    },
  };
}

export interface OutputPreview {
  readonly kind: "answer" | "tool" | "empty";
  readonly text: string;
  readonly label?: string;
}

/** Prefer the latest visible activity, not an earlier assistant preamble. */
export function outputPreview(view: AgentView): OutputPreview {
  if (isSettled(view.state) && view.result) return { kind: "answer", text: view.result };
  for (let index = view.transcript.length - 1; index >= 0; index--) {
    const row = view.transcript[index];
    if (row?.kind === "tool" && (row.pending || row.text.trim()))
      return {
        kind: "tool",
        label: `${row.pending ? "Live output" : "Output"} · ${row.name}`,
        text: row.text || "Waiting for output…",
      };
    if (row?.kind === "assistant") {
      const text = contentText(row.message.content);
      if (text.trim()) return { kind: "answer", text };
    }
  }
  return view.result
    ? { kind: "answer", text: view.result }
    : { kind: "empty", text: view.error || "Waiting for the agent's first output…" };
}

export function elapsed(
  view: Pick<AgentView, "createdAt" | "startedAt" | "finishedAt">,
  now = Date.now(),
): string {
  const seconds = Math.max(
    0,
    Math.floor(((view.finishedAt ?? now) - (view.startedAt ?? view.createdAt)) / 1000),
  );
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function counts(views: readonly AgentView[]): {
  running: number;
  waiting: number;
  queued: number;
  finished: number;
} {
  return {
    running: views.filter(
      (view) =>
        (view.state === "running" ||
          view.state === "starting" ||
          (view.state === "queued" && !isWaiting(view))) &&
        !view.activity.startsWith("Waiting for child"),
    ).length,
    waiting: views.filter(
      (view) => view.activity.startsWith("Waiting for child") || view.state === "settling",
    ).length,
    queued: views.filter((view) => isWaiting(view)).length,
    finished: views.filter((view) => isSettled(view.state)).length,
  };
}

/** One shared visible-animation clock, stopped when no component needs it. */
class AnimationClock {
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    this.timer ??= setInterval(() => {
      for (const update of this.listeners) update();
    }, 150);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }
}

export const animationClock = new AnimationClock();

export function fit(text: string, width: number): string {
  const value = truncateToWidth(text.replace(/[\r\n\t]+/g, " "), Math.max(0, width));
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

export function between(left: string, right: string, width: number): string {
  const room = Math.max(0, width - visibleWidth(right) - 2);
  return `${fit(left, room)}  ${right}`;
}

export function agentBadge(view: Pick<AgentView, "state" | "activity">): {
  icon: string;
  label: string;
  tone: "accent" | "success" | "error" | "warning" | "muted";
} {
  if (view.state === "completed") return { icon: "✓", label: "Done", tone: "success" };
  if (view.state === "failed") return { icon: "✕", label: "Failed", tone: "error" };
  if (view.state === "cancelled") return { icon: "■", label: "Stopped", tone: "muted" };
  const label =
    view.state === "running"
      ? view.activity.startsWith("Waiting for child")
        ? "Waiting"
        : "Running"
      : isWaiting(view)
        ? "Queued"
        : view.state === "starting" || view.state === "queued"
          ? "Starting"
          : "Finishing";
  return {
    icon: ["◌", "◦", "○", "◦"][Math.floor(Date.now() / 150) % 4] ?? "◌",
    label,
    tone: label === "Queued" ? "muted" : "accent",
  };
}

export function helpLines(theme: Theme, fullscreen: boolean, width: number): string[] {
  return [
    theme.bold("Keyboard shortcuts"),
    "",
    "↑ / ↓     Select an agent or scroll the focused output",
    "Tab       Move between agents and output",
    "Enter     Open conversation",
    "d         Open details and full tool arguments",
    "s         Steer a running agent",
    "r         Resume with saved instructions",
    "R         Restart with the current definition",
    "x         Confirm stop",
    "1 / 2 / 3 All / active / finished",
    "PgUp/PgDn Scroll without following",
    "End       Follow new output",
    "[ / ]     Previous / next attempt",
    "c         Agent definitions",
    ",         Settings",
    "f         Full-pane reading in Conversation; fullscreen in Agents",
    "n         Expand or collapse routine extension notices",
    ...(fullscreen ? ["Click     Expand or collapse an individual notice"] : []),
    "Esc       Cancel, go back, or close",
  ].flatMap((line) => wrapTextWithAnsi(line, width));
}
