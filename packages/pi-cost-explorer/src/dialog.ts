import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type KeybindingsManager,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import {
  addUsage,
  cacheHitRate,
  createUsageTotals,
  SOURCE_LABELS,
  type Analysis,
  type UsageRecord,
  type UsageTotals,
} from "./analysis";
import {
  bar,
  clock,
  duration,
  fit,
  money,
  percent,
  plural,
  sparkline,
  table,
  tokens,
  type Column,
} from "./format";

type Tab = "Overview" | "Models" | "Turns" | "Tools" | "Requests";

/** What a tab or detail screen shows. */
interface Screen {
  /** A line that stays above the scrolling lines, such as a table header. */
  header?: string;
  lines: string[];
  /** One id per line in a list. Lists have a selected row; other screens only scroll. */
  ids?: string[];
}

interface ScreenContext {
  analysis: Analysis;
  theme: Theme;
  width: number;
  sort: string;
  onlyCurrentBranch: boolean;
}

interface TabConfig {
  screen: (context: ScreenContext) => Screen;
  /** The two sort orders of a list. The first is the default. */
  sorts?: readonly [string, string];
  /** The screen that Enter opens for a row. */
  detail?: (context: ScreenContext, id: string) => Screen | undefined;
}

const TABS: Record<Tab, TabConfig> = {
  Overview: { screen: overviewScreen },
  Models: { screen: modelsScreen, sorts: ["cost", "requests"] },
  Turns: { screen: turnsScreen, sorts: ["cost", "order"], detail: turnDetail },
  Tools: { screen: toolsScreen, sorts: ["cost", "calls"] },
  Requests: { screen: requestsScreen, sorts: ["order", "cost"], detail: recordDetail },
};
const TAB_NAMES = Object.keys(TABS) as Tab[];

const MAX_HEIGHT = 34;

interface Position {
  selected: number;
  top: number;
}

interface CostDialogOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  load: (onlyCurrentBranch: boolean) => Analysis;
  done: () => void;
}

