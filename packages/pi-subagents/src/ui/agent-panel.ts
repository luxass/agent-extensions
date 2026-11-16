import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

import type { SubagentRecord } from "../manager.ts";
import type { SubagentList, SubagentListFilter } from "./agent-list.ts";
import type { SubagentPreview } from "./agent-preview.ts";
import { subagentBadge, subagentElapsed, subagentTaskTitle } from "./agent-status.ts";
import { fitLine, lineEnds } from "./text-layout.ts";

/** A clickable span of one line. `key` is the key the click stands for. */
interface PanelHit {
  start: number;
  end: number;
  key: string;
}

/** Where one render drew each part of the panel, for mouse events. Rows count from the top. */
export interface AgentPanelLayout {
  /** Column of the first content cell. */
  contentX: number;
  headerY: number;
  filterY: number;
  /** First row of the list, or of the answer when the list is not drawn. */
  bodyY: number;
  footerY: number;
  /** Column where the fullscreen hint starts on the header row. */
  expandX: number;
  /** True when the list and the answer are side by side. */
  wide: boolean;
  listWidth: number;
  /** Rows the list takes. Zero when it is not drawn. */
  listHeight: number;
  filterHits: { start: number; end: number; filter: SubagentListFilter }[];
  navHits: PanelHit[];
  actionHits: PanelHit[];
}

/** What the panel draws from. */
export interface AgentPanelState {
  theme: Theme;
  tui: TUI;
  list: SubagentList;
  preview: SubagentPreview;
  fullscreen: boolean;
  /** True when Up and Down scroll the answer, false when they select an agent. */
  previewFocused: boolean;
  redraw: () => void;
}

const FILTER_TABS: { filter: SubagentListFilter; label: string }[] = [
  { filter: "all", label: "All" },
  { filter: "active", label: "Active" },
  { filter: "finished", label: "Finished" },
];

/** The filter tabs with their counts, such as "All 3   Active 1   Finished 2". */
function filterTabs(state: AgentPanelState, layout: AgentPanelLayout, width: number): string {
  const { theme, list } = state;
  const counts = list.counts();
  let line = "";
  layout.filterHits = [];
  for (const [index, tab] of FILTER_TABS.entries()) {
    const start = visibleWidth(line) + layout.contentX;
    const label = `${tab.label} ${counts[tab.filter]}`;
    line +=
      list.filter === tab.filter ? theme.fg("accent", theme.bold(label)) : theme.fg("muted", label);
    layout.filterHits.push({
      start,
      end: visibleWidth(line) + layout.contentX,
      filter: tab.filter,
    });
    if (index < FILTER_TABS.length - 1) line += "   ";
  }
  return fitLine(line, width);
}

/** "Output   Conversation" above the answer in the wide layout. A click on the second opens it. */
function viewTabs(state: AgentPanelState, layout: AgentPanelLayout, width: number): string {
  const { theme } = state;
  const offset = layout.contentX + layout.listWidth + 3;
  const output = theme.fg("accent", theme.bold("Output"));
  const conversationStart = offset + visibleWidth(output) + 3;
  layout.navHits = [
    { start: conversationStart, end: conversationStart + "Conversation".length, key: "enter" },
  ];
  return fitLine(`${output}   ${theme.fg("muted", "Conversation")}`, width);
}

