import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";

import type { SubagentManager } from "../manager.ts";
import { SubagentList } from "./agent-list.ts";
import { cleanSubagentText, subagentStatusLabel } from "./agent-status.ts";
import { SubagentConversation } from "./conversation.ts";

const LIST_WIDTH = 34;
/** Lines around the body: top border, header, separator, footer separator, footer, bottom border. */
const FRAME_LINES = 6;

/**
 * `/agents`: the agent list beside the selected conversation, or the conversation alone in the
 * reading view. It only reads and stops agents. There is no message input (S8).
 */
export async function openSubagentViewer(
  ctx: ExtensionCommandContext,
  manager: SubagentManager,
): Promise<void> {
  let fullscreen = false;
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) => {
      const list = new SubagentList(theme, manager);
      const conversation = new SubagentConversation(tui, theme, manager, ctx.cwd);
      let reading = false;
      let focus: "list" | "conversation" = "list";
      let dragOffset: number | undefined;
      // Where the last render drew each pane, for mouse events.
      let layout = {
        bodyTop: 0,
        bodyHeight: 0,
        listWidth: 0,
        conversationLeft: 0,
        conversationWidth: 0,
      };

      const unsubscribe = manager.subscribe(() => tui.requestRender());
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

      const footer = () => {
        const record = list.selected();
        if (record && list.confirmStopId === record.id) {
          return theme.fg(
            "warning",
            ` Press x again to stop ${record.name}. Any other key cancels.`,
          );
        }
        const expand = keybindings.getKeys("app.tools.expand")[0] ?? "ctrl+o";
        const parts =
          reading || focus === "conversation"
            ? [
                "↑↓ scroll",
                "t/T tool",
                "enter expand",
                `${expand} all tools`,
                ...(reading ? [] : ["tab list"]),
                fullscreen ? "f floating" : "f fullscreen",
                reading ? "esc back" : "esc close",
              ]
            : [
                "↑↓ select",
                "enter read",
                "tab conversation",
                "x stop",
                fullscreen ? "f floating" : "f fullscreen",
                "esc close",
              ];
        return theme.fg("dim", ` ${parts.join(" · ")}`);
      };

      const component: Component & { dispose(): void } = {
        render(width) {
          const inner = Math.max(10, width - 2);
          const height = Math.max(
            FRAME_LINES + 3,
            fullscreen ? tui.terminal.rows : Math.floor(tui.terminal.rows * 0.85),
          );
          const bodyHeight = height - FRAME_LINES;
          const record = list.selected();
          conversation.sync(record);

          const title = reading && record ? ` ${record.name} · ${record.agentType} ` : " Agents ";
          const header = record
            ? ` ${theme.bold(record.name)} ${theme.fg("muted", "·")} ${record.model || "model pending"} ${theme.fg("muted", "·")} thinking ${record.thinking} ${theme.fg("muted", "·")} ${subagentStatusLabel(record)}${record.error ? ` ${theme.fg("error", cleanSubagentText(record.error).split("\n")[0] ?? "")}` : ""}`
            : theme.fg("dim", " No agent selected.");

          const lines = [edge("┌", "┐", theme.fg("accent", title), width), row(header, inner)];
          if (reading) {
            layout = {
              bodyTop: 3,
              bodyHeight,
              listWidth: 0,
              conversationLeft: 1,
              conversationWidth: inner,
            };
            lines.push(border(`├${"─".repeat(inner)}┤`));
            for (const line of conversation.render(inner, bodyHeight)) lines.push(row(line, inner));
          } else {
            const listWidth = Math.min(LIST_WIDTH, Math.floor(inner * 0.4));
            const conversationWidth = inner - listWidth - 1;
            layout = {
              bodyTop: 3,
              bodyHeight,
              listWidth,
              conversationLeft: listWidth + 2,
              conversationWidth,
            };
            lines.push(border(`├${"─".repeat(listWidth)}┬${"─".repeat(conversationWidth)}┤`));
            const left = list.render(listWidth, bodyHeight, focus === "list");
            const right = conversation.render(conversationWidth, bodyHeight);
            for (let index = 0; index < bodyHeight; index++) {
              const conversationLine = truncateToWidth(right[index] ?? "", conversationWidth, "");
              const padding = " ".repeat(
                Math.max(0, conversationWidth - visibleWidth(conversationLine)),
              );
              lines.push(
                `${border("│")}${left[index] ?? ""}${border("│")}${conversationLine}${padding}${border("│")}`,
              );
            }
            lines.push(border(`├${"─".repeat(listWidth)}┴${"─".repeat(conversationWidth)}┤`));
            lines.push(row(footer(), inner));
            lines.push(border(`└${"─".repeat(inner)}┘`));
            return lines;
          }
          lines.push(border(`├${"─".repeat(inner)}┤`));
          lines.push(row(footer(), inner));
          lines.push(border(`└${"─".repeat(inner)}┘`));
          return lines;
        },

        handleInput(data) {
          const confirming = list.confirmStopId !== undefined;
          if (confirming && data !== "x") list.confirmStopId = undefined;

          if (keybindings.matches(data, "tui.select.cancel")) {
            if (confirming) {
              // Esc only cancels the pending stop.
            } else if (reading) reading = false;
            else done();
          } else if (data === "f") {
            fullscreen = !fullscreen;
          } else if (keybindings.matches(data, "app.tools.expand")) {
            conversation.toggleAllTools();
          } else if (keybindings.matches(data, "tui.select.pageUp")) {
            // These four keys scroll the conversation from either pane (S8). The list only takes
            // Up and Down, so End can follow new output again without changing focus.
            conversation.scrollBy(-conversation.page);
          } else if (keybindings.matches(data, "tui.select.pageDown")) {
            conversation.scrollBy(conversation.page);
          } else if (matchesKey(data, "home")) {
            conversation.scrollTo(0);
          } else if (matchesKey(data, "end")) {
            conversation.follow();
          } else if (!reading && matchesKey(data, "tab")) {
            focus = focus === "list" ? "conversation" : "list";
          } else if (!reading && focus === "list") {
            if (keybindings.matches(data, "tui.select.up")) list.move(-1);
            else if (keybindings.matches(data, "tui.select.down")) list.move(1);
            else if (keybindings.matches(data, "tui.select.confirm") && list.selected())
              reading = true;
            else if (data === "x") void list.pressStop().then(() => tui.requestRender());
          } else if (data === "t") conversation.selectTool(1);
          else if (data === "T" || matchesKey(data, "shift+t")) conversation.selectTool(-1);
          else if (keybindings.matches(data, "tui.select.confirm"))
            conversation.toggleSelectedTool();
          else if (keybindings.matches(data, "tui.select.up")) conversation.scrollBy(-1);
          else if (keybindings.matches(data, "tui.select.down")) conversation.scrollBy(1);
          tui.requestRender();
        },

        // Pi routes mouse events only in fullscreen terminal mode. Every action also has a key (S8).
        handleMouse(event: TuiMouseEvent) {
          const line = event.y - layout.bodyTop;
          const inBody = line >= 0 && line < layout.bodyHeight;
          const inConversation =
            event.x >= layout.conversationLeft &&
            event.x < layout.conversationLeft + layout.conversationWidth;
          const onScrollbar = event.x === layout.conversationLeft + layout.conversationWidth - 1;

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
            const overList = !reading && inBody && event.x >= 1 && event.x <= layout.listWidth;
            if (overList) list.move(Math.sign(event.wheelDelta ?? 0));
            else if (inBody && inConversation) conversation.scrollBy(event.wheelDelta ?? 0);
            return { handled: true };
          }
          if (event.type !== "press" || event.button !== "left" || !inBody) return undefined;
          if (!reading && event.x >= 1 && event.x <= layout.listWidth) {
            const id = list.idAtLine(line);
            if (!id) return undefined;
            list.select(id);
            focus = "list";
            return { handled: true };
          }
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
        },

        invalidate() {
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
          return fullscreen ? "100%" : "90%";
        },
        get margin() {
          return fullscreen ? 0 : 1;
        },
      },
    },
  );
}