export class CostDialog implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly load: (onlyCurrentBranch: boolean) => Analysis;
  private readonly done: () => void;

  private analysis: Analysis;
  private onlyCurrentBranch = false;
  private tab: Tab = "Overview";
  /** Id of the row whose detail screen is open. */
  private detailId: string | undefined;
  private readonly alternateSort = new Set<Tab>();
  private readonly positions = new Map<string, Position>();
  /** Layout of the last render. Input handling uses it. */
  private layout = {
    width: 0,
    page: 1,
    rows: 0,
    bodyTop: 0,
    ids: undefined as string[] | undefined,
  };

  constructor({ tui, theme, keybindings, load, done }: CostDialogOptions) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.load = load;
    this.done = done;
    this.analysis = load(false);
  }

  refresh(): void {
    this.analysis = this.load(this.onlyCurrentBranch);
    this.tui.requestRender();
  }

  close(): void {
    this.done();
  }

  private sortOrder(): string | undefined {
    return TABS[this.tab].sorts?.[this.alternateSort.has(this.tab) ? 1 : 0];
  }

  private position(): Position {
    const key = this.detailId ? `${this.tab}:${this.detailId}` : this.tab;
    let position = this.positions.get(key);
    if (!position) {
      position = { selected: 0, top: 0 };
      this.positions.set(key, position);
    }
    return position;
  }

  private screen(width: number): Screen {
    const config = TABS[this.tab];
    const context: ScreenContext = {
      analysis: this.analysis,
      theme: this.theme,
      width,
      sort: this.sortOrder() ?? "",
      onlyCurrentBranch: this.onlyCurrentBranch,
    };
    if (this.detailId) {
      const detail = config.detail?.(context, this.detailId);
      if (detail) return detail;
      // The row is gone, for example after switching to the current branch.
      this.detailId = undefined;
    }
    return config.screen(context);
  }

  private showTab(tab: Tab): void {
    this.tab = tab;
    this.detailId = undefined;
  }

  private open(): void {
    // Read the current screen. A key can arrive before the screen it changed is rendered.
    const id = this.screen(this.layout.width - 4).ids?.[this.position().selected];
    if (id && TABS[this.tab].detail && !this.detailId) this.detailId = id;
  }

  private scroll(step: number): void {
    const position = this.position();
    const { lines, ids } = this.screen(this.layout.width - 4);
    if (ids) position.selected = clamp(position.selected + step, 0, lines.length - 1);
    else position.top = clamp(position.top + step, 0, lines.length - this.layout.page);
  }

  // Rendering

  render(width: number): string[] {
    const theme = this.theme;
    const inner = width - 4;
    const height = Math.min(MAX_HEIGHT, this.tui.terminal.rows - 4);
    const screen = this.screen(inner);
    const header = screen.header === undefined ? [] : [theme.fg("dim", screen.header)];
    // Top border, two tab rows, hints, and bottom border surround the body.
    const page = Math.max(1, height - 5 - header.length);

    const position = this.position();
    if (screen.ids) {
      position.selected = clamp(position.selected, 0, screen.lines.length - 1);
      // Scroll just enough to keep the selected row visible.
      position.top = clamp(position.top, position.selected - page + 1, position.selected);
    }
    position.top = clamp(position.top, 0, screen.lines.length - page);
    this.layout = {
      width,
      page,
      rows: screen.lines.length,
      bodyTop: 3 + header.length,
      ids: screen.ids,
    };

    const body = screen.lines
      .slice(position.top, position.top + page)
      .map((line, index) =>
        screen.ids && position.top + index === position.selected
          ? highlight(theme, line, inner)
          : line,
      );
    if (screen.ids?.length === 0) body.push(theme.fg("muted", "Nothing recorded yet."));
    while (body.length < page) body.push("");

    const border = (text: string) => theme.fg("borderAccent", text);
    const row = (text: string) => border("│ ") + fit(text, inner) + border(" │");
    const edge = (left: string, label: string, right: string) =>
      border(left + "─") +
      label +
      border("─".repeat(Math.max(0, inner - visibleWidth(label))) + "─" + right);

    const branches = this.onlyCurrentBranch ? "current branch" : "all branches";
    const title = theme.bold(
      theme.fg(
        "accent",
        truncateToWidth(
          ` Cost explorer · ${money(this.analysis.total.cost)} · ${branches} `,
          inner,
          "…",
        ),
      ),
    );
    const scrolled =
      screen.lines.length > page
        ? ` ${position.top + 1}–${Math.min(screen.lines.length, position.top + page)} / ${screen.lines.length} `
        : "";

    return [
      edge("╭", title, "╮"),
      ...this.tabBar(inner).map(row),
      ...header.map(row),
      ...body.map(row),
      row(this.hints(inner)),
      edge("╰", theme.fg("dim", scrolled), "╯"),
    ];
  }

  /** Draws the tabs in equal cells, so a click maps to a tab by division. */
  private tabBar(width: number): string[] {
    const titles: string[] = [];
    const rails: string[] = [];
    for (const [index, tab] of TAB_NAMES.entries()) {
      const active = tab === this.tab;
      // The last tab takes the columns left over by the division.
      const cell =
        tabWidth(width) + (index === TAB_NAMES.length - 1 ? width % TAB_NAMES.length : 0);
      const label = fit(" ".repeat(Math.max(0, Math.floor((cell - tab.length) / 2))) + tab, cell);
      titles.push(
        active ? this.theme.bold(this.theme.fg("accent", label)) : this.theme.fg("muted", label),
      );
      rails.push(
        this.theme.fg(active ? "accent" : "borderMuted", (active ? "━" : "─").repeat(cell)),
      );
    }
    return [titles.join(""), rails.join("")];
  }

  private hints(width: number): string {
    const sort = this.sortOrder();
    const hints = [
      this.detailId ? "Esc back" : TABS[this.tab].detail ? "Enter open" : undefined,
      "q close",
      sort && !this.detailId ? `s sort: ${sort}` : undefined,
      "b branches",
      "Tab tabs",
      this.layout.ids ? "↑↓ select" : "↑↓ scroll",
      "r refresh",
    ];

    let line = "";
    for (const hint of hints) {
      if (!hint) continue;
      const [key = "", ...label] = hint.split(" ");
      const styled = this.theme.fg("accent", key) + this.theme.fg("dim", ` ${label.join(" ")}`);
      const candidate = line ? line + this.theme.fg("borderMuted", " · ") + styled : styled;
      if (visibleWidth(candidate) <= width) line = candidate;
    }
    return line;
  }

  // Input

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const { width, page, rows, bodyTop, ids } = this.layout;
    if (event.width !== width) return undefined;
    const position = this.position();

    if (event.type === "wheel") {
      position.top = clamp(position.top + (event.wheelDelta ?? 0), 0, rows - page);
      if (ids) position.selected = clamp(position.selected, position.top, position.top + page - 1);
      this.tui.requestRender();
      // Contain the event even at an edge so the transcript does not scroll.
      return { handled: true, focus: true };
    }
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) {
      return undefined;
    }

    // Rows 1 and 2 are the tab bar, which starts after the two-column left border.
    const tab =
      TAB_NAMES[Math.min(TAB_NAMES.length - 1, Math.floor((event.x - 2) / tabWidth(width - 4)))];
    const index = position.top + event.y - bodyTop;
    const onTab =
      (event.y === 1 || event.y === 2) && event.x >= 2 && event.x < width - 2 && tab !== undefined;
    const onRow =
      ids !== undefined && event.y >= bodyTop && index < rows && index < position.top + page;
    if (!onTab && !onRow) return undefined;

    if (event.type === "click") {
      if (onTab) this.showTab(tab);
      // Clicking the selected row opens it. Clicking another row selects it.
      else if (index === position.selected) this.open();
      else position.selected = index;
      this.tui.requestRender();
    }
    return { handled: true, focus: true };
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    const keys = this.keybindings;
    const index = TAB_NAMES.indexOf(this.tab);

    if (data === "q" || (keys.matches(data, "tui.select.cancel") && !this.detailId)) {
      this.done();
      return;
    }

    if (keys.matches(data, "tui.select.cancel")) this.detailId = undefined;
    else if (keys.matches(data, "tui.select.confirm")) this.open();
    else if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.showTab(TAB_NAMES[(index + 1) % TAB_NAMES.length]!);
    } else if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.left)) {
      this.showTab(TAB_NAMES[(index - 1 + TAB_NAMES.length) % TAB_NAMES.length]!);
    } else if (/^[1-5]$/.test(data)) this.showTab(TAB_NAMES[Number(data) - 1]!);
    else if (data === "s" && this.sortOrder() && !this.detailId) {
      if (this.alternateSort.has(this.tab)) this.alternateSort.delete(this.tab);
      else this.alternateSort.add(this.tab);
      this.positions.delete(this.tab);
    } else if (data === "b") {
      this.onlyCurrentBranch = !this.onlyCurrentBranch;
      this.positions.clear();
      this.analysis = this.load(this.onlyCurrentBranch);
    } else if (data === "r") this.analysis = this.load(this.onlyCurrentBranch);
    else if (keys.matches(data, "tui.select.up")) this.scroll(-1);
    else if (keys.matches(data, "tui.select.down")) this.scroll(1);
    else if (keys.matches(data, "tui.select.pageUp")) this.scroll(-this.layout.page);
    else if (keys.matches(data, "tui.select.pageDown")) this.scroll(this.layout.page);
    else if (matchesKey(data, Key.home)) this.scroll(-Infinity);
    else if (matchesKey(data, Key.end)) this.scroll(Infinity);
    else return;

    this.tui.requestRender();
  }

  invalidate(): void {}
}

