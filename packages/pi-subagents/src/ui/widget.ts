import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

import type { SubagentManager } from "../manager.ts";
import { showsBackgroundHint, subagentStatusMark } from "./agent-status.ts";

const ANIMATION_INTERVAL_MS = 120;

/**
 * Shows one quiet line above the editor while agents work, such as "Agents · 3 running". What
 * each agent is doing is in its `Agent` card and in `/agents`. The widget is always installed,
 * so its timer also animates the cards when `widget` is "off".
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
        const working = manager
          .list()
          .filter(
            (record) =>
              record.status === "running" ||
              record.status === "queued" ||
              record.status === "stopping",
          )
          .filter((record) => mode === "all" || record.background);
        if (!working.length) return [];

        const queued = working.filter((record) => record.status === "queued").length;
        // An agent that is stopping still runs until its session has closed.
        const running = working.length - queued;
        const counts = [
          ...(running ? [`${running} running`] : []),
          ...(queued ? [`${queued} queued`] : []),
        ].join(" · ");
        // The spinner while any agent runs, the queued mark when all of them wait.
        const lead = working.find((record) => record.status !== "queued") ?? working[0];
        const mark = lead ? subagentStatusMark(lead, theme) : "";
        const hint = working.some((record) => showsBackgroundHint(record))
          ? theme.fg("dim", "  (ctrl+b to run in background)")
          : "";
        // One column in, like the chat text above it.
        const line = ` ${mark} Agents ${theme.fg("dim", `· ${counts}`)}${hint}`;
        return [truncateToWidth(line, width, "…")];
      },
      invalidate() {},
      dispose() {
        clearInterval(timer);
        unsubscribe();
      },
    };
  });
}
