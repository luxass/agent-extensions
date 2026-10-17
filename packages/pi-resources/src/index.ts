import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { showResources } from "./dialog.ts";
import { captureResourceLoader } from "./loader-hook.ts";
import { collectResources } from "./snapshot.ts";

export default function (pi: ExtensionAPI) {
  const loader = captureResourceLoader("resources");
  pi.on("session_shutdown", () => loader.dispose());

  pi.registerCommand("resources", {
    description: "Browse resources and registered tools in a tabbed dialog",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      const resourceLoader = loader.read();
      if (!resourceLoader) {
        ctx.ui.notify(
          "Could not capture Pi's resource loader. Reload Pi before using /resources.",
          "error",
        );
        return;
      }
      await showResources(ctx, collectResources(pi, ctx, resourceLoader));
    },
  });
}
