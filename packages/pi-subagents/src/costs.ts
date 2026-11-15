import type { Usage } from "@earendil-works/pi-ai";

/**
 * Custom entry type that stores what one agent run used, in the main session. It is written once
 * per run, when the run ends. Its data is a `SubagentRunUsage`.
 */
export const SUBAGENT_USAGE_ENTRY = "subagents-usage";

/** What one agent run used. A run that used no tokens saves none. */
export interface SubagentRunUsage {
  sessionId: string;
  id: string;
  name: string;
  agentType: string;
  /** Counts starts and continuations of the agent, from 1. */
  run: number;
  provider: string;
  model: string;
  /** The sum of every model reply in the run, with Pi's cost for each. */
  usage: Usage;
}

/** A usage total that starts at zero. */
export function emptySubagentUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Whether a usage total holds any tokens. A reply stopped before it began reports none. */
export function hasSubagentUsage(usage: Usage): boolean {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
}

/** Adds one model reply's usage to a run's total. */
export function addSubagentUsage(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;
}

/** The cost total of a saved `subagents-usage` entry, or 0 when the entry is not one. */
export function savedSubagentCost(data: unknown): number {
  if (typeof data !== "object" || data === null || !("usage" in data)) return 0;
  const { usage } = data;
  if (typeof usage !== "object" || usage === null || !("cost" in usage)) return 0;
  const { cost } = usage;
  if (typeof cost !== "object" || cost === null || !("total" in cost)) return 0;
  return typeof cost.total === "number" ? cost.total : 0;
}
