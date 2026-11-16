import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import { isSubagentFinished, type SubagentManager, type SubagentRecord } from "../manager.ts";
import {
  SUBAGENT_BADGE_WIDTH,
  subagentBadge,
  subagentElapsed,
  subagentTaskTitle,
} from "./agent-status.ts";
import { fitLine } from "./text-layout.ts";

/** Which agents the list shows. An agent is active until it has finished. */
export type SubagentListFilter = "all" | "active" | "finished";

/**
 * The agent list of `/agents`: which agents the filter shows, their order, and the selection.
 * Each agent takes two lines, its task and then its name, status, and elapsed time.
 */
export class SubagentList {
  filter: SubagentListFilter = "all";
  private selectedId: string | undefined;
  /** Index of the first agent drawn, so a long list scrolls with the selection. */
  start = 0;
  /** Lines one agent takes in the last render: 2, or 3 with a blank line between agents. */
  rowHeight = 2;
  /** Lines the agents took in the last render. Zero when the list was not drawn. */
  drawnHeight = 0;
  private stopTargetId: string | undefined;

  constructor(
    private readonly theme: Theme,
    private readonly manager: SubagentManager,
  ) {}

  /** The agents the filter shows: unfinished agents first, and the newest first in each group. */
  rows(): SubagentRecord[] {
    const newestFirst = this.manager.list().toReversed();
    const shown =
      this.filter === "all"
        ? newestFirst
        : newestFirst.filter(
            (record) => isSubagentFinished(record.status) === (this.filter === "finished"),
          );
    // The sort is stable, so each group keeps its newest-first order.
    return shown.toSorted(
      (first, second) =>
        Number(isSubagentFinished(first.status)) - Number(isSubagentFinished(second.status)),
    );
  }

  /** How many agents each filter tab holds. */
  counts(): Record<SubagentListFilter, number> {
    const all = this.manager.list();
    const finished = all.filter((record) => isSubagentFinished(record.status)).length;
    return { all: all.length, active: all.length - finished, finished };
  }

  /** The selected agent. Falls back to the first shown agent when the selection is not shown. */
  selected(): SubagentRecord | undefined {
    const rows = this.rows();
    const selected = rows.find((record) => record.id === this.selectedId) ?? rows[0];
    this.selectedId = selected?.id;
    return selected;
  }

  select(id: string | undefined): void {
    this.selectedId = id;
  }

  move(delta: number): void {
    const rows = this.rows();
    if (!rows.length) return;
    const index = rows.findIndex((record) => record.id === this.selected()?.id);
    const next = Math.max(0, Math.min(rows.length - 1, index + delta));
    this.select(rows[next]?.id);
  }

  setFilter(filter: SubagentListFilter): void {
    this.filter = filter;
  }

  /** Whether the agent can be stopped: it is queued or running. */
  canStop(record: SubagentRecord): boolean {
    return !isSubagentFinished(record.status) && record.status !== "stopping";
  }

  /** Asks to stop the selected agent. The stop waits for `confirmStop`. */
  askStop(): void {
    const record = this.selected();
    if (record && this.canStop(record)) this.stopTargetId = record.id;
  }

  /** The agent whose stop waits for an answer. The wait ends when the agent finishes by itself. */
  stopTarget(): SubagentRecord | undefined {
    const record = this.stopTargetId ? this.manager.records.get(this.stopTargetId) : undefined;
    if (record && this.canStop(record)) return record;
    this.stopTargetId = undefined;
    return undefined;
  }

  /** Answers the stop question. Yes stops the agent as the user. */
  async confirmStop(yes: boolean): Promise<void> {
    const record = this.stopTarget();
    this.stopTargetId = undefined;
    if (yes && record) await this.manager.stop(record.name, "user");
  }

  /** The agent drawn at a line of the list, counted from the list's first line. */
  idAtLine(line: number): string | undefined {
    if (line < 0 || line >= this.drawnHeight) return undefined;
    return this.rows()[this.start + Math.floor(line / this.rowHeight)]?.id;
  }

  /**
   * Draws the agents in `width` columns and at most `height` lines. `compact` rows have no blank
   * line between agents and show the type next to the name. The selection mark dims while the
   * preview has the focus.
   */
  render(width: number, height: number, compact: boolean, previewFocused: boolean): string[] {
    const { theme } = this;
    const rows = this.rows();
    this.rowHeight = compact ? 2 : 3;
    const slots = Math.max(1, Math.floor(height / this.rowHeight));
    this.drawnHeight = Math.min(height, slots * this.rowHeight, rows.length * this.rowHeight);
    const index = Math.max(
      0,
      rows.findIndex((record) => record.id === this.selected()?.id),
    );
    this.start = Math.max(0, Math.min(this.start, index, Math.max(0, rows.length - slots)));
    if (index >= this.start + slots) this.start = index - slots + 1;

    const durationWidth = rows.reduce(
      (widest, record) => Math.max(widest, visibleWidth(subagentElapsed(record))),
      6,
    );
    const identityWidth = Math.max(0, width - SUBAGENT_BADGE_WIDTH - durationWidth - 4);
    const lines: string[] = [];
    for (const record of rows.slice(this.start, this.start + slots)) {
      const selected = record.id === this.selectedId;
      const marker = selected ? theme.fg(previewFocused ? "muted" : "accent", "▌ ") : "  ";
      const task = subagentTaskTitle(record);
      const title = fitLine(`${marker}${selected ? theme.bold(task) : task}`, width);
      const badge = subagentBadge(record, theme);
      const identity = compact ? `${record.name} · ${record.agentType}` : record.name;
      const caption = fitLine(`${marker}${theme.fg("muted", identity)}`, identityWidth);
      const duration = subagentElapsed(record);
      const timing = theme.fg(
        "dim",
        " ".repeat(Math.max(0, durationWidth - visibleWidth(duration))) + duration,
      );
      const alignedBadge =
        " ".repeat(Math.max(0, SUBAGENT_BADGE_WIDTH - visibleWidth(badge))) + badge;
      const details = `${caption} · ${alignedBadge} ${timing}`;
      lines.push(
        selected ? theme.bg("selectedBg", title) : title,
        selected ? theme.bg("selectedBg", details) : details,
      );
      if (!compact) lines.push("");
    }
    if (!lines.length) lines.push(theme.fg("dim", "No matching agents"));
    return lines;
  }
}
