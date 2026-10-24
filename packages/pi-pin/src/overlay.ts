import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Markdown,
  matchesKey,
  ScrollView,
  SelectList,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";

import { messageTitle, type PinMessage } from "./state.ts";

export interface PinAction {
  action: "pin" | "unpin" | "goto";
  id: string;
}

interface OverlayOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  messages: PinMessage[];
  pinnedOnly: boolean;
  initialId?: string;
  done: (action: PinAction | undefined) => void;
}

export function createOverlay({
  tui,
  theme,
  keybindings,
  messages,
  pinnedOnly,
  initialId,
  done,
}: OverlayOptions): Component & Focusable {
  const input = new Input();
  let preview = messages.find((message) => message.id === initialId);
  let markdown: Markdown | undefined;
  let page = 1;
  const scroll = new ScrollView(
    {
      render: (width) => {
        markdown ??= new Markdown(
          stripTerminalSequences(preview?.text ?? ""),
          0,
          0,
          getMarkdownTheme(),
        );
        return markdown.render(width);
      },
      invalidate: () => {
        markdown = undefined;
      },
    },
    { scrollbar: "hidden" },
  );

  function show(message: PinMessage): void {
    preview = message;
    markdown = undefined;
    scroll.scrollToStart();
    tui.requestRender();
  }

  let visibleRows = 1;
  function buildList(selectedId?: string): SelectList {
    const query = input.getValue().trim().toLowerCase();
    const filtered = messages.filter((message) =>
      `${message.id} ${message.role} ${message.label ?? ""} ${message.text}`
        .toLowerCase()
        .includes(query),
    );
    const result = new SelectList(
      filtered.map((message) => ({
        value: message.id,
        label: stripTerminalSequences(
          `${message.pinned ? "★ " : ""}${message.role} · ${message.id}`,
        ),
        description: truncateToWidth(stripTerminalSequences(messageTitle(message)), 160),
      })),
      visibleRows,
      {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: () => theme.fg("warning", "No matching messages"),
      },
    );
    result.onSelect = (item) => {
      const message = messages.find((candidate) => candidate.id === item.value);
      if (message) show(message);
    };
    result.onCancel = () => done(undefined);
    const selectedIndex = filtered.findIndex((message) => message.id === selectedId);
    if (selectedIndex >= 0) result.setSelectedIndex(selectedIndex);
    return result;
  }
  let list = buildList(initialId);

  function act(action: PinAction["action"]): void {
    const id = preview?.id ?? list.getSelectedItem()?.value;
    if (id) done({ action, id });
  }

  function row(text: string, width: number): string {
    const fitted = truncateToWidth(text, width - 4, "");
    return (
      theme.fg("borderAccent", "│ ") +
      fitted +
      " ".repeat(Math.max(0, width - 4 - visibleWidth(fitted))) +
      theme.fg("borderAccent", " │")
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
      if (width < 5) return [truncateToWidth("pins", Math.max(0, width), "")];
      const maxHeight = Math.max(1, Math.floor(tui.terminal.rows * 0.8));
      if (maxHeight < 7) return [truncateToWidth("Pins: resize terminal or Esc to close", width)];
      page = maxHeight - 5;
      const inner = width - 4;
      let content: string[];
      let title: string;
      let help: string;
      if (preview) {
        const lines = scroll.render(inner);
        scroll.updateLayout(lines.length, page, () => tui.requestRender());
        content = lines.slice(scroll.scrollTop, scroll.scrollTop + page);
        title = `${preview.pinned ? "Pinned" : "Message"} · ${preview.role} · ${preview.id}`;
        help = `Ctrl+P ${preview.pinned ? "unpin" : "pin"} · Ctrl+G go to · Esc back · ↑↓ scroll`;
      } else {
        if (visibleRows !== page - 1) {
          visibleRows = Math.max(1, page - 1);
          list = buildList(list.getSelectedItem()?.value);
        }
        content = list.render(inner).slice(0, page);
        title = pinnedOnly ? `Pins · ${messages.length}` : "Pin a message";
        help = "Type to search · ↑↓ select · Enter preview · Ctrl+P pin/unpin · Esc close";
      }
      while (content.length < page) content.push("");
      const heading = truncateToWidth(stripTerminalSequences(` ${title} `), width - 2, "…");
      return [
        theme.fg("borderAccent", "┌") +
          theme.fg("accent", heading) +
          theme.fg("borderAccent", `${"─".repeat(width - 2 - visibleWidth(heading))}┐`),
        row(preview ? preview.timestamp : "Search messages", width),
        row(preview ? "" : (input.render(inner)[0] ?? ""), width),
        ...content.map((line) => row(line, width)),
        row(theme.fg("dim", help), width),
        theme.fg("borderAccent", `└${"─".repeat(width - 2)}┘`),
      ];
    },
    handleInput(data) {
      if (keybindings.matches(data, "tui.select.cancel")) {
        if (preview) {
          preview = undefined;
          markdown = undefined;
        } else done(undefined);
      } else if (matchesKey(data, "ctrl+p")) {
        const selected =
          preview ?? messages.find((message) => message.id === list.getSelectedItem()?.value);
        if (selected) act(selected.pinned ? "unpin" : "pin");
      } else if (preview) {
        if (matchesKey(data, "ctrl+g")) act("goto");
        else if (keybindings.matches(data, "tui.select.up")) scroll.scrollBy(-1);
        else if (keybindings.matches(data, "tui.select.down")) scroll.scrollBy(1);
        else if (keybindings.matches(data, "tui.select.pageUp")) scroll.scrollBy(-page);
        else if (keybindings.matches(data, "tui.select.pageDown")) scroll.scrollBy(page);
        else if (matchesKey(data, "home")) scroll.scrollToStart();
        else if (matchesKey(data, "end")) scroll.scrollToEnd();
      } else if (
        keybindings.matches(data, "tui.select.up") ||
        keybindings.matches(data, "tui.select.down") ||
        keybindings.matches(data, "tui.select.pageUp") ||
        keybindings.matches(data, "tui.select.pageDown") ||
        keybindings.matches(data, "tui.select.confirm")
      ) {
        list.handleInput(data);
      } else {
        const previous = input.getValue();
        input.handleInput(data);
        if (input.getValue() !== previous) list = buildList();
      }
      tui.requestRender();
    },
    handleMouse(event) {
      if (preview && event.type === "wheel") {
        scroll.scrollBy(event.wheelDelta ?? 0);
        return { handled: true };
      }
      if (!preview && event.y >= 3 && event.y < 3 + page) {
        return list.handleMouse({
          ...event,
          y: event.y - 3,
          height: page,
          x: event.x - 2,
          width: event.width - 4,
        });
      }
      return undefined;
    },
    invalidate() {
      markdown = undefined;
      input.invalidate();
      list.invalidate();
    },
  };
}