// Screens

function overviewScreen({ analysis, theme, width, onlyCurrentBranch }: ScreenContext): Screen {
  const { total } = analysis;
  if (total.count === 0) {
    return {
      lines: [
        theme.fg("muted", "No usage recorded yet. Costs appear after the first model response."),
      ],
    };
  }

  const lines: string[] = [];
  const labelWidth = 17;
  const field = (label: string, value: string) => {
    for (const [index, text] of wrapTextWithAnsi(value, width - labelWidth).entries()) {
      lines.push(fit(theme.fg("muted", index === 0 ? label : ""), labelWidth) + text);
    }
  };
  const dot = theme.fg("borderMuted", " · ");
  const requests = analysis.bySource.get("assistant") ?? createUsageTotals();
  const prompts = analysis.turns.filter((turn) => turn.records.length > 0).length;
  const span =
    analysis.firstTimestamp && analysis.lastTimestamp
      ? ` · over ${duration(analysis.lastTimestamp - analysis.firstTimestamp)}`
      : "";

  field(
    "Total",
    theme.bold(theme.fg("accent", money(total.cost))) +
      theme.fg(
        "dim",
        `  ${plural(requests.count, "request")} · ${plural(prompts, "prompt")}${span}`,
      ),
  );
  field(
    "Tokens",
    [
      theme.fg("text", tokens(total.tokens)),
      `in ${tokens(total.input)}`,
      `out ${tokens(total.output)}`,
      `cache read ${tokens(total.cacheRead)}`,
      `cache write ${tokens(total.cacheWrite)}`,
    ].join(dot),
  );
  field("Cost split", costSplit(theme, total, Math.min(40, width - labelWidth)));
  field(
    "",
    COST_PARTS.map(
      ([label, color, cost]) => `${theme.fg(color, "■")} ${label} ${money(cost(total))}`,
    ).join(dot),
  );
  field("Cache hit rate", `${percent(cacheHitRate(total))} of prompt tokens read from cache`);
  field(
    "Averages",
    `${money(prompts > 0 ? total.cost / prompts : 0)} per prompt${dot}${money(requests.count > 0 ? requests.cost / requests.count : 0)} per request`,
  );
  field(
    "Cost over time",
    theme.fg(
      "accent",
      sparkline(
        analysis.records.map((record) => record.usage.cost.total),
        Math.min(48, width - labelWidth),
      ),
    ),
  );

  const sources = [...analysis.bySource].toSorted((left, right) => right[1].cost - left[1].cost);
  lines.push("", theme.bold("By source"));
  lines.push(
    ...table<(typeof sources)[number]>(
      [
        { header: "", cell: ([source]) => `  ${SOURCE_LABELS[source]}` },
        costColumn(theme, ([, totals]) => totals.cost),
        numberColumn("", 6, ([, totals]) => percent(totals.cost / total.cost)),
        numberColumn("", 6, ([, totals]) => `${totals.count}×`),
        barColumn(theme, sources, ([, totals]) => totals.cost),
      ],
      sources,
      width,
    ).lines,
  );

  const model = analysis.models[0];
  const turn = analysis.turns.toSorted((left, right) => right.totals.cost - left.totals.cost)[0];
  const tool = analysis.tools[0];
  lines.push("", theme.bold("Biggest spenders"));
  if (model) {
    field(
      "Model",
      `${model.model} ${theme.fg("accent", money(model.totals.cost))} ${theme.fg("dim", `(${percent(model.totals.cost / total.cost)})`)}`,
    );
  }
  if (turn && turn.totals.cost > 0) {
    field(
      "Prompt",
      `#${turn.index} ${theme.fg("text", `“${truncateToWidth(turn.prompt, 60, "…")}”`)} ${theme.fg("accent", money(turn.totals.cost))}`,
    );
  }
  if (tool && tool.calls > 0) {
    field(
      "Tool",
      `${tool.name} ${theme.fg("accent", `≈${money(tool.share + tool.nested.cost)}`)} ${theme.fg("dim", `over ${plural(tool.calls, "call")}`)}`,
    );
  }

  const warning = theme.fg("warning", "!");
  const notes = [
    analysis.unpriced > 0 &&
      `${warning} ${plural(analysis.unpriced, "usage record")} with tokens but no cost. Pi has no price for that model, so totals are too low.`,
    analysis.failedCount > 0 &&
      `${warning} ${money(analysis.failedCost)} went to ${plural(analysis.failedCount, "failed or aborted request")}.`,
    !onlyCurrentBranch &&
      analysis.offBranchCost > 0 &&
      `${theme.fg("muted", "·")} ${money(analysis.offBranchCost)} was spent on other session branches. Press b to show only the current branch.`,
  ].filter((note) => typeof note === "string");
  if (notes.length > 0) {
    lines.push("");
    for (const note of notes) lines.push(...wrapTextWithAnsi(note, width));
  }

  return { lines };
}

