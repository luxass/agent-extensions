import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadSubagentDefinitions } from "./agents.ts";
import { SubagentManager } from "./manager.ts";
import {
  SUBAGENT_MENTION_MESSAGE,
  subagentMentionAutocomplete,
  subagentMentionInstruction,
} from "./mentions.ts";
import { SUBAGENT_RESULT_MESSAGE, SubagentDelivery } from "./results.ts";
import { readSubagentSettings } from "./settings.ts";
import { registerSubagentTools } from "./tools.ts";
import { renderSubagentResultMessage } from "./ui/agent-card.ts";
import { installBackgroundShortcut } from "./ui/background-shortcut.ts";
import { openSubagentViewer } from "./ui/viewer.ts";
import { installSubagentWidget } from "./ui/widget.ts";

/** Pi entry point for @luxass/pi-subagents. */
export default function piSubagents(pi: ExtensionAPI): void {
  let manager: SubagentManager | undefined;
  let delivery: SubagentDelivery | undefined;
  let removeShortcut: (() => void) | undefined;

  pi.registerMessageRenderer(SUBAGENT_RESULT_MESSAGE, renderSubagentResultMessage);

  pi.registerCommand("agents", {
    description: "Show agents and their conversations",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/agents needs the interactive terminal.", "error");
        return;
      }
      if (!manager) return;
      await openSubagentViewer(ctx, manager);
    },
  });

  // Setup waits for session_start because the factory has no ExtensionContext: no working
  // directory, no session id, and no trust decision yet. Pi runs this factory before it asks about
  // project trust, so project agents and settings could not be filtered there. Pi also runs
  // factories in invocations that never start a session. /new, /resume, /fork, and /reload load a
  // new runtime, so this runs again for each session (S3, S7).
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const warn = (message: string) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.error(`[pi-subagents] ${message}`);
    };
    const settings = readSubagentSettings(
      (pi.getSettings() as Record<string, unknown>).subagents,
      warn,
    );
    const definitions = await loadSubagentDefinitions(ctx.cwd, ctx.isProjectTrusted(), warn);
    const sessionId = ctx.sessionManager.getSessionId();
    manager = new SubagentManager(pi, ctx, sessionId, definitions, settings);
    manager.restore();
    delivery = new SubagentDelivery(pi, ctx, manager);
    registerSubagentTools(pi, manager);
    if (ctx.mode === "tui") {
      const current = manager;
      ctx.ui.addAutocompleteProvider(subagentMentionAutocomplete(() => current.availableTypes()));
      installSubagentWidget(ctx, current);
      removeShortcut = installBackgroundShortcut(pi, ctx, current);
    }
    pi.events.emit("subagents:ready", { sessionId });
  });

  // A leading type mention asks the main model to start that type. The instruction stays hidden (S2).
  pi.on("before_agent_start", (event, ctx) => {
    if (!manager || event.messageType !== "user" || ctx.mode !== "tui") return undefined;
    const instruction = subagentMentionInstruction(event.prompt, manager.availableTypes());
    if (!instruction) return undefined;
    return {
      message: { customType: SUBAGENT_MENTION_MESSAGE, content: instruction, display: false },
    };
  });

  // Requests are counted per agent_start, so grouping follows the user's request, not each turn (S5).
  pi.on("agent_start", () => {
    if (manager) manager.requestId++;
    delivery?.agentStarted();
  });

  pi.on("turn_end", (event) => delivery?.turnEnded(event));

  pi.on("agent_settled", () => delivery?.agentSettled());

  pi.on("session_shutdown", async (_event, ctx) => {
    // Delivery stops first, so aborted runs never deliver (S7).
    delivery?.dispose();
    removeShortcut?.();
    removeShortcut = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget("subagents", undefined);
    delivery = undefined;
    const current = manager;
    manager = undefined;
    await current?.shutdown();
  });
}
