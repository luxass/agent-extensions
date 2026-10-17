import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
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

import { renderDiagnostics } from "./diagnostics.ts";
import { renderExtensions } from "./extensions.ts";
import { keyLabels } from "./key-labels.ts";
import type { ResourceSnapshot } from "./snapshot.ts";
import { renderTools } from "./tools.ts";

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

const RESOURCE_TABS = ["Tools", "Context", "Skills", "Extensions", "Diagnostics"] as const;
type ResourceTab = (typeof RESOURCE_TABS)[number];

function tabCount(snapshot: ResourceSnapshot, tab: ResourceTab): number {
  if (tab === "Tools") return snapshot.tools.length;
  if (tab === "Context") return snapshot.context.length;
  if (tab === "Skills") return snapshot.skills.length;
  if (tab === "Extensions") return snapshot.extensions.length;
  return snapshot.diagnostics.length;
}

function renderResourceBody(
  snapshot: ResourceSnapshot,
  tab: ResourceTab,
  theme: Theme,
  width: number,
  expanded: boolean,
): string[] {
  const lines: string[] = [];
  const wrap = (text: string, indent: number, color: "text" | "muted" | "dim") => {
    for (const entry of wrapTextWithAnsi(text, Math.max(1, width - indent))) {
      lines.push(" ".repeat(indent) + theme.fg(color, entry));
    }
  };
  if (tab === "Tools") return renderTools(snapshot.tools, theme, width, expanded);
  if (tab === "Extensions") return renderExtensions(snapshot.extensions, theme, width, expanded);
  if (tab === "Diagnostics") return renderDiagnostics(snapshot.diagnostics, theme, width);

  const items = tab === "Context" ? snapshot.context : snapshot.skills;
  if (items.length === 0) {
    wrap("None loaded.", 0, "muted");
    return lines;
  }
  if (tab === "Context") {
    for (const item of items) wrap(item, 0, "text");
    return lines;
  }

  // Read down each column, like a directory listing. Keep every name intact.
  const gap = 3;
  const longest = Math.max(...items.map(visibleWidth));
  const columns = Math.max(1, Math.min(3, Math.floor((width + gap) / (longest + gap))));
  if (columns === 1) {
    for (const item of items) wrap(item, 0, "text");
    return lines;
  }
  const cellWidth = Math.floor((width - gap * (columns - 1)) / columns);
  const rows = Math.ceil(items.length / columns);
  for (let row = 0; row < rows; row++) {
    const cells: string[] = [];
    for (let column = 0; column < columns; column++) {
      const item = items[column * rows + row];
      cells.push(fit(theme.fg("text", item ?? ""), cellWidth));
    }
    lines.push(cells.join(" ".repeat(gap)));
  }
  return lines;
}

