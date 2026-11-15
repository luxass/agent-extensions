import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SubagentManager } from "../manager.ts";

/** Key of the agent cost text in the footer's status line. */
export const SUBAGENT_COST_STATUS = "subagents";

/**
 * Shows what this session's agents cost in the footer's status line, for example `agents $0.123`.
 * Pi's own cost total counts only the main session, and an extension cannot add to it, so agent
 * costs get their own number. It appears once an agent has used a model and follows running agents.
 */
export function installSubagentCostStatus(ctx: ExtensionContext, manager: SubagentManager): void {
  let shown: string | undefined;
  const update = () => {
    // Three decimals, like the cost in Pi's footer.
    const text = manager.hasAgentUsage() ? `agents $${manager.agentCost().toFixed(3)}` : undefined;
    if (text === shown) return;
    shown = text;
    ctx.ui.setStatus(SUBAGENT_COST_STATUS, text);
  };
  manager.subscribe(update);
  update();
}