function modelsScreen({ analysis, theme, width, sort }: ScreenContext): Screen {
  const rows =
    sort === "requests"
      ? analysis.models.toSorted((left, right) => right.totals.count - left.totals.count)
      : analysis.models;
  const columns: Column<(typeof rows)[number]>[] = [
    { header: "Model", cell: (row) => row.model },
    { header: "Provider", width: 12, optional: true, cell: (row) => row.provider ?? "–" },
    numberColumn("Reqs", 5, (row) => String(row.totals.count)),
    numberColumn("Input", 7, (row) => tokens(row.totals.input), true),
    numberColumn("Output", 7, (row) => tokens(row.totals.output), true),
    numberColumn("Cache", 6, (row) => percent(cacheHitRate(row.totals)), true),
    costColumn(theme, (row) => row.totals.cost),
    numberColumn("Share", 5, (row) => percent(row.totals.cost / analysis.total.cost), true),
    barColumn(theme, rows, (row) => row.totals.cost),
  ];
  return { ...table(columns, rows, width), ids: rows.map((row) => row.key) };
}

function turnsScreen({ analysis, theme, width, sort }: ScreenContext): Screen {
  const turns = analysis.turns.filter((turn) => turn.records.length > 0);
  const rows =
    sort === "cost" ? turns.toSorted((left, right) => right.totals.cost - left.totals.cost) : turns;
  const columns: Column<(typeof rows)[number]>[] = [
    numberColumn("#", 4, (row) => String(row.index)),
    { header: "Time", width: 5, optional: true, cell: (row) => clock(row.timestamp) },
    { header: "Prompt", cell: (row) => row.prompt },
    numberColumn("Reqs", 4, (row) => String(row.totals.count), true),
    numberColumn("Tools", 5, (row) => String(row.toolCalls), true),
    numberColumn("Tokens", 7, (row) => tokens(row.totals.tokens), true),
    costColumn(theme, (row) => row.totals.cost),
    barColumn(theme, rows, (row) => row.totals.cost),
  ];
  const { header, lines } = table(columns, rows, width);
  return { header, lines: dimOffBranch(theme, rows, lines), ids: rows.map((row) => row.id) };
}

