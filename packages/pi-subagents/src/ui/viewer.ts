import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import type { SubagentManager } from "../manager.ts";
import { SubagentList } from "./agent-list.ts";
import { renderAgentPanel, type AgentPanelLayout } from "./agent-panel.ts";
import { SubagentPreview } from "./agent-preview.ts";
import { cleanSubagentText, subagentStatusLabel } from "./agent-status.ts";
import { SubagentConversation } from "./conversation.ts";
import { fitLine, lineEnds } from "./text-layout.ts";

/** Reading view lines around the conversation: top border, header, two separators, footer, bottom border. */
const READING_FRAME_LINES = 6;

/** The raw input a clicked hint stands for. */
const HINT_INPUT: Record<string, string> = {
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  end: "\x1b[F",
};

/**
 * `/agents`. The first view is a panel with the agent list, its filter tabs, and the selected
 * agent's answer. Enter opens the reading view: the agent's whole conversation. The viewer only
 * reads and stops agents. There is no message input.
 */
export async function openSubagentViewer(
  ctx: ExtensionCommandContext,
  manager: SubagentManager,
): Promise<void> {
  let fullscreen = false;
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) => {
      const list = new SubagentList(theme, manager);
      const preview = new SubagentPreview(manager);
      const conversation = new SubagentConversation(tui, theme, manager, ctx.cwd);
      const redraw = () => tui.requestRender();
      let reading = false;
      let previewFocused = false;
      let dragOffset: number | undefined;
      // Where the last render drew things, for mouse events.
      let panelLayout: AgentPanelLayout | undefined;
      let readingLayout = { bodyTop: 0, bodyHeight: 0, conversationWidth: 0 };

      const unsubscribe = manager.subscribe(redraw);
      const border = (text: string) => theme.fg("borderAccent", text);

      const edge = (left: string, right: string, label: string, width: number) => {
        const fitted = truncateToWidth(label, Math.max(0, width - 4), "…");
        return (
          border(`${left}─`) +
          fitted +
          border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(fitted)))}${right}`)
        );
      };
      const row = (content: string, inner: number) => {
        const fitted = truncateToWidth(content, inner, "");
        return `${border("│")}${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))}${border("│")}`;
      };

      const renderReading = (width: number): string[] => {
        const inner = Math.max(10, width - 2);
        const height = Math.max(
          READING_FRAME_LINES + 3,
          fullscreen ? tui.terminal.rows : Math.floor(tui.terminal.rows * 0.85),
        );
        const bodyHeight = height - READING_FRAME_LINES;
        const record = list.selected();
        conversation.sync(record);
        readingLayout = { bodyTop: 3, bodyHeight, conversationWidth: inner };

        const title = record ? ` ${record.name} · ${record.agentType} ` : " Agents ";
        // One space of padding at each side of the header and the footer.
        const textWidth = Math.max(1, inner - 2);
        const dot = theme.fg("muted", "·");
        // The status stays at the right. In a narrow terminal the model is what gets cut.
        const header = record
          ? lineEnds(
              [
                theme.bold(record.name),
                ...(record.error
                  ? [theme.fg("error", cleanSubagentText(record.error).split("\n")[0] ?? "")]
                  : []),
                record.model || "model pending",
                `thinking ${record.thinking}`,
              ].join(` ${dot} `),
              subagentStatusLabel(record),
              textWidth,
            )
          : fitLine(theme.fg("dim", "No agent selected."), textWidth);

        // "Esc Back" stays at the right. The other hints are added while they fit, so a narrow
        // terminal drops whole hints and never the way out.
        const expand = keybindings.getKeys("app.tools.expand")[0] ?? "ctrl+o";
        const back = textWidth < 28 ? "Esc" : "Esc Back";
        const budget = Math.max(0, textWidth - visibleWidth(back) - 2);
        let hints = "";
        for (const hint of [
          "↑↓ Scroll",
          "t/T Tool",
          "Enter Expand",
          `${expand} All tools`,
          fullscreen ? "f Floating" : "f Fullscreen",
        ]) {
          const gap = hints ? "   " : "";
          if (visibleWidth(hints + gap + hint) > budget) break;
          hints += gap + hint;
        }
        return [
          edge("┌", "┐", theme.fg("accent", title), width),
          row(` ${header}`, inner),
          border(`├${"─".repeat(inner)}┤`),
          ...conversation.render(inner, bodyHeight).map((line) => row(line, inner)),
          border(`├${"─".repeat(inner)}┤`),
          row(` ${theme.fg("dim", lineEnds(hints, back, textWidth))}`, inner),
          border(`└${"─".repeat(inner)}┘`),
        ];
      };

      const openReading = () => {
        if (!list.selected()) return;
        reading = true;
        // The conversation takes the whole terminal, and Esc gives the panel its size back.
        fullscreen = true;
      };

      const handleReadingInput = (data: string) => {
        if (keybindings.matches(data, "tui.select.cancel")) {
          reading = false;
          fullscreen = false;
          previewFocused = false;
        } else if (data === "f") fullscreen = !fullscreen;
        else if (keybindings.matches(data, "app.tools.expand")) conversation.toggleAllTools();
        else if (keybindings.matches(data, "tui.select.pageUp"))
          conversation.scrollBy(-conversation.page);
        else if (keybindings.matches(data, "tui.select.pageDown"))
          conversation.scrollBy(conversation.page);
        else if (matchesKey(data, "home")) conversation.scrollTo(0);
        else if (matchesKey(data, "end")) conversation.follow();
        else if (data === "t") conversation.selectTool(1);
        else if (data === "T" || matchesKey(data, "shift+t")) conversation.selectTool(-1);
        else if (keybindings.matches(data, "tui.select.confirm")) conversation.toggleSelectedTool();
        else if (keybindings.matches(data, "tui.select.up")) conversation.scrollBy(-1);
        else if (keybindings.matches(data, "tui.select.down")) conversation.scrollBy(1);
      };

      /** Scrolls the answer and stops following new output. */
      const scrollPreview = (lines: number) => {
        preview.scroll.scrollTo(preview.scroll.scrollTop + lines, { disableFollow: true });
      };

      const handlePanelInput = (data: string) => {
        if (list.stopTarget()) {
          const yes = data === "y" || keybindings.matches(data, "tui.select.confirm");
          const no = data === "n" || keybindings.matches(data, "tui.select.cancel");
          if (yes || no) void list.confirmStop(yes).then(redraw);
          return;
        }
        const page = Math.max(1, preview.scroll.viewportHeight - 2);
        if (keybindings.matches(data, "tui.select.cancel")) done();
        else if (data === "f") fullscreen = !fullscreen;
        else if (matchesKey(data, "tab")) previewFocused = !previewFocused;
        else if (data === "1") list.setFilter("all");
        else if (data === "2") list.setFilter("active");
        else if (data === "3") list.setFilter("finished");
        else if (keybindings.matches(data, "tui.select.confirm")) openReading();
        else if (data === "x") list.askStop();
        else if (keybindings.matches(data, "tui.select.up")) {
          if (previewFocused) scrollPreview(-1);
          else list.move(-1);
        } else if (keybindings.matches(data, "tui.select.down")) {
          if (previewFocused) scrollPreview(1);
          else list.move(1);
        } else if (keybindings.matches(data, "tui.select.pageUp")) scrollPreview(-page);
        else if (keybindings.matches(data, "tui.select.pageDown")) scrollPreview(page);
        else if (matchesKey(data, "end")) preview.scroll.scrollToEnd();
        else if (matchesKey(data, "home")) preview.scroll.scrollToStart();
      };

      const handleInput = (data: string) => {
        if (reading) handleReadingInput(data);
        else handlePanelInput(data);
        redraw();
      };

      /** A click on a hint acts like its key. */
      const press = (key: string) => handleInput(HINT_INPUT[key] ?? key);

      // Pi routes mouse events only in fullscreen terminal mode. Every action also has a key.
      const handlePanelMouse = (event: TuiMouseEvent): TuiMouseEventResult => {
        const layout = panelLayout;
        if (!layout) return { handled: true, render: false };
        const overList =
          event.y >= layout.bodyY &&
          event.y < layout.bodyY + layout.listHeight &&
          (!layout.wide || event.x < layout.contentX + layout.listWidth);
        if (event.type === "wheel") {
          if (!list.stopTarget()) {
            if (overList) list.move(Math.sign(event.wheelDelta ?? 0));
            else scrollPreview(event.wheelDelta ?? 0);
          }
          return { handled: true, render: true };
        }
        // The panel takes every mouse event over it, so none reaches the chat behind.
        if (event.type !== "click" || event.button !== "left") {
          return { handled: true, render: false };
        }
        const hitAt = <Hit extends { start: number; end: number }>(hits: Hit[]) =>
          hits.find((hit) => event.x >= hit.start && event.x < hit.end);

        if (event.y === layout.footerY) {
          const hint = hitAt(layout.actionHits);
          if (hint) press(hint.key);
        } else if (!list.stopTarget()) {
          if (event.y === layout.headerY && event.x >= layout.expandX) press("f");
          else if (event.y === layout.filterY) {
            const view = hitAt(layout.navHits);
            const tab = hitAt(layout.filterHits);
            if (view) press(view.key);
            else if (tab) list.setFilter(tab.filter);
          } else if (overList) {
            const id = list.idAtLine(event.y - layout.bodyY);
            if (id) {
              list.select(id);
              previewFocused = false;
              if ((event.clickCount ?? 1) > 1) press("enter");
            }
          } else previewFocused = true;
        }
        return { handled: true, render: true };
      };

      const handleReadingMouse = (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
        const line = event.y - readingLayout.bodyTop;
        const inBody = line >= 0 && line < readingLayout.bodyHeight;
        const inConversation = event.x >= 1 && event.x <= readingLayout.conversationWidth;
        const onScrollbar = event.x === readingLayout.conversationWidth;

        if (dragOffset !== undefined) {
          if (event.type === "drag") {
            conversation.dragTo(line, dragOffset);
            return { handled: true };
          }
          if (event.type === "release") {
            dragOffset = undefined;
            return { handled: true, render: false };
          }
        }
        if (event.type === "wheel") {
          // The viewer takes every wheel event over it. An unhandled one scrolls the chat behind.
          if (inBody && inConversation) conversation.scrollBy(event.wheelDelta ?? 0);
          return { handled: true };
        }
        if (event.type !== "press" || event.button !== "left" || !inBody) return undefined;
        if (onScrollbar && conversation.lineCount > conversation.page) {
          const onThumb =
            line >= conversation.thumbTop &&
            line < conversation.thumbTop + conversation.thumbHeight;
          dragOffset = onThumb
            ? line - conversation.thumbTop
            : Math.floor(conversation.thumbHeight / 2);
          if (!onThumb) conversation.dragTo(line, dragOffset);
          return { handled: true, capture: true };
        }
        if (inConversation && conversation.toggleToolAtLine(line)) return { handled: true };
        return undefined;
      };

      const component: Component & { dispose(): void } = {
        render(width) {
          if (reading) return renderReading(width);
          const panel = renderAgentPanel(
            { theme, tui, list, preview, fullscreen, previewFocused, redraw },
            width,
          );
          panelLayout = panel.layout;
          return panel.lines;
        },
        handleInput,
        handleMouse(event: TuiMouseEvent) {
          return reading ? handleReadingMouse(event) : handlePanelMouse(event);
        },
        invalidate() {
          preview.invalidate();
          conversation.invalidate();
        },
        dispose() {
          unsubscribe();
        },
      };
      return component;
    },
    {
      overlay: true,
      // Pi reads these once, but the TUI reads the getters on every render, so `f` resizes the
      // open overlay. The rendered line count sets the height.
      overlayOptions: {
        anchor: "center",
        maxHeight: "100%",
        get width() {
          return fullscreen ? "100%" : 128;
        },
        get margin() {
          return fullscreen ? 0 : 1;
        },
      },
    },
  );
}
