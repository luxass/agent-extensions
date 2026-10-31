import {
  ToolExecutionComponent,
  getMarkdownTheme,
  type Theme,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  ScrollView,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

import type { Settings } from "./agents.ts";
import { outputPreview, type OutputPreview } from "./render.ts";
import {
  contentText,
  isSettled,
  toolActivity,
  type AgentView,
  type TranscriptRow,
} from "./transcript.ts";

/**
 * Retain message bodies by row identity and label their recorded speaker.
 * Embedded bodies avoid native transcript chrome and terminal prompt markers.
 */
export class ConversationPane {
  private cache = new Map<
    string,
    { row: TranscriptRow; component: Component; width: number; lines: string[] }
  >();
  private rows?: readonly TranscriptRow[];
  private mode: Settings["viewerMarkdown"] = "assistant";
  private width = 0;
  private lines: string[] = [];
  private attemptId?: string;
  private agentName?: string;
  private reader = false;
  private expandedNotices = new Set<string>();
  private positions: { id: string; start: number; end: number; notice: boolean }[] = [];
  private anchor?: { id: string; offset: number };
  readonly scroll = new ScrollView(
    { render: () => this.lines, invalidate() {} },
    { follow: "end", scrollbar: "hidden" },
  );

  constructor(
    private readonly tui: TUI,
    private readonly cwd: string,
    private readonly theme: Theme,
  ) {}

  invalidate(): void {
    this.rows = undefined;
    for (const entry of this.cache.values()) {
      entry.component.invalidate();
      entry.width = 0;
    }
  }

  reset(): void {
    this.attemptId = undefined;
    this.rows = undefined;
    this.cache.clear();
    this.expandedNotices.clear();
    this.positions = [];
    this.anchor = undefined;
    this.scroll.scrollToEnd();
  }

  get hasNotices(): boolean {
    return this.rows?.some((row) => row.kind === "extension" && !!row.notice) ?? false;
  }

  private keepPosition(): void {
    const top = this.scroll.scrollTop;
    const row = this.positions.find((entry) => entry.start <= top && top < entry.end);
    if (row) this.anchor = { id: row.id, offset: top - row.start };
    this.scroll.scrollTo(top, { disableFollow: true });
  }

  toggleNotices(): void {
    const notices = this.rows?.filter((row) => row.kind === "extension" && !!row.notice) ?? [];
    if (!notices.length) return;
    this.keepPosition();
    const expand = notices.some((row) => !this.expandedNotices.has(row.id));
    for (const row of notices) {
      if (expand) this.expandedNotices.add(row.id);
      else this.expandedNotices.delete(row.id);
    }
    this.rows = undefined;
    this.tui.requestRender();
  }

  toggleNoticeAt(offset: number): boolean {
    const row = this.positions.find(
      (entry) => entry.notice && entry.start === this.scroll.scrollTop + offset,
    );
    if (!row) return false;
    this.keepPosition();
    if (this.expandedNotices.has(row.id)) this.expandedNotices.delete(row.id);
    else this.expandedNotices.add(row.id);
    this.rows = undefined;
    this.tui.requestRender();
    return true;
  }

  private warning(row: TranscriptRow): string | undefined {
    if (row.kind !== "assistant") return undefined;
    if (row.message.stopReason === "length")
      return "The model reached its output limit. This reply is incomplete.";
    if (row.message.content.some((part) => part.type === "toolCall")) return undefined;
    if (row.message.stopReason === "error")
      return row.message.errorMessage || "The model request failed.";
    if (row.message.stopReason === "aborted")
      return row.message.errorMessage || "The model request was cancelled.";
    return undefined;
  }

  private component(row: TranscriptRow): Component | undefined {
    if (row.kind === "user" || row.kind === "extension")
      return row.text.trim()
        ? row.kind === "user" && this.mode === "all"
          ? new Markdown(row.text, 0, 0, getMarkdownTheme(), undefined, {
              preserveOrderedListMarkers: true,
              preserveBackslashEscapes: true,
            })
          : new Text(row.text, 0, 0)
        : undefined;
    if (row.kind === "assistant") {
      const text = contentText(row.message.content).trim();
      if (!text) return this.warning(row) ? new Text("", 0, 0) : undefined;
      return this.mode === "off"
        ? new Text(text, 0, 0)
        : new Markdown(text, 0, 0, getMarkdownTheme());
    }
    if (!row.text.trim() && !row.pending) return undefined;
    // Renderer-only definitions avoid both generic JSON blocks and native tool timers.
    const renderers: ToolRenderers = {
      renderShell: "self",

      renderCall: (_args, theme, context) =>
        new Text(
          theme.fg(
            "dim",
            context.isPartial
              ? toolActivity(row.name, row.args)
              : `${row.name} · ${context.isError ? "Failed" : "Finished"}`,
          ),
          0,
          0,
        ),

      renderResult: (result, _options, theme, context) =>
        new Text(
          theme.fg(context.isError ? "error" : "toolOutput", contentText(result.content)),
          0,
          0,
        ),
    };
    const component = new ToolExecutionComponent(
      row.name,
      row.id,
      row.args,
      { showImages: false, outputPad: 0 },
      renderers,
      this.tui,
      this.cwd,
    );
    component.setArgsComplete();
    component.updateResult(
      { content: [{ type: "text", text: row.text }], isError: row.error },
      row.pending,
    );
    return component;
  }

  render(
    view: AgentView,
    width: number,
    height: number,
    mode: Settings["viewerMarkdown"] = "assistant",
    reader = false,
  ): string[] {
    if (
      this.attemptId === view.attemptId &&
      !this.scroll.isFollowingEnd &&
      (reader !== this.reader || width !== this.width || mode !== this.mode)
    )
      this.keepPosition();
    if (reader !== this.reader) {
      this.reader = reader;
      this.rows = undefined;
    }
    if (mode !== this.mode) {
      this.mode = mode;
      this.rows = undefined;
      this.cache.clear();
    }
    if (view.attemptId !== this.attemptId) {
      this.reset();
      this.attemptId = view.attemptId;
    }
    if (this.rows !== view.transcript || this.width !== width || this.agentName !== view.name) {
      this.rows = view.transcript;
      this.width = width;
      this.agentName = view.name;
      const live = new Set<string>();
      const lines: string[] = [];
      this.positions = [];
      for (const row of view.transcript) {
        live.add(row.id);
        const start = lines.length;
        const notice = row.kind === "extension" && !!row.notice;
        const title =
          row.kind === "extension" && row.notice
            ? row.notice === "turn-budget"
              ? "Final-turn reminder"
              : "Structured output request"
            : "";
        if (notice && !this.expandedNotices.has(row.id)) {
          lines.push(
            this.theme.fg("muted", truncateToWidth(`▸ Extension · ${title}  [n expand]`, width)),
            "",
          );
          this.positions.push({ id: row.id, start, end: lines.length, notice });
          continue;
        }
        let entry = this.cache.get(row.id);
        if (!entry || entry.row !== row) {
          // Update the streaming assistant in place; immutable old attempts never change.
          if (
            (entry?.component instanceof Markdown || entry?.component instanceof Text) &&
            row.kind === "assistant" &&
            contentText(row.message.content).trim()
          ) {
            entry.component.setText(contentText(row.message.content).trim());
            entry = { row, component: entry.component, width: 0, lines: [] };
          } else if (entry?.component instanceof ToolExecutionComponent && row.kind === "tool") {
            entry.component.updateResult(
              { content: [{ type: "text", text: row.text }], isError: row.error },
              row.pending,
            );
            entry = { row, component: entry.component, width: 0, lines: [] };
          } else {
            const component = this.component(row);
            entry = component ? { row, component, width: 0, lines: [] } : undefined;
          }
          if (entry) this.cache.set(row.id, entry);
          else this.cache.delete(row.id);
        }
        if (!entry) continue;
        const bodyWidth = this.reader && row.kind === "assistant" ? Math.max(1, width - 2) : width;
        if (entry.width !== bodyWidth) {
          entry.width = bodyWidth;
          entry.lines = entry.component.render(bodyWidth);
        }
        const warning = this.warning(row);
        if (!entry.lines.length && !warning) continue;
        if (row.kind !== "tool") {
          const label = truncateToWidth(
            row.kind === "assistant"
              ? this.reader
                ? "Agent"
                : `Agent · ${view.name}`
              : row.kind === "extension"
                ? notice
                  ? `▾ Extension · ${title}`
                  : "Extension"
                : "You",
            width,
          );
          const remaining = width - visibleWidth(label) - 1;
          lines.push(
            this.theme.fg(row.kind === "assistant" ? "accent" : "muted", this.theme.bold(label)) +
              (!this.reader && remaining > 0
                ? ` ${this.theme.fg("borderMuted", "─".repeat(remaining))}`
                : ""),
          );
        }
        const replyPrefix =
          this.reader && row.kind === "assistant" ? `${this.theme.fg("accent", "▎")} ` : "";
        lines.push(
          ...(row.kind === "extension" || (this.reader && row.kind === "user")
            ? entry.lines.map((line) => this.theme.fg("muted", line))
            : entry.lines.map((line) => replyPrefix + line)),
        );
        if (warning)
          lines.push(
            ...new Text(this.theme.fg("error", warning), 0, 0)
              .render(bodyWidth)
              .map((line) => replyPrefix + line),
          );
        lines.push("");
        this.positions.push({ id: row.id, start, end: lines.length, notice });
      }
      for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id);
      this.lines = lines.length
        ? lines
        : [view.transcriptLoaded ? "No conversation messages yet." : "Loading conversation…"];
    }
    this.scroll.updateLayout(this.lines.length, height, () => this.tui.requestRender());
    if (this.anchor) {
      const row = this.positions.find((entry) => entry.id === this.anchor?.id);
      if (row)
        this.scroll.scrollTo(
          row.start + Math.min(this.anchor.offset, Math.max(0, row.end - row.start - 1)),
          { disableFollow: true },
        );
      this.anchor = undefined;
    }
    return this.lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + height);
  }
}