function toolsScreen({ analysis, theme, width, sort }: ScreenContext): Screen {
  const rows =
    sort === "calls"
      ? analysis.tools.toSorted((left, right) => right.calls - left.calls)
      : analysis.tools;
  const columns: Column<(typeof rows)[number]>[] = [
    { header: "Tool", cell: (row) => row.name },
    numberColumn("Calls", 5, (row) => String(row.calls)),
    numberColumn(
      "Errors",
      6,
      (row) => (row.errors > 0 ? theme.fg("error", String(row.errors)) : "0"),
      true,
    ),
    numberColumn(
      "Run time",
      8,
      (row) => (row.durationMs > 0 ? duration(row.durationMs) : "–"),
      true,
    ),
    numberColumn("Nested", 9, (row) => (row.nested.count > 0 ? money(row.nested.cost) : "–"), true),
    costColumn(theme, (row) => row.share, "≈ Calling"),
    barColumn(theme, rows, (row) => row.share + row.nested.cost),
  ];
  return { ...table(columns, rows, width), ids: rows.map((row) => row.name) };
}

function requestsScreen({ analysis, theme, width, sort }: ScreenContext): Screen {
  const rows =
    sort === "cost"
      ? analysis.records.toSorted((left, right) => right.usage.cost.total - left.usage.cost.total)
      : analysis.records;
  return { ...requestsTable(theme, rows, width), ids: rows.map((row) => row.entryId) };
}

