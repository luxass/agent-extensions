import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

type UsageEntry = Extract<SessionEntry, { type: "usage" }>;
type AgentMessage = SessionMessageEntry["message"];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type UserMessage = Extract<AgentMessage, { role: "user" }>;

export type Usage = UsageEntry["usage"];

/** Where a usage record came from. Matches the sources Pi adds to its own session totals. */
export type UsageSource = "assistant" | "tool" | "usage" | "compaction" | "branch_summary";

export const SOURCE_LABELS: Record<UsageSource, string> = {
  assistant: "Model requests",
  tool: "Nested tool usage",
  usage: "Background usage",
  compaction: "Compaction summaries",
  branch_summary: "Branch summaries",
};

/** Token counts and costs added up over a group of usage records. */
export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Sum of the four token kinds, as Pi counts it. */
  tokens: number;
  cost: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  count: number;
}

/** Token usage and cost from one session entry, such as a model response. */
export interface UsageRecord {
  entryId: string;
  source: UsageSource;
  /** Model id, tool name, or usage kind. */
  label: string;
  provider?: string;
  model?: string;
  timestamp: number;
  usage: Usage;
  /** Entry id of the user prompt this record belongs to. */
  turnId?: string;
  /** Tool names requested by an assistant message. */
  toolCalls: string[];
  stopReason?: string;
  onBranch: boolean;
}

export interface Turn {
  id: string;
  /** 1-based position among all prompts, in the order they were sent. */
  index: number;
  prompt: string;
  timestamp: number;
  records: UsageRecord[];
  totals: UsageTotals;
  toolCalls: number;
  onBranch: boolean;
}

export interface ModelStat {
  key: string;
  provider?: string;
  model: string;
  totals: UsageTotals;
}

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  durationMs: number;
  /** Usage the tool reported for its own nested model calls. Exact. */
  nested: UsageTotals;
  /** Even split of each calling request's cost across its tool calls. An estimate. */
  share: number;
}

export interface Analysis {
  total: UsageTotals;
  bySource: Map<UsageSource, UsageTotals>;
  records: UsageRecord[];
  turns: Turn[];
  models: ModelStat[];
  tools: ToolStat[];
  /** Requests that used tokens but report zero cost, usually because pricing is unknown. */
  unpriced: number;
  /** Cost of requests that ended with an error or were aborted. */
  failedCost: number;
  failedCount: number;
  /** Cost recorded outside the current session branch. Zero when only that branch is analyzed. */
  offBranchCost: number;
  firstTimestamp?: number;
  lastTimestamp?: number;
}

/** Starts a new set of totals at zero. Every grouping in `analyze()` uses one. */
export function createUsageTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
    cost: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    count: 0,
  };
}

export function addUsage(totals: UsageTotals, usage: Usage): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.tokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  totals.cost += usage.cost.total;
  totals.costInput += usage.cost.input;
  totals.costOutput += usage.cost.output;
  totals.costCacheRead += usage.cost.cacheRead;
  totals.costCacheWrite += usage.cost.cacheWrite;
  totals.count += 1;
}

/** Share of prompt tokens served from the cache. */
export function cacheHitRate(totals: UsageTotals): number | undefined {
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  return prompt > 0 ? totals.cacheRead / prompt : undefined;
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function promptText(message: UserMessage): string {
  const raw =
    typeof message.content === "string"
      ? message.content
      : message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join(" ");
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed || "(empty prompt)";
}

function isPriced(usage: Usage): boolean {
  const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return tokens === 0 || usage.cost.total > 0;
}

function toolCallNames(message: AssistantMessage): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((part) => (part.type === "toolCall" ? [part.name] : []));
}

/**
 * Builds every view of the session from its entries.
 *
 * Accounting follows Pi's `/session` totals: assistant messages, tool results with
 * nested usage, usage entries, and compaction or branch summaries that report usage.
 */
