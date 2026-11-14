import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { SubagentManager } from "../manager.ts";
import {
  cleanSubagentText,
  showsBackgroundHint,
  subagentCounters,
  subagentStatusMark,
} from "./agent-status.ts";

const ANIMATION_INTERVAL_MS = 120;

/**
 * Shows running and queued agents above the editor (S8). The widget is always installed, so its
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
          const activity = cleanSubagentText(record.activity);
          const hint = showsBackgroundHint(record)
            ? theme.fg("dim", "  (ctrl+b to run in background)")
            : "";
          const line =
            `${subagentStatusMark(record, theme)} ${theme.bold(record.name)} ${theme.fg("dim", record.agentType)}` +
            ` ${theme.fg("muted", "·")} ${activity} ${theme.fg("dim", `· ${subagentCounters(record)}`)}${hint}`;
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
