import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
  type AgentSession,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

import type { SubagentManager, SubagentRecord } from "../manager.ts";
import { cleanSubagentText, cleanSubagentValue } from "./agent-status.ts";

type TranscriptMessage = AgentSession["messages"][number];
/** Whatever ToolExecutionComponent accepts to draw a call: a tool definition or its renderers. */
type ToolDrawing = ConstructorParameters<typeof ToolExecutionComponent>[4];

// Pi's chat marks some lines with OSC sequences. Inside a framed pane they break the frame.
// oxlint-disable-next-line no-control-regex -- removing OSC terminal sequences is the point.
const OSC_SEQUENCES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

interface Block {
  component: Component;
  toolCallId?: string;
}

/** A transcript line range that a click expands or collapses. */
interface ToolRow {
  start: number;
  end: number;
  toolCallId: string;
}

function textOf(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");
}

/**
 * Read-only conversation of one agent, drawn with Pi's own message and tool components (S8).
 * It follows new output while at the bottom and counts what arrives while scrolled up.
 */
export class SubagentConversation {
  private blocks: Block[] = [];
  private tools = new Map<string, ToolExecutionComponent>();
  private toolRows: ToolRow[] = [];
  private expanded = new Set<string>();
  private allExpanded = false;
  private recordId: string | undefined;
  private version = "";
  private messageCount = 0;
  private seenMessages = 0;
  private readonly builtinTools: Record<string, ToolDrawing>;

