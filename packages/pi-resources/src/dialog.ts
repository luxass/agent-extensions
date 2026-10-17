import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  Key,
  matchesKey,
  ScrollView,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type KeybindingsManager,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { renderDiagnostics } from "./diagnostics.ts";
import { renderExtensions } from "./extensions.ts";
import type { ResourceSnapshot } from "./resources.ts";
import {
  EXPANDABLE,
  RESOURCE_TABS,
  type ResourceTab,
  TAB_LABELS,
  tabCount,
  tabSummary,
  tabUnit,
} from "./tabs.ts";
import { renderTools } from "./tools.ts";

const MAX_DIALOG_ROWS = 28;
const DIALOG_HEIGHT_RATIO = 0.8;
const DIALOG_HEIGHT_RESERVED = 4;
const CHROME_ROWS = 5; // top border, two nav rows, hints, bottom border
const MIN_DIALOG_WIDTH = 24;
const MIN_DIALOG_HEIGHT = 8;
const COMPACT_WIDTH = 76; // compact when the inner width is below this
const COMPACT_HEIGHT = 16;
const MIN_PAGE_ROWS = 4; // never request fewer rows than this

const KEY_LABELS: Record<string, string> = {
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageUp: "PgUp",
  pageDown: "PgDn",
  home: "Home",
  end: "End",
  ctrl: "Ctrl",
  shift: "Shift",
  alt: process.platform === "darwin" ? "Option" : "Alt",
};

function keyLabels(keys: readonly string[]): string {
  return [...new Set(keys)]
    .map((key) =>
      key
        .split("+")
        .map((part) => KEY_LABELS[part] ?? part)
        .join("+"),
    )
    .join("/");
}

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

interface TabTarget {
  tab: ResourceTab;
  start: number;
  end: number;
}

interface ResourcesDialogOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  resources: ResourceSnapshot;
  done: () => void;
}