/** The one quiet footer: the keys that apply now on the left, Esc on the right. */
function actionHints(
  state: AgentPanelState,
  layout: AgentPanelLayout,
  record: SubagentRecord | undefined,
  width: number,
): string {
  const { theme, list, preview, previewFocused } = state;
  const confirming = list.stopTarget() !== undefined;
  const entries: { key: string; label: string }[] = confirming
    ? [
        { key: "y", label: "y Stop" },
        { key: "n", label: "n Keep running" },
      ]
    : [
        ...(preview.scroll.isFollowingEnd ? [] : [{ key: "end", label: "End Follow" }]),
        { key: "tab", label: previewFocused ? "Tab Agents" : "Tab Output" },
        { key: "enter", label: "Enter Open" },
        ...(record && list.canStop(record) ? [{ key: "x", label: "x Stop" }] : []),
      ];
  const ending = confirming ? "Esc Cancel" : "Esc Close";
  const right = width < 28 ? "Esc" : ending;
  const budget = Math.max(0, width - visibleWidth(right) - 2);
  let left = "";
  layout.actionHits = [];
  for (const entry of entries) {
    const gap = left ? "   " : "";
    if (visibleWidth(left + gap + entry.label) > budget) break;
    left += gap;
    const start = layout.contentX + visibleWidth(left);
    left += entry.label;
    layout.actionHits.push({ start, end: start + visibleWidth(entry.label), key: entry.key });
  }
  layout.actionHits.push({
    start: layout.contentX + width - visibleWidth(right),
    end: layout.contentX + width,
    key: "escape",
  });
  return theme.fg("muted", lineEnds(left, right, width));
}

/** The selected agent's task, status line, and answer, for the wide and the small layout. */
function selectedOutput(
  state: AgentPanelState,
  record: SubagentRecord | undefined,
  width: number,
  height: number,
): string[] {
  const { theme, preview } = state;
  if (!record) {
    return [
      theme.bold("No agents yet"),
      "",
      theme.fg("muted", "Start a task from the conversation."),
    ];
  }
  const paused = !preview.scroll.isFollowingEnd;
  const header = [
    theme.bold(subagentTaskTitle(record)),
    lineEnds(
      `${subagentBadge(record, theme)} · ${theme.fg("muted", `${record.name} · ${record.agentType}`)}`,
      theme.fg("dim", `${subagentElapsed(record)}${paused ? " · Paused" : ""}`),
      width,
    ),
    "",
  ];
  const remaining = Math.max(1, height - header.length);
  return [...header, ...preview.render(record, width, remaining, state.redraw)];
}

function emptyLayout(): AgentPanelLayout {
  return {
    contentX: 0,
    headerY: -1,
    filterY: -1,
    bodyY: 0,
    footerY: -1,
    expandX: 0,
    wide: false,
    listWidth: 1,
    listHeight: 0,
    filterHits: [],
    navHits: [],
    actionHits: [],
  };
}

/** A terminal too small for the frame gets the title, the selected answer, and the footer. */
function renderSmallPanel(
  state: AgentPanelState,
  layout: AgentPanelLayout,
  width: number,
  height: number,
): string[] {
  const { theme, list } = state;
  layout.headerY = height <= 3 ? -1 : 0;
  layout.expandX = Math.max(0, width - 12);
  const bodyHeight = Math.max(1, height - 2);
  const record = list.selected();
  let lines = height <= 3 ? [] : [theme.fg("accent", theme.bold("Agents"))];
  layout.bodyY = lines.length;
  if (list.stopTarget()) lines.push("Stop this agent? y / n");
  else lines.push(...selectedOutput(state, record, width, bodyHeight).slice(0, bodyHeight));
  lines = lines.slice(0, Math.max(1, height - 1));
  if (height > 1) {
    layout.footerY = lines.length;
    lines.push(actionHints(state, layout, record, width));
  }
  return lines.map((line) => truncateToWidth(line, width));
}

/**
 * Draws the first view of `/agents`: a rounded panel with the agent counts, the filter tabs, the
 * agent list, the selected answer, and the footer. From 104 columns the list and the answer are
 * side by side. Below that the list is on top, with a preview of at most three lines under it.
 */