export class PreviewPane {
  private text?: string;
  private view?: AgentView;
  private source?: OutputPreview;
  private width = 0;
  private lines: string[] = [];
  private markdown?: Markdown;
  private attemptId?: string;
  private compact = false;
  readonly scroll = new ScrollView(
    { render: () => this.lines, invalidate() {} },
    { follow: "end", scrollbar: "hidden" },
  );

  invalidate(): void {
    this.width = 0;
    this.markdown?.invalidate();
  }

  reset(): void {
    this.attemptId = undefined;
    this.scroll.scrollToEnd();
  }

  render(
    view: AgentView,
    width: number,
    height: number,
    redraw: () => void,
    compact = false,
  ): string[] {
    const selectionChanged = this.attemptId !== view.attemptId;
    const startAtAnswer =
      compact &&
      isSettled(view.state) &&
      (selectionChanged ||
        (this.scroll.isFollowingEnd &&
          (!this.compact || (this.view !== undefined && !isSettled(this.view.state)))));
    this.compact = compact;
    if (selectionChanged) {
      this.attemptId = view.attemptId;
      this.scroll.scrollToEnd();
    }
    if (this.view !== view) {
      this.view = view;
      this.source = outputPreview(view);
    }
    const source = this.source ?? outputPreview(view);
    const text = `${source.kind}\n${source.label ?? ""}\n${source.text}`;
    if (text !== this.text || width !== this.width) {
      this.text = text;
      this.width = width;
      if (source.kind === "answer") {
        this.markdown = new Markdown(source.text, 0, 0, getMarkdownTheme());
        this.lines = this.markdown.render(width);
      } else {
        this.markdown = undefined;
        this.lines = new Text(
          source.label ? `${source.label}\n\n${source.text}` : source.text,
          0,
          0,
        ).render(width);
      }
    }
    this.scroll.updateLayout(this.lines.length, height, redraw);
    if (startAtAnswer && source.kind === "answer") this.scroll.scrollToStart();
    return this.lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + height);
  }
}