  scrollTop = 0;
  following = true;
  lineCount = 0;
  page = 1;
  thumbTop = 0;
  thumbHeight = 1;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly manager: SubagentManager,
    private readonly cwd: string,
  ) {
    // Finished agents have no live tools, so their calls use Pi's built-in renderers when possible.
    this.builtinTools = {
      read: createReadToolDefinition(cwd),
      bash: createBashToolDefinition(cwd),
      edit: createEditToolDefinition(cwd),
      write: createWriteToolDefinition(cwd),
      grep: createGrepToolDefinition(cwd),
      find: createFindToolDefinition(cwd),
      ls: createLsToolDefinition(cwd),
    };
  }

  /** New messages that arrived while scrolled up. */
  get unseen(): number {
    return Math.max(0, this.messageCount - this.seenMessages);
  }

  /** Rebuilds the components when the selected agent or its transcript changed. */
  sync(record: SubagentRecord | undefined): void {
    if (record?.id !== this.recordId) {
      this.recordId = record?.id;
      this.version = "";
      this.following = true;
      this.scrollTop = 0;
      this.expanded.clear();
      this.allExpanded = false;
    }
    if (!record) {
      this.blocks = [];
      this.messageCount = this.seenMessages = 0;
      return;
    }
    const messages = this.manager.transcript(record);
    const version = `${record.run}:${record.status}:${messages.length}:${record.turns}:${record.toolUses}`;
    if (version === this.version) return;
    this.version = version;
    this.build(record, messages);
    this.messageCount = messages.length;
    if (this.following) this.seenMessages = this.messageCount;
  }

  private build(record: SubagentRecord, messages: readonly TranscriptMessage[]): void {
    const markdownTheme = getMarkdownTheme();
    this.blocks = [];
    this.tools.clear();
    for (const message of messages) {
      if (message.role === "user") {
        const text = cleanSubagentText(textOf(message.content));
        if (text.trim())
          this.blocks.push({ component: new UserMessageComponent(text, markdownTheme) });
      } else if (message.role === "assistant") {
        const content = message.content.map((part) =>
          part.type === "text"
            ? { ...part, text: cleanSubagentText(part.text) }
            : part.type === "thinking"
              ? { ...part, thinking: cleanSubagentText(part.thinking) }
              : part,
        );
        if (content.some((part) => part.type !== "toolCall")) {
          this.blocks.push({
            component: new AssistantMessageComponent({ ...message, content }, false, markdownTheme),
          });
        }
        for (const part of message.content) {
          if (part.type !== "toolCall") continue;
          const definition =
            this.manager.toolDefinition(record, part.name) ?? this.builtinTools[part.name];
          // Arguments come from the agent's model, and renderers print them as they are (S8).
          const tool = new ToolExecutionComponent(
            cleanSubagentText(part.name),
            part.id,
            cleanSubagentValue(part.arguments),
            {},
            definition,
            this.tui,
            this.cwd,
          );
          tool.markExecutionStarted();
          tool.setArgsComplete();
          tool.setExpanded(this.allExpanded || this.expanded.has(part.id));
          this.tools.set(part.id, tool);
          this.blocks.push({ component: tool, toolCallId: part.id });
        }
      } else if (message.role === "toolResult") {
        this.tools.get(message.toolCallId)?.updateResult(
          {
            content: message.content.map((part) =>
              part.type === "text" ? { ...part, text: cleanSubagentText(part.text) } : part,
            ),
            details: cleanSubagentValue(message.details),
            isError: message.isError,
            durationMs: message.durationMs,
          },
          false,
        );
      } else if (message.role === "custom" && message.display) {
        const text = cleanSubagentText(textOf(message.content));
        if (text.trim())
          this.blocks.push({ component: new Text(this.theme.fg("muted", text), 1, 0) });
      }
    }
  }

  /** Expands or collapses every tool call, from Pi's expand key (S8). */
  toggleAllTools(): void {
    this.allExpanded = !this.allExpanded;
    this.expanded.clear();
    for (const tool of this.tools.values()) tool.setExpanded(this.allExpanded);
  }

  /** Expands or collapses the tool call drawn at a viewport line, for mouse clicks (S8). */
  toggleToolAtLine(viewportLine: number): boolean {
    const line = this.scrollTop + viewportLine;
    const row = this.toolRows.find((candidate) => line >= candidate.start && line < candidate.end);
    const tool = row && this.tools.get(row.toolCallId);
    if (!row || !tool) return false;
    const open = this.allExpanded || this.expanded.has(row.toolCallId);
    if (this.allExpanded) {
      // Collapsing one call after expanding all keeps the others open.
      this.allExpanded = false;
      for (const id of this.tools.keys()) this.expanded.add(id);
    }
    if (open) this.expanded.delete(row.toolCallId);
    else this.expanded.add(row.toolCallId);
    tool.setExpanded(!open);
    return true;
  }

  scrollTo(top: number): void {
    const maxScroll = Math.max(0, this.lineCount - this.page);
    this.scrollTop = Math.max(0, Math.min(maxScroll, top));
    this.following = this.scrollTop >= maxScroll;
    if (this.following) this.seenMessages = this.messageCount;
  }

  scrollBy(delta: number): void {
    this.scrollTo(this.scrollTop + delta);
  }

  /** Jumps to the end and follows new output again (End). */
  follow(): void {
    this.following = true;
    this.scrollTo(Number.MAX_SAFE_INTEGER);
  }

  /** Moves the scrollbar thumb to a viewport line while dragging. */
  dragTo(viewportLine: number, thumbOffset: number): void {
    const track = this.page - this.thumbHeight;
    const ratio = track > 0 ? (viewportLine - thumbOffset) / track : 0;
    this.scrollTo(Math.round(ratio * Math.max(0, this.lineCount - this.page)));
  }

  /** Renders exactly `height` lines. The last column is the scrollbar. */
  render(width: number, height: number): string[] {
    const contentWidth = Math.max(1, width - 1);
    const lines: string[] = [];
    this.toolRows = [];
    for (const block of this.blocks) {
      if (lines.length) lines.push("");
      const start = lines.length;
      lines.push(
        ...block.component.render(contentWidth).map((line) => line.replace(OSC_SEQUENCES, "")),
      );
      if (block.toolCallId)
        this.toolRows.push({ start, end: lines.length, toolCallId: block.toolCallId });
    }
    if (!lines.length) lines.push(this.theme.fg("dim", "No messages yet."));

    const marker = !this.following && this.unseen > 0;
    this.page = Math.max(1, height - (marker ? 1 : 0));
    this.lineCount = lines.length;
    const maxScroll = Math.max(0, this.lineCount - this.page);
    this.scrollTop = this.following ? maxScroll : Math.min(this.scrollTop, maxScroll);
    this.thumbHeight = Math.max(
      1,
      Math.floor((this.page * this.page) / Math.max(this.page, this.lineCount)),
    );
    this.thumbTop =
      maxScroll > 0 ? Math.round((this.scrollTop / maxScroll) * (this.page - this.thumbHeight)) : 0;

    const visible = lines.slice(this.scrollTop, this.scrollTop + this.page);
    while (visible.length < this.page) visible.push("");
    const rows = visible.map((line, index) => {
      const fitted = truncateToWidth(line, contentWidth, "");
      const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)));
      if (maxScroll === 0) return `${fitted}${padding} `;
      const thumb = index >= this.thumbTop && index < this.thumbTop + this.thumbHeight;
      return `${fitted}${padding}${this.theme.fg(thumb ? "scrollbarThumb" : "scrollbarTrack", thumb ? "┃" : "│")}`;
    });
    if (marker) {
      const text = `↓ ${this.unseen} new message${this.unseen === 1 ? "" : "s"} (end to follow)`;
      rows.push(truncateToWidth(this.theme.fg("accent", text), width, ""));
    }
    return rows;
  }

  invalidate(): void {
    for (const block of this.blocks) block.component.invalidate();
  }
}
