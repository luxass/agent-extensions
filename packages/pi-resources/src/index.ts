import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ResourcesDialog } from "./dialog.ts";
import { captureResourceLoader } from "./loader-hook.ts";
import { collectResources } from "./resources.ts";

export default function (pi: ExtensionAPI) {
  const capture = captureResourceLoader("resources");
  pi.on("session_shutdown", () => capture.dispose());

  pi.registerCommand("resources", {
    description: "Browse resources and registered tools in a tabbed dialog",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      const resourceLoader = capture.read();
      if (!resourceLoader) {
        ctx.ui.notify(
          "Could not capture Pi's resource loader. Reload Pi before using /resources.",
          "error",
        );
        return;
      }
      const resources = collectResources({
        pi,
        loader: resourceLoader,
        cwd: ctx.cwd,
      });

      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) =>
          new ResourcesDialog({ tui, theme, keybindings, resources, done }),
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
    },
  });
}
