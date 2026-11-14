import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

import type { SubagentManager } from "../manager.ts";

/**
 * Ctrl+B moves all running foreground agents to the background (S6). It acts only while one runs
 * and no dialog is open. Otherwise the key keeps its editor meaning. Returns the cleanup function.
 */
export function installBackgroundShortcut(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  manager: SubagentManager,
): () => void {
  let openPrompts = 0;
  const offStart = pi.on("ui_prompt_start", () => {
    openPrompts++;
  });
  const offEnd = pi.on("ui_prompt_end", () => {
    openPrompts = Math.max(0, openPrompts - 1);
  });
  const offInput = ctx.ui.onTerminalInput((data) => {
    if (isKeyRelease(data) || !matchesKey(data, "ctrl+b")) return undefined;
    if (openPrompts > 0 || !manager.hasForeground()) return undefined;
    manager.moveForegroundToBackground();
    return { consume: true };
  });
  return () => {
    offStart();
    offEnd();
    offInput();
  };
}
