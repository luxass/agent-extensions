import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { analyze } from "./analysis";
import { CostDialog } from "./dialog";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("cost", {
    description: "Explore this session's cost by model, prompt, tool, and request",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/cost needs Pi's terminal interface.", "error");
        return;
      }

      // These listeners belong to this dialog. They are removed when it closes.
      const unsubscribe: Array<() => void> = [];

      try {
        await ctx.ui.custom<void>(
          (tui, theme, keybindings, done) => {
            const dialog = new CostDialog({
              tui,
              theme,
              keybindings,
              load: (onlyCurrentBranch) => {
                const branch = ctx.sessionManager.getBranch();
                const branchIds = new Set(branch.map((entry) => entry.id));
                const entries = onlyCurrentBranch ? branch : ctx.sessionManager.getEntries();
                return analyze(entries, branchIds);
              },
              done,
            });

            // Saved entries are complete by the time a turn ends.
            unsubscribe.push(
              pi.on("turn_end", () => dialog.refresh()),
              pi.on("agent_end", () => dialog.refresh()),
              pi.on("session_shutdown", () => dialog.close()),
            );

            return dialog;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: 110,
              minWidth: 50,
              maxHeight: "85%",
              margin: 2,
            },
          },
        );
      } finally {
        for (const stop of unsubscribe) stop();
      }
    },
  });
}