export async function showResources(
  ctx: ExtensionContext,
  resources: ResourceSnapshot,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) => {
      let tab = 0;
      const details = { Tools: false, Extensions: false };
      let page = 1;
      let mouseWidth = 0;
      let targets: { index: number; start: number; end: number }[] = [];
      const scroll = new ScrollView(
        {
          render: (width) => {
            const current = RESOURCE_TABS[tab]!;
            return renderResourceBody(
              resources,
              current,
              theme,
              width,
              current === "Tools" ? details.Tools : details.Extensions,
            );
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
        const labels = [
          RESOURCE_TABS.map((label) => label + " " + tabCount(resources, label)),
          RESOURCE_TABS,
          ["Tools", "Ctx", "Skills", "Ext", "Diag"],
          ["T", "C", "S", "E", "D"],
        ].find((labels) => labels.every((label) => visibleWidth(label) <= size))!;
        let column = 2;
        const cells = labels.map((label, index) => {
          const cellWidth = size + (index < remainder ? 1 : 0);
          const fitted = label;
          const padding = cellWidth - visibleWidth(fitted);
          const centered =
            " ".repeat(Math.floor(padding / 2)) + fitted + " ".repeat(Math.ceil(padding / 2));
          targets.push({ index, start: column, end: column + cellWidth });
          column += cellWidth + 1;
          const active = index === tab;
          return {
            title: active ? theme.bold(theme.fg("accent", centered)) : theme.fg("muted", centered),
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
      return {
        render: (width: number) => {
          mouseWidth = width;
          targets = [];
          const closeKeys = keyLabels([
            ...keybindings.getKeys("tui.select.cancel").slice(0, 1),
            ...keybindings.getKeys("tui.select.confirm").slice(0, 1),
            "q",
          ]);
          const height = Math.min(28, Math.floor(tui.terminal.rows * 0.8), tui.terminal.rows - 4);
          if (width < 24 || height < 8) {
            return [fit("Resize to browse · " + closeKeys + " close", Math.max(0, width))];
          }
          const inner = width - 4;
          const border = (text: string) => theme.fg("borderAccent", text);
          const row = (text = "") => border("│ ") + fit(text, inner) + border(" │");
          const current = RESOURCE_TABS[tab]!;
          const compact = inner < 76 || height < 16;
          const expandable = current === "Tools" || current === "Extensions";
          const expanded = current === "Tools" ? details.Tools : details.Extensions;
          const active = resources.tools.filter((tool) => tool.active).length;
          const compactSummary = {
            Tools: `${active} active · ${resources.tools.length - active} inactive`,
            Context: "Instruction and system-prompt sources.",
            Skills: "/skill:<name> to run.",
            Extensions: "Loaded extensions by source.",
            Diagnostics: "Loader errors, warnings, and collisions.",
          }[current];
          const summary = {
            Tools: `${active} active · ${resources.tools.length - active} inactive · Registered exposure is shown. Per-request tool hiding is not.`,
            Context: "Loaded instruction files and system-prompt sources, in Pi’s loading order.",
            Skills: "Run a skill with /skill:<name>.",
            Extensions: `Loaded extensions by source. Press e to ${expanded ? "hide" : "show"} full paths and package entries.`,
            Diagnostics:
              "Loader errors, warnings, and name collisions across extensions, skills, prompts, and themes.",
          }[current];
          const wrapped = wrapTextWithAnsi(compact ? compactSummary : summary, inner);
          const headingRows = compact ? 1 : 2;
          const heading = wrapped
            .slice(0, headingRows)
            .map((text, index) =>
              theme.fg(
                "muted",
                index === headingRows - 1 && wrapped.length > headingRows
                  ? truncateToWidth(text, inner - 1, "") + "…"
                  : text,
              ),
            );
          const nav = navigation(inner);
          const lines = scroll.render(inner);
          const spacer = compact ? [] : [row()];
          // Borders, navigation, help, and headings stay outside the scrollable body.
          page = Math.max(
            1,
            Math.min(height - 5 - heading.length - spacer.length, Math.max(4, lines.length)),
          );
          scroll.updateLayout(lines.length, page, () => tui.requestRender());
          const visible = lines.slice(scroll.scrollTop, scroll.scrollTop + page);
          while (visible.length < page) visible.push("");
          const position =
            lines.length > page
              ? "Rows " +
                (scroll.scrollTop + 1) +
                "–" +
                Math.min(lines.length, scroll.scrollTop + page) +
                " / " +
                lines.length
              : tabCount(resources, current) +
                (current === "Tools"
                  ? " registered"
                  : current === "Diagnostics"
                    ? " issues"
                    : " loaded");
          const footer = theme.fg("dim", truncateToWidth(" " + position + " ", width - 4, "…"));
          const help: [string, string][] = [
            [compact ? "q" : closeKeys, "close"],
            ["←→/Tab", "tabs"],
            [
              keyLabels([
                ...keybindings.getKeys("tui.select.up").slice(0, 1),
                ...keybindings.getKeys("tui.select.down").slice(0, 1),
              ]),
              "scroll",
            ],
            ["1–" + RESOURCE_TABS.length, "jump"],
            [
              keyLabels([
                ...keybindings.getKeys("tui.select.pageUp").slice(0, 1),
                ...keybindings.getKeys("tui.select.pageDown").slice(0, 1),
              ]),
              "page",
            ],
          ];
          if (expandable) help.splice(1, 0, ["e", expanded ? "collapse" : "expand"]);
          let hints = "";
          for (const [key, label] of help) {
            const hint = theme.fg("accent", key) + theme.fg("dim", " " + label);
            const candidate = hints ? hints + theme.fg("borderMuted", " · ") + hint : hint;
            if (visibleWidth(candidate) <= inner) hints = candidate;
          }
          const selected = `${current} ${tabCount(resources, current)}`;
          const title = theme.bold(
            theme.fg(
              "accent",
              truncateToWidth(
                ` ${compact ? selected : "Resources · " + selected} `,
                width - 4,
                "…",
              ),
            ),
          );
          return [
            border("╭─") + title + border("─".repeat(width - 4 - visibleWidth(title)) + "─╮"),
            ...nav.map(row),
            ...heading.map(row),
            ...spacer,
            ...visible.map(row),
            row(hints),
            border("╰─") +
              footer +
              border("─".repeat(Math.max(0, width - 4 - visibleWidth(footer))) + "─╯"),
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
          if ((current === "Tools" || current === "Extensions") && data === "e") {
            details[current] = !details[current];
            scroll.scrollToStart();
          } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) switchTab(tab + 1);
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
}
