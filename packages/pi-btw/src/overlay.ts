import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";

import { answerText, type BtwState, type ToolRow } from "./session.ts";

const TOOL_ICONS = { running: "⚙", done: "✓", error: "✗" };
const TOOL_COLORS = { running: "dim", done: "success", error: "error" } as const;

interface OverlayOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  title: string;
  state: BtwState;
  onAsk: (question: string) => void;
  onEscape: () => void;
}

export function createOverlay({
  tui,
  theme,
  keybindings,
  title,
  state,
  onAsk,
  onEscape,
}: OverlayOptions): Component & Focusable {
  const input = new Input();
  let answers = new WeakMap<AssistantMessage, Markdown>();
  let scrollTop = 0;
  let followEnd = true;
  let page = 1;
  let lineCount = 0;
  let thumbTop = 0;
  let thumbHeight = 1;
  let dragOffset: number | undefined;

  function scrollTo(top: number): void {
    const maxScroll = Math.max(0, lineCount - page);
    scrollTop = Math.max(0, Math.min(maxScroll, top));
    followEnd = scrollTop === maxScroll;
    tui.requestRender();
  }

  function dragThumb(y: number, offset: number): void {
    const track = page - thumbHeight;
    const ratio = track > 0 ? (y - 1 - offset) / track : 0;
    scrollTo(Math.round(ratio * Math.max(0, lineCount - page)));
  }

  input.onSubmit = (value) => {
    const question = value.trim();
    if (!question || state.busy) return;
    input.setValue("");
    followEnd = true;
    onAsk(question);
  };

  const border = (text: string) => theme.fg("borderAccent", text);

  function markdown(answer: AssistantMessage, width: number): string[] {
    let rendered = answers.get(answer);
    if (rendered == null) {
      rendered = new Markdown(answerText(answer), 0, 0, getMarkdownTheme());
      answers.set(answer, rendered);
    }
    return rendered.render(width);
  }

  function question(text: string, width: number): string[] {
    return wrapTextWithAnsi(theme.fg("userMessageText", text), width - 2).map((line) =>
      theme.bg("userMessageBg", ` ${line}${" ".repeat(width - 2 - visibleWidth(line))} `),
    );
  }

  function answer(lines: string[]): string[] {
    return lines.map((line) => theme.fg("borderAccent", "▎ ") + line);
  }

  function tool({ name, detail, status }: ToolRow, width: number): string {
    const line = `${theme.fg(TOOL_COLORS[status], TOOL_ICONS[status])} ${theme.fg("toolTitle", name)} ${theme.fg("dim", detail)}`;
    return truncateToWidth(line, width, "…");
  }

  function transcript(width: number): string[] {
    const lines: string[] = [];
    for (const exchange of state.thread) {
      lines.push(
        ...question(exchange.question, width),
        "",
        ...answer(markdown(exchange.answer, width - 2)),
        "",
      );
    }

    const { pending } = state;
    if (pending != null) {
      lines.push(
        ...question(pending.question, width),
        "",
        ...pending.tools.map((row) => tool(row, width)),
      );
      if (pending.text)
        lines.push(...new Markdown(pending.text, 0, 0, getMarkdownTheme()).render(width));
      if (pending.error != null)
        lines.push(...wrapTextWithAnsi(theme.fg("error", pending.error), width));
      if (state.busy) lines.push("", theme.fg("dim", "answering… esc to stop"));
    }

    if (lines.length > 0) return lines;
    return wrapTextWithAnsi(
      theme.fg(
        "dim",
        "Ask a side question. The main conversation is included as context. When you close, you can keep this thread or inject a summary into the main chat.",
      ),
      width,
    );
  }

  function row(content: string, width: number, right = border("│")): string {
    const fitted = truncateToWidth(content, width, "");
    return `${border("│")} ${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))} ${right}`;
  }

  function edge(left: string, right: string, label: string, info: string, width: number): string {
    const fittedInfo = truncateToWidth(info, Math.max(0, width - 2), "");
    const fittedLabel = truncateToWidth(
      label,
      Math.max(0, width - 2 - visibleWidth(fittedInfo)),
      "…",
    );
    const fill = Math.max(0, width - visibleWidth(fittedLabel) - visibleWidth(fittedInfo) - 2);
    return (
      border(`${left}─`) + fittedLabel + border("─".repeat(fill)) + fittedInfo + border(`─${right}`)
    );
  }

  return {
    get focused() {
      return input.focused;
    },
    set focused(value: boolean) {
      input.focused = value;
    },

    render(width) {
      if (width < 5) return [truncateToWidth("btw", Math.max(0, width), "")];

      const inner = width - 2;
      const content = inner - 2;
      const height = Math.max(1, Math.floor(tui.terminal.rows * 0.8) - 4);
      page = height;

      const lines = transcript(content);
      lineCount = lines.length;
      const maxScroll = Math.max(0, lineCount - height);
      scrollTop = followEnd ? maxScroll : Math.min(scrollTop, maxScroll);
      thumbHeight = Math.max(1, Math.floor((height * height) / Math.max(height, lineCount)));
      thumbTop = maxScroll > 0 ? Math.round((scrollTop / maxScroll) * (height - thumbHeight)) : 0;
      const end = Math.min(lineCount, scrollTop + height);
      const visible = lines.slice(scrollTop, end);
      while (visible.length < height) visible.push("");
      const position = maxScroll > 0 ? ` ${scrollTop + 1}-${end}/${lineCount} ` : "";

      return [
        edge("┌", "┐", theme.fg("accent", ` btw · ${title} `), "", inner),
        ...visible.map((line, index) => {
          if (maxScroll === 0) return row(line, content);
          const thumb = index >= thumbTop && index < thumbTop + thumbHeight;
          return row(
            line,
            content,
            theme.fg(thumb ? "scrollbarThumb" : "scrollbarTrack", thumb ? "┃" : "│"),
          );
        }),
        border(`├${"─".repeat(inner)}┤`),
        row(input.render(content)[0] ?? "", content),
        edge(
          "└",
          "┘",
          theme.fg(
            "dim",
            ` enter ask · esc close · ${tui.mode === "fullscreen" ? "wheel/↑↓" : "↑↓"} scroll `,
          ),
          theme.fg("dim", position),
          inner,
        ),
      ];
    },

    handleInput(data) {
      if (keybindings.matches(data, "tui.select.cancel")) {
        onEscape();
        return;
      }
      if (keybindings.matches(data, "tui.select.up")) scrollTo(scrollTop - 1);
      else if (keybindings.matches(data, "tui.select.down")) scrollTo(scrollTop + 1);
      else if (keybindings.matches(data, "tui.select.pageUp")) scrollTo(scrollTop - page);
      else if (keybindings.matches(data, "tui.select.pageDown")) scrollTo(scrollTop + page);
      else input.handleInput(data);
      tui.requestRender();
    },

    handleMouse(event) {
      if (event.type === "wheel") {
        scrollTo(scrollTop + (event.wheelDelta ?? 0));
        return { handled: true };
      }
      if (dragOffset != null) {
        if (event.type === "drag") {
          dragThumb(event.y, dragOffset);
          return { handled: true };
        }
        if (event.type === "release") {
          dragOffset = undefined;
          return { handled: true, render: false };
        }
      }
      if (
        event.type === "press" &&
        event.button === "left" &&
        event.x === event.width - 1 &&
        event.y >= 1 &&
        event.y <= page &&
        lineCount > page
      ) {
        const thumb = event.y - 1 >= thumbTop && event.y - 1 < thumbTop + thumbHeight;
        dragOffset = thumb ? event.y - 1 - thumbTop : Math.floor(thumbHeight / 2);
        if (!thumb) dragThumb(event.y, dragOffset);
        return { handled: true, capture: true };
      }
      return undefined;
    },

    invalidate() {
      answers = new WeakMap();
    },
  };
}