function turnDetail({ analysis, theme, width }: ScreenContext, id: string): Screen | undefined {
  const turn = analysis.turns.find((item) => item.id === id);
  if (!turn) return undefined;

  const prompt = wrapTextWithAnsi(theme.fg("text", turn.prompt), width);
  const records = requestsTable(theme, turn.records, width);
  return {
    lines: [
      theme.bold(`Prompt #${turn.index}`) + theme.fg("dim", ` · ${clock(turn.timestamp)}`),
      ...prompt.slice(0, 8),
      ...(prompt.length > 8
        ? [theme.fg("dim", `… ${plural(prompt.length - 8, "more line")}`)]
        : []),
      "",
      ...breakdown(theme, turn.totals, width),
      theme.fg(
        "dim",
        `${plural(turn.totals.count, "usage record")} · ${plural(turn.toolCalls, "tool call")} · cache hit ${percent(cacheHitRate(turn.totals))}`,
      ),
      "",
      theme.bold("Usage records"),
      theme.fg("dim", records.header),
      ...records.lines,
    ],
  };
}

function recordDetail({ analysis, theme, width }: ScreenContext, id: string): Screen | undefined {
  const record = analysis.records.find((item) => item.entryId === id);
  if (!record) return undefined;

  const turn = analysis.turns.find((item) => item.id === record.turnId);
  const totals = createUsageTotals();
  addUsage(totals, record.usage);

  const fields: [string, string | undefined][] = [
    ["Source", SOURCE_LABELS[record.source]],
    ["Provider", record.provider],
    ["Model", record.model],
    ["Time", new Date(record.timestamp).toLocaleString()],
    [
      "Stop reason",
      record.stopReason &&
        (failed(record) ? theme.fg("warning", record.stopReason) : record.stopReason),
    ],
    ["Branch", record.onBranch ? undefined : theme.fg("dim", "not on the current session branch")],
    ["Prompt", turn && `#${turn.index} ${truncateToWidth(turn.prompt, 80, "…")}`],
    ["Tool calls", record.toolCalls.join(", ") || undefined],
  ];
  const lines = [theme.bold(recordLabel(record)), ""];
  for (const [label, value] of fields) {
    if (value) lines.push(...wrapTextWithAnsi(fit(theme.fg("muted", label), 14) + value, width));
  }
  lines.push("", ...breakdown(theme, totals, width));
  if (record.usage.reasoning) {
    lines.push(
      theme.fg("dim", `Output includes ${tokens(record.usage.reasoning)} reasoning tokens.`),
    );
  }
  return { lines };
}

// Shared pieces

const COST_PARTS = [
  ["input", "accent", (totals: UsageTotals) => totals.costInput],
  ["output", "success", (totals: UsageTotals) => totals.costOutput],
  ["cache read", "muted", (totals: UsageTotals) => totals.costCacheRead],
  ["cache write", "warning", (totals: UsageTotals) => totals.costCacheWrite],
] as const;

/** One bar split into the cost of each token kind. */
function costSplit(theme: Theme, totals: UsageTotals, width: number): string {
  if (totals.cost <= 0) return "";
  let used = 0;
  return COST_PARTS.map(([, color, cost], index) => {
    // The last part takes what is left, so rounding never changes the bar's width.
    const share = Math.round((cost(totals) / totals.cost) * width);
    const cells = index === COST_PARTS.length - 1 ? width - used : Math.min(width - used, share);
    used += cells;
    return theme.fg(color, "█".repeat(cells));
  }).join("");
}