/** Deliberately separate from task-first preview: identifiers and policy belong here. */
export function detailLines(view: AgentView, theme: Theme, width: number): string[] {
  const definition = view.definition;
  const tool = view.transcript.findLast((row) => row.kind === "tool");
  const args = tool?.kind === "tool" ? JSON.stringify(tool.args, null, 2) : undefined;
  const lines = [
    theme.fg("accent", "Execution"),
    `Agent: ${view.id}`,
    `Attempt: ${view.attemptNumber} · ${view.attemptId}`,
    `Owner: ${view.owner.id}${view.owner.attemptId ? ` / ${view.owner.attemptId}` : ""}`,
    `Model: ${view.model ?? definition.model ?? "default"} · thinking: ${view.thinking ?? definition.thinking ?? "default"}`,
    "",
    theme.fg("accent", "Permissions"),
    `Policy: saved instructions and tool permissions · ${definition.source}`,
    `Tools: ${definition.tools?.join(", ") ?? "inherited"}`,
    `Denied tools: ${definition.disallowedTools.join(", ") || "none"}`,
    `May delegate: ${definition.allowedSubagents.join(", ") || "none"}`,
    `Skills: ${definition.skills.join(", ") || "none"} · memory: ${definition.memory ?? "off"}`,
    "",
    theme.fg("accent", "Usage"),
    `Usage: ${view.usage.input} input · ${view.usage.output} output · $${view.usage.cost.toFixed(4)}`,
    `Cache: ${view.usage.cacheRead} read · ${view.usage.cacheWrite} write`,
    `Lifetime: ${view.lifetimeUsage.input} input · ${view.lifetimeUsage.output} output · $${view.lifetimeUsage.cost.toFixed(4)}`,
    `Turns: ${view.turns} · tool calls: ${view.toolCalls}`,
    "",
    theme.fg("accent", "Files"),
    `Session: ${view.sessionFile ?? "not available"}`,
    `Saved output: ${view.outputFile}`,
    ...(view.error ? [`Error: ${view.error}`] : []),
    ...(view.resumeBlocked ? [`Resume unavailable: ${view.resumeBlocked}`] : []),
    ...(args
      ? [
          "",
          `Latest tool: ${tool?.kind === "tool" ? tool.name : ""}`,
          args.slice(0, 12000),
          ...(args.length > 12000
            ? ["Arguments truncated here. Read the SDK session for the complete call."]
            : []),
        ]
      : []),
    "",
    "[ / ] Previous / next attempt. The current attempt is selected by default.",
  ];
  return lines.flatMap((line) => wrapTextWithAnsi(line, width));
}
