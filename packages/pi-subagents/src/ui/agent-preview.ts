import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, ScrollView, Text, type Component } from "@earendil-works/pi-tui";

import { isSubagentFinished, type SubagentManager, type SubagentRecord } from "../manager.ts";
import { subagentMessageText } from "../message-text.ts";
import { cleanSubagentText } from "./agent-status.ts";

/** What the preview shows for an agent: its answer, its latest tool output, or a waiting note. */
interface SubagentOutput {
  kind: "answer" | "tool" | "empty";
  text: string;
  /** Heading of a tool output, such as "Output · bash". */
  label?: string;
}

/**
 * The newest thing worth showing. A finished agent shows its answer. A working agent shows its
 * latest tool output or reply, not an earlier one.
 */
function subagentOutput(record: SubagentRecord, manager: SubagentManager): SubagentOutput {
  if (isSubagentFinished(record.status)) {
    if (record.result) return { kind: "answer", text: record.result };
    // The saved conversation can hold earlier runs, so it is not searched for a finished agent.
    return { kind: "empty", text: record.error || "No answer." };
  }
  const messages = manager.transcript(record);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "toolResult") {
      const text = subagentMessageText(message.content);
      if (text.trim()) return { kind: "tool", label: `Output · ${message.toolName}`, text };
    } else if (message?.role === "assistant") {
      const call = message.content.find((part) => part.type === "toolCall");
      // A tool call in the newest message has no result yet.
      if (call?.type === "toolCall" && index === messages.length - 1) {
        return { kind: "tool", label: `Live output · ${call.name}`, text: "Waiting for output…" };
      }
      const text = subagentMessageText(message.content);
      if (text.trim()) return { kind: "answer", text };
    }
  }
  return { kind: "empty", text: "Waiting for the agent's first output…" };
}

/**
 * The answer preview of `/agents`. It follows new output of a working agent, and starts at the
 * top of a finished answer when it has only a few lines to show it in.
 */
export class SubagentPreview {
  private lines: ReturnType<Component["render"]> = [];
  private shownText: string | undefined;
  private width = 0;
  private markdown: Markdown | undefined;
  private runKey: string | undefined;
  private wasCompact = false;
  private wasFinished = false;
  readonly scroll = new ScrollView(
    { render: () => this.lines, invalidate() {} },
    { follow: "end", scrollbar: "hidden" },
  );

  constructor(private readonly manager: SubagentManager) {}

  invalidate(): void {
    this.width = 0;
    this.markdown?.invalidate();
  }

  /** Lays the agent's newest output out in `width` columns. Returns what kind of output it is. */
  private layOut(record: SubagentRecord, width: number): "answer" | "tool" | "empty" {
    const output = subagentOutput(record, this.manager);
    const text = `${output.kind}\n${output.label ?? ""}\n${output.text}`;
    if (text !== this.shownText || width !== this.width) {
      this.shownText = text;
      this.width = width;
      if (output.kind === "answer") {
        this.markdown = new Markdown(cleanSubagentText(output.text), 0, 0, getMarkdownTheme());
        this.lines = this.markdown.render(width);
      } else {
        this.markdown = undefined;
        const plain = output.label ? `${output.label}\n\n${output.text}` : output.text;
        this.lines = new Text(cleanSubagentText(plain), 0, 0).render(width);
      }
    }
    return output.kind;
  }

  /** How many lines the agent's newest output takes in `width` columns, to size the preview. */
  lineCount(record: SubagentRecord, width: number): number {
    this.layOut(record, width);
    return this.lines.length;
  }

  /**
   * Returns at most `height` lines of `width` columns. `compact` is the preview under the list,
   * which starts at the top of a finished answer.
   */
  render(
    record: SubagentRecord,
    width: number,
    height: number,
    redraw: () => void,
    compact = false,
  ): string[] {
    const runKey = `${record.id}:${record.run}`;
    const selectionChanged = runKey !== this.runKey;
    const finished = isSubagentFinished(record.status);
    const startAtAnswer =
      compact &&
      finished &&
      (selectionChanged || (this.scroll.isFollowingEnd && (!this.wasCompact || !this.wasFinished)));
    this.wasCompact = compact;
    this.wasFinished = finished;
    if (selectionChanged) {
      this.runKey = runKey;
      this.scroll.scrollToEnd();
    }

    const kind = this.layOut(record, width);
    this.scroll.updateLayout(this.lines.length, height, redraw);
    if (startAtAnswer && kind === "answer") this.scroll.scrollToStart();
    return this.lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + height);
  }
}