export function renderAgentPanel(
  state: AgentPanelState,
  width: number,
): { lines: string[]; layout: AgentPanelLayout } {
  const { theme, tui, list, preview, fullscreen, previewFocused } = state;
  const layout = emptyLayout();
  const inner = Math.max(1, width - 6);
  const terminalHeight = Math.max(1, tui.terminal.rows - (fullscreen ? 0 : 4));
  const maximum = fullscreen ? terminalHeight : Math.min(36, terminalHeight);
  const stopTarget = list.stopTarget();
  const available = maximum - 9 - (stopTarget ? 1 : 0);
  if (available < 7 || width < 36) {
    return { lines: renderSmallPanel(state, layout, width, Math.max(1, maximum)), layout };
  }

  layout.contentX = 3;
  layout.headerY = 1;
  layout.filterY = 3;
  layout.bodyY = 5;
  layout.wide = width >= 104;
  layout.listWidth = layout.wide ? Math.min(39, Math.floor(inner * 0.34)) : inner;
  const rightWidth = layout.wide ? Math.max(1, inner - layout.listWidth - 3) : inner;
  const record = list.selected();
  const rows = list.rows();

  const edge = (text: string): string => theme.fg("borderMuted", text);
  const line = (text = ""): string => `${edge("│")}  ${fitLine(text, inner)}  ${edge("│")}`;
  const rule = (left: string, right: string): string =>
    edge(left + "─".repeat(Math.max(0, width - 2)) + right);

  const counts = list.counts();
  const title =
    theme.fg("accent", theme.bold("Agents")) +
    theme.fg(
      "dim",
      counts.active
        ? `   ${counts.active} active${counts.finished ? ` · ${counts.finished} finished` : ""}`
        : counts.all
          ? `   ${counts.finished} finished`
          : "",
    );
  const expand = theme.fg("dim", fullscreen ? "f Restore" : "f Fullscreen");
  layout.expandX = layout.contentX + inner - visibleWidth(expand);

  let body: string[] = [];
  let bodyHeight: number;
  if (layout.wide) {
    const measured = selectedOutput(state, record, rightWidth, available);
    const natural = Math.max(10, Math.min(12, rows.length * 3), measured.length);
    bodyHeight = fullscreen ? available : Math.min(available, natural);
    const left = list.render(layout.listWidth, bodyHeight, false, previewFocused);
    const right = selectedOutput(state, record, rightWidth, bodyHeight);
    const divider = theme.fg(previewFocused ? "borderAccent" : "borderMuted", "│");
    for (let index = 0; index < bodyHeight; index++) {
      body.push(`${fitLine(left[index] ?? "", layout.listWidth)} ${divider} ${right[index] ?? ""}`);
    }
  } else {
    const natural = Math.max(7, rows.length * 2 + 4);
    bodyHeight = fullscreen ? available : Math.min(available, natural);
    const previewHeight = Math.min(3, Math.max(1, Math.floor(bodyHeight / 3)));
    const listBudget = bodyHeight - previewHeight - 1;
    const overflow = rows.length > Math.floor(listBudget / 2);
    body = list.render(inner, Math.max(2, listBudget - (overflow ? 1 : 0)), true, previewFocused);
    if (overflow) {
      const last = Math.min(rows.length, list.start + list.drawnHeight / 2);
      body.push(theme.fg("dim", `${list.start + 1}–${last} of ${rows.length} agents · ↑↓ More`));
    }
    body.push(edge("─".repeat(inner)));
    const answer = record
      ? preview.render(record, inner, previewHeight, state.redraw, true)
      : [theme.fg("muted", "Start a task from the main conversation.")];
    body.push(...answer.slice(0, previewHeight));
  }
  layout.listHeight = list.drawnHeight;
  while (body.length < bodyHeight) body.push("");

  const tabs = layout.wide
    ? `${filterTabs(state, layout, layout.listWidth)}   ${viewTabs(state, layout, rightWidth)}`
    : filterTabs(state, layout, inner);
  const lines = [
    rule("╭", "╮"),
    line(lineEnds(title, expand, inner)),
    line(),
    line(tabs),
    line(),
    ...body.slice(0, bodyHeight).map((text) => line(text)),
    line(),
  ];
  if (stopTarget) {
    lines.push(line(theme.fg("warning", `Stop “${subagentTaskTitle(stopTarget)}”?  y / n`)));
  }
  lines.push(rule("├", "┤"));
  layout.footerY = lines.length;
  lines.push(line(actionHints(state, layout, record, inner)), rule("╰", "╯"));
  return { lines: lines.map((text) => truncateToWidth(text, width)), layout };
}
