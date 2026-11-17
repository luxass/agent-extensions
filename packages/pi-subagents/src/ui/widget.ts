import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { SubagentManager } from "../manager.ts";
import {
  showsBackgroundHint,
  subagentActivity,
  subagentCounters,
  subagentStatusMark,
} from "./agent-status.ts";

const ANIMATION_INTERVAL_MS = 120;

/**
 * Shows running and queued agents above the editor. The widget is always installed, so its
 * timer also animates `Agent` cards when `widget` is "off".
 */
export function installSubagentWidget(ctx: ExtensionContext, manager: SubagentManager): void {
  ctx.ui.setWidget("subagents", (tui, theme) => {
    const unsubscribe = manager.subscribe(() => tui.requestRender());
    const timer = setInterval(() => {
      if (manager.list().some((record) => record.status === "running")) tui.requestRender();
    }, ANIMATION_INTERVAL_MS);
    return {
      render(width) {
        const mode = manager.settings.widget;
        if (mode === "off") return [];
        const rows = manager
          .list()
          .filter(
            (record) =>
              record.status === "running" ||
              record.status === "queued" ||
              record.status === "stopping",
          )
          .filter((record) => mode === "all" || record.background);
        if (!rows.length) return [];
        return rows.map((record) => {
          const hint = showsBackgroundHint(record)
            ? theme.fg("dim", "  (ctrl+b to run in background)")
            : "";
          const name = `${subagentStatusMark(record, theme)} ${theme.bold(record.name)}`;
          const type = ` ${theme.fg("dim", record.agentType)}`;
          const dot = ` ${theme.fg("muted", "·")} `;
          const counters = ` · ${subagentCounters(record)}`;
          // The name and the counters come first. The activity gets the room they leave, and the
          // agent type is shown only when the whole activity still fits beside it.
          const room =
            width -
            visibleWidth(name) -
            visibleWidth(dot) -
            visibleWidth(counters) -
            visibleWidth(hint);
          const withType =
            room - visibleWidth(type) >= visibleWidth(subagentActivity(record, width));
          const activity = subagentActivity(record, withType ? room - visibleWidth(type) : room);
          const line = `${name}${withType ? type : ""}${dot}${activity}${theme.fg("dim", counters)}${hint}`;
          return truncateToWidth(line, width, "…");
        });
      },
      invalidate() {},
      dispose() {
        clearInterval(timer);
        unsubscribe();
      },
    };
  });
}
