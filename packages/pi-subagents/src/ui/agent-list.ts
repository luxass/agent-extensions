import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { isSubagentFinished, type SubagentManager, type SubagentRecord } from "../manager.ts";
import { subagentStatusLabel, subagentStatusMark } from "./agent-status.ts";

/** Left pane of `/agents`: every agent of the session, with a selection that follows the agent (S8). */
export class SubagentList {
  private selectedId: string | undefined;
  private top = 0;
  private renderedIds: (string | undefined)[] = [];
  /** Agent whose stop waits for a second `x` (S8). */
  confirmStopId: string | undefined;

  constructor(
    private readonly theme: Theme,
    private readonly manager: SubagentManager,
  ) {}

  /** The selected agent. Falls back to the newest agent when the selection is gone. */
  selected(): SubagentRecord | undefined {
    const records = this.manager.list();
    const selected = records.find((record) => record.id === this.selectedId) ?? records.at(-1);
    this.selectedId = selected?.id;
    return selected;
  }

  select(id: string | undefined): void {
    if (id !== this.selectedId) this.confirmStopId = undefined;
    this.selectedId = id;
  }

  move(delta: number): void {
    const records = this.manager.list();
    if (!records.length) return;
    const index = records.findIndex((record) => record.id === this.selected()?.id);
    const next = Math.max(0, Math.min(records.length - 1, index + delta));
    this.select(records[next]?.id);
  }

  /** First press asks for confirmation, second press stops the selected agent (S6, S8). */
  async pressStop(): Promise<void> {
    const record = this.selected();
    if (!record || isSubagentFinished(record.status) || record.status === "stopping") return;
    if (this.confirmStopId !== record.id) {
      this.confirmStopId = record.id;
      return;
    }
    this.confirmStopId = undefined;
    await this.manager.stop(record.name, "user");
  }

  /** Agent drawn at a pane line, for mouse selection. */
  idAtLine(line: number): string | undefined {
    return this.renderedIds[line];
  }

  /** Renders exactly `height` lines of `width` columns. */
  render(width: number, height: number, focused: boolean): string[] {
    const { theme } = this;
    const records = this.manager.list();
    const selectedIndex = records.findIndex((record) => record.id === this.selected()?.id);
    if (selectedIndex < this.top) this.top = Math.max(0, selectedIndex);
    if (selectedIndex >= this.top + height) this.top = selectedIndex - height + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, records.length - height)));

    const lines: string[] = [];
    this.renderedIds = [];
    for (const record of records.slice(this.top, this.top + height)) {
      const selected = record.id === this.selectedId;
      const pointer = selected ? theme.fg(focused ? "accent" : "muted", "›") : " ";
      const name = selected ? theme.bold(record.name) : record.name;
      const right = theme.fg("dim", `${record.agentType} · ${subagentStatusLabel(record)}`);
      const left = `${pointer} ${subagentStatusMark(record, theme)} ${name}`;
      const gap = width - visibleWidth(left) - visibleWidth(right);
      const line =
        gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(left, width, "…");
      lines.push(truncateToWidth(line, width, ""));
      this.renderedIds.push(record.id);
    }
    if (!records.length) lines.push(theme.fg("dim", " No agents yet."));
    while (lines.length < height) lines.push("");
    return lines.map((line) => {
      const fitted = truncateToWidth(line, width, "");
      return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
    });
  }
}