export function analyze(
  entries: readonly SessionEntry[],
  branchIds: ReadonlySet<string>,
): Analysis {
  const total = createUsageTotals();
  const bySource = new Map<UsageSource, UsageTotals>();
  const records: UsageRecord[] = [];
  const turns = new Map<string, Turn>();
  const models = new Map<string, ModelStat>();
  const tools = new Map<string, ToolStat>();
  // Entries are append-only, so a parent always comes before its children.
  const turnOf = new Map<string, string | undefined>();

  let unpriced = 0;
  let failedCost = 0;
  let failedCount = 0;
  let offBranchCost = 0;

  const toolStat = (name: string): ToolStat => {
    let stat = tools.get(name);
    if (!stat) {
      stat = { name, calls: 0, errors: 0, durationMs: 0, nested: createUsageTotals(), share: 0 };
      tools.set(name, stat);
    }
    return stat;
  };

  const addRecord = (record: UsageRecord): void => {
    records.push(record);
    addUsage(total, record.usage);

    let sourceTotals = bySource.get(record.source);
    if (!sourceTotals) {
      sourceTotals = createUsageTotals();
      bySource.set(record.source, sourceTotals);
    }
    addUsage(sourceTotals, record.usage);

    const modelKey = record.model
      ? `${record.provider ?? "unknown"}/${record.model}`
      : `(${SOURCE_LABELS[record.source].toLowerCase()})`;
    let modelStat = models.get(modelKey);
    if (!modelStat) {
      modelStat = {
        key: modelKey,
        provider: record.provider,
        model: record.model ?? SOURCE_LABELS[record.source],
        totals: createUsageTotals(),
      };
      models.set(modelKey, modelStat);
    }
    addUsage(modelStat.totals, record.usage);

    if (!isPriced(record.usage)) unpriced += 1;
    if (!record.onBranch) offBranchCost += record.usage.cost.total;

    const turn = record.turnId ? turns.get(record.turnId) : undefined;
    if (turn) {
      turn.records.push(record);
      addUsage(turn.totals, record.usage);
      turn.toolCalls += record.toolCalls.length;
    }
  };

  for (const entry of entries) {
    const parentTurn = entry.parentId ? turnOf.get(entry.parentId) : undefined;
    const timestamp = parseTimestamp(entry.timestamp);
    const onBranch = branchIds.has(entry.id);

    if (entry.type !== "message") {
      turnOf.set(entry.id, parentTurn);
      const base = { entryId: entry.id, timestamp, turnId: parentTurn, toolCalls: [], onBranch };
      if (entry.type === "usage") {
        addRecord({
          ...base,
          source: "usage",
          label: entry.kind,
          provider: entry.provider,
          model: entry.model,
          usage: entry.usage,
        });
      } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
        addRecord({ ...base, source: entry.type, label: entry.type, usage: entry.usage });
      }
      continue;
    }

    const message = entry.message;
    if (message.role === "user") {
      turnOf.set(entry.id, entry.id);
      turns.set(entry.id, {
        id: entry.id,
        index: turns.size + 1,
        prompt: promptText(message),
        timestamp,
        records: [],
        totals: createUsageTotals(),
        toolCalls: 0,
        onBranch,
      });
      continue;
    }

    turnOf.set(entry.id, parentTurn);

    if (message.role === "assistant") {
      const calls = toolCallNames(message);
      addRecord({
        entryId: entry.id,
        source: "assistant",
        label: message.model,
        provider: message.provider,
        model: message.model,
        timestamp: message.timestamp || timestamp,
        usage: message.usage,
        turnId: parentTurn,
        toolCalls: calls,
        stopReason: message.stopReason,
        onBranch,
      });
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        failedCost += message.usage.cost.total;
        failedCount += 1;
      }
      const share = calls.length > 0 ? message.usage.cost.total / calls.length : 0;
      for (const name of calls) {
        const stat = toolStat(name);
        stat.calls += 1;
        stat.share += share;
      }
    } else if (message.role === "toolResult") {
      const stat = toolStat(message.toolName);
      if (message.isError) stat.errors += 1;
      stat.durationMs += message.durationMs ?? 0;
      if (message.usage) {
        addUsage(stat.nested, message.usage);
        addRecord({
          entryId: entry.id,
          source: "tool",
          label: message.toolName,
          timestamp: message.timestamp || timestamp,
          usage: message.usage,
          turnId: parentTurn,
          toolCalls: [],
          onBranch,
        });
      }
    }
  }

  const ordered = records.toSorted((left, right) => left.timestamp - right.timestamp);

  return {
    total,
    bySource,
    records: ordered,
    turns: [...turns.values()],
    models: [...models.values()].toSorted((left, right) => right.totals.cost - left.totals.cost),
    tools: [...tools.values()].toSorted(
      (left, right) => right.share + right.nested.cost - (left.share + left.nested.cost),
    ),
    unpriced,
    failedCost,
    failedCount,
    offBranchCost,
    firstTimestamp: ordered[0]?.timestamp,
    lastTimestamp: ordered.at(-1)?.timestamp,
  };
}
