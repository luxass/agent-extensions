import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  Key,
  matchesKey,
  ScrollView,
  truncateToWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import { keyLabels } from "./key-labels.ts";
import { captureResourceLoader } from "./loader-hook.ts";
import { collectResources } from "./resources.ts";
import {
  EXPANDABLE,
  fit,
  RESOURCE_TABS,
  type ResourceTab,
  renderTabBody,
  TAB_LABELS,
  tabCount,
  tabSummary,
  tabUnit,
} from "./tabs.ts";

export default function (pi: ExtensionAPI) {
  const capture = captureResourceLoader("resources");
  pi.on("session_shutdown", () => capture.dispose());

  pi.registerCommand("resources", {
    description: "Browse resources and registered tools in a tabbed dialog",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      const resourceLoader = capture.read();
      if (!resourceLoader) {
        ctx.ui.notify(
          "Could not capture Pi's resource loader. Reload Pi before using /resources.",
          "error",
        );
        return;
      }
      const resources = collectResources(pi, {
        ctx,
        loader: resourceLoader,
      });

      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => {
          let tab = 0;
          let page = 1;
          let mouseWidth = 0;
          let targets: { index: number; start: number; end: number }[] = [];
          const details: Partial<Record<ResourceTab, boolean>> = {};

          const first = (action: Parameters<typeof keybindings.getKeys>[0]) =>
            keybindings.getKeys(action).slice(0, 1);
          const closeKeys = keyLabels([
            ...first("tui.select.cancel"),
            ...first("tui.select.confirm"),
            "q",
          ]);
          const scrollKeys = keyLabels([...first("tui.select.up"), ...first("tui.select.down")]);
          const pageKeys = keyLabels([
            ...first("tui.select.pageUp"),
            ...first("tui.select.pageDown"),
          ]);

          const scroll = new ScrollView(
            {
              render: (width) => {
                const current = RESOURCE_TABS[tab]!;
                return renderTabBody(resources, current, theme, width, details[current] === true);
              },
              invalidate() {},
            },
            { scrollbar: "hidden" },
          );

          const switchTab = (index: number) => {
            tab = (index + RESOURCE_TABS.length) % RESOURCE_TABS.length;
            scroll.scrollToStart();
            tui.requestRender();
          };

          const navigation = (width: number): string[] => {
            targets = [];
            const available = width - (RESOURCE_TABS.length - 1);
            const size = Math.floor(available / RESOURCE_TABS.length);
            const remainder = available % RESOURCE_TABS.length;
            // Pick one label set for the whole bar. Never show half a tab name.
            const labelSets = [
              RESOURCE_TABS.map((label) => `${label} ${tabCount(resources, label)}`),
              ...TAB_LABELS,
            ];
            const labels = labelSets.find((set) =>
              set.every((label) => visibleWidth(label) <= size),
            )!;
            let column = 2;
            const cells = labels.map((label, index) => {
              const cellWidth = size + (index < remainder ? 1 : 0);
              const padding = cellWidth - visibleWidth(label);
              const centered =
                " ".repeat(Math.floor(padding / 2)) + label + " ".repeat(Math.ceil(padding / 2));
              targets.push({ index, start: column, end: column + cellWidth });
              column += cellWidth + 1;
              const active = index === tab;
              return {
                title: active
                  ? theme.bold(theme.fg("accent", centered))
                  : theme.fg("muted", centered),
                rail: theme.fg(
                  active ? "accent" : "borderMuted",
                  (active ? "━" : "─").repeat(cellWidth),
                ),
              };
            });
            return [
              cells.map((cell) => cell.title).join(" "),
              cells.map((cell) => cell.rail).join(theme.fg("borderMuted", "─")),
            ];
          };

          const heading = (
            width: number,
            current: ResourceTab,
            compact: boolean,
            expanded: boolean,
          ) => {
            const wrapped = wrapTextWithAnsi(
              tabSummary(resources, current, compact, expanded),
              width,
            );
            const rows = compact ? 1 : 2;
            return wrapped
              .slice(0, rows)
              .map((text, index) =>
                theme.fg(
                  "muted",
                  index === rows - 1 && wrapped.length > rows
                    ? truncateToWidth(text, width - 1, "") + "…"
                    : text,
                ),
              );
          };

          const hints = (width: number, expandable: boolean, expanded: boolean): string => {
            const help: [string, string][] = [[closeKeys, "close"]];
            if (expandable) help.push(["e", expanded ? "collapse" : "expand"]);
            help.push(
              ["←→/Tab", "tabs"],
              [scrollKeys, "scroll"],
              [`1–${RESOURCE_TABS.length}`, "jump"],
              [pageKeys, "page"],
            );
            let line = "";
            for (const [key, label] of help) {
              const hint = theme.fg("accent", key) + theme.fg("dim", ` ${label}`);
              const candidate = line ? `${line}${theme.fg("borderMuted", " · ")}${hint}` : hint;
              if (visibleWidth(candidate) <= width) line = candidate;
            }
            return line;
          };

          return {
            render: (width: number) => {
              mouseWidth = width;
              targets = [];
              const height = Math.min(
                28,
                Math.floor(tui.terminal.rows * 0.8),
                tui.terminal.rows - 4,
              );
              if (width < 24 || height < 8) {
                return [fit(`Resize to browse · ${closeKeys} close`, Math.max(0, width))];
              }

              const inner = width - 4;
              const border = (text: string) => theme.fg("borderAccent", text);
              const row = (text = "") => border("│ ") + fit(text, inner) + border(" │");
              const current = RESOURCE_TABS[tab]!;
              const count = tabCount(resources, current);
              const compact = inner < 76 || height < 16;
              const expanded = details[current] === true;
              const expandable = EXPANDABLE.has(current);

              const nav = navigation(inner);
              const headingLines = heading(inner, current, compact, expanded);
              const body = scroll.render(inner);
              const spacer = compact ? [] : [row()];
              // Borders, navigation, hints, and headings stay outside the scrollable body.
              page = Math.max(
                1,
                Math.min(
                  height - 5 - headingLines.length - spacer.length,
                  Math.max(4, body.length),
                ),
              );
              scroll.updateLayout(body.length, page, () => tui.requestRender());
              const visible = body.slice(scroll.scrollTop, scroll.scrollTop + page);
              while (visible.length < page) visible.push("");

              const position =
                body.length > page
                  ? `Rows ${scroll.scrollTop + 1}–${Math.min(body.length, scroll.scrollTop + page)} / ${body.length}`
                  : `${count} ${tabUnit(current)}`;
              const footer = theme.fg("dim", truncateToWidth(` ${position} `, inner, "…"));
              const title = theme.bold(
                theme.fg(
                  "accent",
                  truncateToWidth(
                    ` ${compact ? `${current} ${count}` : `Resources · ${current} ${count}`} `,
                    inner,
                    "…",
                  ),
                ),
              );

              return [
                border("╭─") + title + border("─".repeat(inner - visibleWidth(title)) + "─╮"),
                ...nav.map(row),
                ...headingLines.map(row),
                ...spacer,
                ...visible.map(row),
                row(hints(inner, expandable, expanded)),
                border("╰─") +
                  footer +
                  border("─".repeat(Math.max(0, inner - visibleWidth(footer))) + "─╯"),
              ];
            },
            handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
              if (event.width !== mouseWidth) return undefined;
              if (event.type === "wheel") {
                scroll.scrollBy(event.wheelDelta ?? 0);
                tui.requestRender();
                // Contain the event even at an edge so the transcript does not scroll.
                return { handled: true, focus: true };
              }
              if (
                event.button !== "left" ||
                event.shift ||
                event.alt ||
                event.ctrl ||
                (event.type !== "press" && event.type !== "click") ||
                (event.y !== 1 && event.y !== 2)
              )
                return undefined;
              const target = targets.find((item) => event.x >= item.start && event.x < item.end);
              if (!target) return undefined;
              if (event.type === "click") switchTab(target.index);
              return { handled: true, focus: true };
            },
            handleInput: (data: string) => {
              if (isKeyRelease(data)) return;
              if (
                keybindings.matches(data, "tui.select.cancel") ||
                keybindings.matches(data, "tui.select.confirm") ||
                data === "q"
              ) {
                done();
                return;
              }
              const current = RESOURCE_TABS[tab]!;
              if (EXPANDABLE.has(current) && data === "e") {
                details[current] = !details[current];
                scroll.scrollToStart();
              } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right))
                switchTab(tab + 1);
              else if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.left))
                switchTab(tab - 1);
              else if (/^[1-9]$/.test(data) && Number(data) <= RESOURCE_TABS.length)
                switchTab(Number(data) - 1);
              else if (keybindings.matches(data, "tui.select.up")) scroll.scrollBy(-1);
              else if (keybindings.matches(data, "tui.select.down")) scroll.scrollBy(1);
              else if (keybindings.matches(data, "tui.select.pageUp")) scroll.scrollBy(-page);
              else if (keybindings.matches(data, "tui.select.pageDown")) scroll.scrollBy(page);
              else if (matchesKey(data, Key.home)) scroll.scrollToStart();
              else if (matchesKey(data, Key.end)) scroll.scrollToEnd();
              tui.requestRender();
            },
            invalidate() {
              scroll.invalidate();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: 100,
            minWidth: 46,
            maxHeight: "80%",
            margin: 2,
          },
        },
      );
    },
  });
}