export class ResourcesDialog implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly resources: ResourceSnapshot;
  private readonly done: () => void;
  private readonly closeKeys: string;
  private readonly scrollKeys: string;
  private readonly pageKeys: string;
  private readonly scroll: ScrollView;

  private tab: ResourceTab = RESOURCE_TABS[0];
  private page = 1;
  private mouseWidth = 0;
  private targets: TabTarget[] = [];
  private readonly expanded = new Set<ResourceTab>();

  constructor({ tui, theme, keybindings, resources, done }: ResourcesDialogOptions) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.resources = resources;
    this.done = done;

    const first = (action: Parameters<KeybindingsManager["getKeys"]>[0]) =>
      keybindings.getKeys(action).slice(0, 1);
    this.closeKeys = keyLabels([
      ...first("tui.select.cancel"),
      ...first("tui.select.confirm"),
      "q",
    ]);
    this.scrollKeys = keyLabels([...first("tui.select.up"), ...first("tui.select.down")]);
    this.pageKeys = keyLabels([...first("tui.select.pageUp"), ...first("tui.select.pageDown")]);

    this.scroll = new ScrollView(
      {
        render: (width) => this.body(width),
        invalidate() {},
      },
      { scrollbar: "hidden" },
    );
  }

  private switchTab(tab: ResourceTab): void {
    this.tab = tab;
    this.scroll.scrollToStart();
    this.tui.requestRender();
  }

  private stepTab(delta: number): void {
    const index = RESOURCE_TABS.indexOf(this.tab);
    this.switchTab(RESOURCE_TABS[(index + delta + RESOURCE_TABS.length) % RESOURCE_TABS.length]!);
  }

  private toggleExpanded(): void {
    if (this.expanded.has(this.tab)) this.expanded.delete(this.tab);
    else this.expanded.add(this.tab);
  }

  private navigation(width: number): { rows: string[]; targets: TabTarget[] } {
    const targets: TabTarget[] = [];
    const available = width - (RESOURCE_TABS.length - 1);
    const size = Math.floor(available / RESOURCE_TABS.length);
    const remainder = available % RESOURCE_TABS.length;
    // Pick one label set for the whole bar. Never show half a tab name.
    const labelSets = [
      RESOURCE_TABS.map((label) => `${label} ${tabCount(this.resources, label)}`),
      ...TAB_LABELS,
    ];
    const labels = labelSets.find((set) => set.every((label) => visibleWidth(label) <= size))!;
    let column = 2;
    const cells = RESOURCE_TABS.map((tab, index) => {
      const label = labels[index] ?? tab;
      const cellWidth = size + (index < remainder ? 1 : 0);
      const padding = cellWidth - visibleWidth(label);
      const centered =
        " ".repeat(Math.floor(padding / 2)) + label + " ".repeat(Math.ceil(padding / 2));
      targets.push({ tab, start: column, end: column + cellWidth });
      column += cellWidth + 1;
      const active = tab === this.tab;
      return {
        title: active
          ? this.theme.bold(this.theme.fg("accent", centered))
          : this.theme.fg("muted", centered),
        rail: this.theme.fg(
          active ? "accent" : "borderMuted",
          (active ? "━" : "─").repeat(cellWidth),
        ),
      };
    });
    return {
      rows: [
        cells.map((cell) => cell.title).join(" "),
        cells.map((cell) => cell.rail).join(this.theme.fg("borderMuted", "─")),
      ],
      targets,
    };
  }

  private heading(
    width: number,
    current: ResourceTab,
    compact: boolean,
    expanded: boolean,
  ): string[] {
    const wrapped = wrapTextWithAnsi(tabSummary(this.resources, current, compact, expanded), width);
    const rows = compact ? 1 : 2;
    return wrapped
      .slice(0, rows)
      .map((text, index) =>
        this.theme.fg(
          "muted",
          index === rows - 1 && wrapped.length > rows
            ? truncateToWidth(text, width - 1, "") + "…"
            : text,
        ),
      );
  }

  private hints(width: number, expandable: boolean, expanded: boolean): string {
    const help: [string, string][] = [[this.closeKeys, "close"]];
    if (expandable) help.push(["e", expanded ? "collapse" : "expand"]);
    help.push(
      ["←→/Tab", "tabs"],
      [this.scrollKeys, "scroll"],
      [`1–${RESOURCE_TABS.length}`, "jump"],
      [this.pageKeys, "page"],
    );
    let line = "";
    for (const [key, label] of help) {
      const hint = this.theme.fg("accent", key) + this.theme.fg("dim", ` ${label}`);
      const candidate = line ? `${line}${this.theme.fg("borderMuted", " · ")}${hint}` : hint;
      if (visibleWidth(candidate) <= width) line = candidate;
    }
    return line;
  }

  private body(width: number): string[] {
    const expanded = this.expanded.has(this.tab);
    if (this.tab === "Tools") return renderTools(this.resources.tools, this.theme, width, expanded);
    if (this.tab === "Extensions")
      return renderExtensions(this.resources.extensions, this.theme, width, expanded);
    if (this.tab === "Diagnostics")
      return renderDiagnostics(this.resources.diagnostics, this.theme, width);
    const items = this.tab === "Context" ? this.resources.context : this.resources.skills;
    return this.sourceList(items, width, this.tab === "Skills");
  }

  private sourceList(items: string[], width: number, columns: boolean): string[] {
    if (items.length === 0) return [this.theme.fg("muted", "None loaded.")];

    const lines: string[] = [];
    for (const entry of items) {
      for (const line of wrapTextWithAnsi(entry, Math.max(1, width))) {
        lines.push(this.theme.fg("text", line));
      }
    }
    if (!columns || items.length === 1) return lines;

    // Read down each column, like a directory listing. Keep every name intact.
    const gap = 3;
    const longest = Math.max(...items.map(visibleWidth));
    const count = Math.max(1, Math.min(3, Math.floor((width + gap) / (longest + gap))));
    if (count === 1) return lines;

    lines.length = 0;
    const cellWidth = Math.floor((width - gap * (count - 1)) / count);
    const rows = Math.ceil(items.length / count);
    for (let row = 0; row < rows; row++) {
      const cells: string[] = [];
      for (let column = 0; column < count; column++) {
        cells.push(fit(this.theme.fg("text", items[column * rows + row] ?? ""), cellWidth));
      }
      lines.push(cells.join(" ".repeat(gap)));
    }
    return lines;
  }

  render(width: number): string[] {
    this.mouseWidth = width;
    const height = Math.min(
      MAX_DIALOG_ROWS,
      Math.floor(this.tui.terminal.rows * DIALOG_HEIGHT_RATIO),
      this.tui.terminal.rows - DIALOG_HEIGHT_RESERVED,
    );
    if (width < MIN_DIALOG_WIDTH || height < MIN_DIALOG_HEIGHT) {
      this.targets = [];
      return [fit(`Resize to browse · ${this.closeKeys} close`, Math.max(0, width))];
    }

    const inner = width - 4;
    const border = (text: string) => this.theme.fg("borderAccent", text);
    const row = (text = "") => border("│ ") + fit(text, inner) + border(" │");
    const current = this.tab;
    const count = tabCount(this.resources, current);
    const compact = inner < COMPACT_WIDTH || height < COMPACT_HEIGHT;
    const expanded = this.expanded.has(current);
    const expandable = EXPANDABLE.has(current);

    const nav = this.navigation(inner);
    this.targets = nav.targets;
    const headingLines = this.heading(inner, current, compact, expanded);
    const body = this.scroll.render(inner);
    const spacer = compact ? [] : [row()];
    // Borders, navigation, hints, and headings stay outside the scrollable body.
    this.page = Math.max(
      1,
      Math.min(
        height - CHROME_ROWS - headingLines.length - spacer.length,
        Math.max(MIN_PAGE_ROWS, body.length),
      ),
    );
    this.scroll.updateLayout(body.length, this.page, () => this.tui.requestRender());
    const visible = body.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.page);
    while (visible.length < this.page) visible.push("");

    const position =
      body.length > this.page
        ? `Rows ${this.scroll.scrollTop + 1}–${Math.min(body.length, this.scroll.scrollTop + this.page)} / ${body.length}`
        : `${count} ${tabUnit(current)}`;
    const footer = this.theme.fg("dim", truncateToWidth(` ${position} `, inner, "…"));
    const title = this.theme.bold(
      this.theme.fg(
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
      ...nav.rows.map(row),
      ...headingLines.map(row),
      ...spacer,
      ...visible.map(row),
      row(this.hints(inner, expandable, expanded)),
      border("╰─") + footer + border("─".repeat(Math.max(0, inner - visibleWidth(footer))) + "─╯"),
    ];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.width !== this.mouseWidth) return undefined;
    if (event.type === "wheel") {
      this.scroll.scrollBy(event.wheelDelta ?? 0);
      this.tui.requestRender();
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
    const target = this.targets.find((item) => event.x >= item.start && event.x < item.end);
    if (!target) return undefined;
    if (event.type === "click") this.switchTab(target.tab);
    return { handled: true, focus: true };
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (
      this.keybindings.matches(data, "tui.select.cancel") ||
      this.keybindings.matches(data, "tui.select.confirm") ||
      data === "q"
    ) {
      this.done();
      return;
    }
    const current = this.tab;
    if (EXPANDABLE.has(current) && data === "e") {
      this.toggleExpanded();
      this.scroll.scrollToStart();
    } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) this.stepTab(1);
    else if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.left)) this.stepTab(-1);
    else if (/^[1-9]$/.test(data)) {
      const target = RESOURCE_TABS[Number(data) - 1];
      if (target) this.switchTab(target);
    } else if (this.keybindings.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
    else if (this.keybindings.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
    else if (this.keybindings.matches(data, "tui.select.pageUp")) this.scroll.scrollBy(-this.page);
    else if (this.keybindings.matches(data, "tui.select.pageDown")) this.scroll.scrollBy(this.page);
    else if (matchesKey(data, Key.home)) this.scroll.scrollToStart();
    else if (matchesKey(data, Key.end)) this.scroll.scrollToEnd();
    this.tui.requestRender();
  }

  invalidate(): void {
    this.scroll.invalidate();
  }
}