function breakdown(theme: Theme, totals: UsageTotals, width: number): string[] {
  const rows: [label: string, count: number, cost: number][] = [
    ["Input", totals.input, totals.costInput],
    ["Output", totals.output, totals.costOutput],
    ["Cache read", totals.cacheRead, totals.costCacheRead],
    ["Cache write", totals.cacheWrite, totals.costCacheWrite],
    ["Total", totals.tokens, totals.cost],
  ];
  const { header, lines } = table<(typeof rows)[number]>(
    [
      { header: "", width: 14, cell: ([label]) => theme.fg("muted", label) },
      numberColumn("Tokens", 9, ([, count]) => tokens(count)),
      numberColumn("Cost", 11, ([, , cost]) => money(cost)),
    ],
    rows,
    width,
  );
  return [theme.fg("dim", header), ...lines];
}

function requestsTable(theme: Theme, rows: readonly UsageRecord[], width: number) {
  const columns: Column<UsageRecord>[] = [
    { header: "Time", width: 5, cell: (row) => clock(row.timestamp) },
    {
      header: "Model",
      cell: (row) =>
        failed(row)
          ? `${theme.fg("warning", "!")} ${recordLabel(row)}`
          : row.source === "assistant"
            ? recordLabel(row)
            : theme.fg("muted", recordLabel(row)),
    },
    numberColumn("Input", 7, (row) => tokens(row.usage.input), true),
    numberColumn("Output", 7, (row) => tokens(row.usage.output), true),
    numberColumn("Cached", 7, (row) => tokens(row.usage.cacheRead), true),
    numberColumn(
      "Tools",
      5,
      (row) => (row.toolCalls.length > 0 ? String(row.toolCalls.length) : "–"),
      true,
    ),
    costColumn(theme, (row) => row.usage.cost.total),
    barColumn(theme, rows, (row) => row.usage.cost.total),
  ];
  const { header, lines } = table(columns, rows, width);
  return { header, lines: dimOffBranch(theme, rows, lines) };
}

function numberColumn<Row>(
  header: string,
  width: number,
  cell: (row: Row) => string,
  optional = false,
): Column<Row> {
  return { header, width, align: "right", optional, cell };
}

function costColumn<Row>(theme: Theme, cost: (row: Row) => number, header = "Cost"): Column<Row> {
  return { header, width: 9, align: "right", cell: (row) => theme.fg("accent", money(cost(row))) };
}

/** A bar scaled to the largest value in `rows`. It is the first column to go when space runs out. */
function barColumn<Row>(
  theme: Theme,
  rows: readonly Row[],
  value: (row: Row) => number,
): Column<Row> {
  const peak = Math.max(0, ...rows.map(value));
  return {
    header: "",
    width: 10,
    optional: true,
    cell: (row) => theme.fg("accent", bar(peak > 0 ? value(row) / peak : 0, 10)),
  };
}

function dimOffBranch(
  theme: Theme,
  rows: readonly { onBranch: boolean }[],
  lines: string[],
): string[] {
  return lines.map((line, index) =>
    rows[index]?.onBranch === false ? theme.fg("dim", line) : line,
  );
}

function recordLabel(record: UsageRecord): string {
  if (record.source === "assistant") return record.label;
  if (record.source === "tool") return `↳ ${record.label} (tool)`;
  if (record.source === "usage") return `${record.label} · ${record.model ?? "unknown"}`;
  return SOURCE_LABELS[record.source];
}

function failed(record: UsageRecord): boolean {
  return record.stopReason === "error" || record.stopReason === "aborted";
}

/**
 * Draws a row on the selection background. Truncated cells end with a full reset, which
 * also clears the background, so the background is applied again after each reset.
 */
function highlight(theme: Theme, line: string, width: number): string {
  const closeBackground = "\u001b[49m";
  const openBackground = theme.bg("selectedBg", "").slice(0, -closeBackground.length);
  let highlighted = fit(line, width);
  for (const reset of ["\u001b[0m", "\u001b[m", closeBackground]) {
    highlighted = highlighted.replaceAll(reset, reset + openBackground);
  }
  return openBackground + highlighted + closeBackground;
}

function tabWidth(width: number): number {
  return Math.floor(width / TAB_NAMES.length);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(Math.max(min, max), value));
}
