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
import { Type } from "typebox";
import { Value } from "typebox/value";

import {
  inlineView,
  type AgentService,
  type coreAgentParameters,
  type InlineView,
  type AgentParameters,
} from "./tools.ts";
import { contentText, isSettled, taskTitle, type AgentView } from "./transcript.ts";

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
  usage: Type.Object({
    input: Type.Number(),
    output: Type.Number(),
    cacheRead: Type.Number(),
    cacheWrite: Type.Number(),
    cost: Type.Number(),
  }),
});

export function plain(value: string): string {
  // oxlint-disable-next-line eslint/no-control-regex -- Keep printable text, tabs and line breaks.
  return stripTerminalSequences(value).replace(/[\x00-\x08\u000b-\x1f\u007f]/g, "");
}

function heading(
  role: string,
  task: string,
  icon: string,
  time: string,
  theme: Theme,
  width: number,
): string {
  const label = `${theme.fg("accent", icon)} ${theme.bold(plain(role))} ${theme.fg("dim", "·")} ${plain(task).replace(/\s+/g, " ")}`;
  const budget = Math.max(1, width - visibleWidth(time) - 2);
  if (width < 24) return truncateToWidth(label, width);
  const left = truncateToWidth(label, budget);
  return `${left}${" ".repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(time)))}${theme.fg("dim", time)}`;
}

/** An inline card is pinned to an attempt, not the latest run with the same handle. */
export class AgentCard implements Component {
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
    private readonly service?: AgentService,
    invalidate: () => void = () => {},
  ) {
    if (service && !isSettled(snapshot.state))
      this.unsubscribe = service.subscribe(() => {
        const current = service.attempt(snapshot.id, snapshot.attemptId);
        if (current) this.snapshot = inlineView(current);
        invalidate();
        if (isSettled(this.snapshot.state)) this.dispose();
      });
  }

  configure(expanded: boolean, theme: Theme): void {
    this.expanded = expanded;
    this.theme = theme;
  }

  render(width: number): string[] {
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
    const icon = active
      ? (["◌", "◦", "○", "◦"][Math.floor(Date.now() / 150) % 4] ?? "◌")
      : view.state === "completed"
        ? "✓"
        : view.state === "cancelled"
          ? "■"
          : "✕";
    const lines = [
      heading(view.displayName, taskTitle(view), icon, elapsed(view), this.theme, width),
    ];
    const text = active
      ? this.expanded
        ? view.result || view.activity
        : view.activity
      : view.result || view.error || (view.state === "completed" ? "Done" : "Stopped");
    if (!this.expanded) {
      const first =
        plain(text)
          .split("\n")
          .find((line) => line.trim())
          ?.trim() ?? "";
      lines.push(truncateToWidth(this.theme.fg("muted", `  ${first}`), width));
    } else {
      if (this.body !== text) {
        this.body = text;
        this.markdown = new Markdown(text, 0, 0, getMarkdownTheme());
      }
      lines.push(
        ...(this.markdown?.render(Math.max(1, width - 2)) ?? []).map((line) => `  ${line}`),
      );
      if (view.error && view.result) lines.push(this.theme.fg("error", `  ${plain(view.error)}`));
      lines.push(this.theme.fg("dim", `  @${view.name} · /agents ${view.id}`));
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
}

type Context = Parameters<
  NonNullable<ToolDefinition<typeof coreAgentParameters, unknown, InlineState>["renderCall"]>
>[2];

export function agentRenderers(service: () => AgentService | undefined, cards: Set<AgentCard>) {
  return {
    renderShell: "self" as const,

    renderCall(args: Partial<AgentParameters>, theme: Theme, context: Context): Component {
      const state = context.state;
      return {
        render: (width) =>
          state.resultSeen
            ? []
            : [
                heading(
                  args.subagent_type ?? "Agent",
                  args.description ?? args.prompt?.split("\n")[0] ?? "Preparing task…",
                  "◌",
                  "",
                  theme,
                  width,
                ),
              ],

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
      if (context.lastComponent instanceof AgentCard) {
        context.lastComponent.configure(options.expanded, theme);
        return context.lastComponent;
      }
      const details: unknown = result.details;
      if (Value.Check(Type.Object({ snapshot: inlineSchema }), details)) {
        const card = new AgentCard(details.snapshot, theme, service(), context.invalidate);
        card.configure(options.expanded, theme);
        cards.add(card);
        return card;
      }
      return new Text(
        result.content
          .flatMap((part) => (part.type === "text" ? [plain(part.text)] : []))
          .join("\n")
          .slice(0, options.expanded ? 24000 : 160),
        0,
        0,
      );
    },
  };
}

export function completionCards(
  value: unknown,
  theme: Theme,
  expanded: boolean,
): Component | undefined {
  if (!Value.Check(Type.Object({ agents: Type.Array(inlineSchema) }), value)) return undefined;
  const cards = value.agents.map((snapshot) => {
    const card = new AgentCard(snapshot, theme);
    card.configure(expanded, theme);
    return card;
  });
  return {
    render: (width) =>
      cards.flatMap((card, index) => [...(index ? [""] : []), ...card.render(width)]),

    invalidate() {
      for (const card of cards) card.invalidate();
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
        (view.state === "running" || view.state === "starting") &&
        !view.activity.startsWith("Waiting for child"),
    ).length,
    waiting: views.filter(
      (view) => view.activity.startsWith("Waiting for child") || view.state === "settling",
    ).length,
    queued: views.filter((view) => view.state === "queued").length,
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

export function agentBadge(view: AgentView): {
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
      : view.state === "queued"
        ? "Queued"
        : view.state === "starting"
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
