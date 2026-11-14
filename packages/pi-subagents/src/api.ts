import type { Usage } from "@earendil-works/pi-ai";

/** Status of one named agent. Names stay reserved after a run ends. */
export type SubagentStatus =
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "stopped"
  | "failed"
  | "interrupted";

/** Thinking levels accepted by Pi 1.5. */
export type SubagentThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Token counters for the latest start or continuation. */
export interface SubagentTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

/** Identity shared by every event about one agent. */
export interface SubagentEvent {
  sessionId: string;
  id: string;
  name: string;
  agentType: string;
}

/** Emitted once restoration and tool registration finish. */
export interface SubagentsReadyEvent {
  sessionId: string;
}

/** Emitted when a new task name is assigned, before the agent starts or queues. */
export interface SubagentCreatedEvent extends SubagentEvent {
  task: string;
  background: boolean;
}

/** Emitted for each start or continuation after the agent leaves the queue. */
export interface SubagentStartedEvent extends SubagentEvent {
  run: number;
  model: string;
  thinking: SubagentThinking;
}

/** Emitted when the agent's activity or progress counters change. */
export interface SubagentActivityEvent extends SubagentEvent {
  activity: string;
  turns: number;
  toolUses: number;
  contextPercent: number | null;
}

/** Emitted after the main model's correction is accepted. */
export interface SubagentSteeredEvent extends SubagentEvent {
  message: string;
}

/** Emitted once per finalized assistant message, with only that message's usage. */
export interface SubagentUsageEvent extends SubagentEvent {
  usage: Usage;
}

/** Emitted after a successful run, including a partial turn-limited answer. */
export interface SubagentCompletedEvent extends SubagentEvent {
  run: number;
  status: SubagentStatus;
  result: string;
  partial: boolean;
  tokens: SubagentTokens;
  toolUses: number;
  durationMs: number;
}

/** Emitted after a failed, stopped, or interrupted run, with partial text when available. */
export interface SubagentFailedEvent extends SubagentCompletedEvent {
  error?: string;
}

/** Emitted after shutdown drains all agent work. No agent events follow it. */
export interface SubagentsDisposedEvent {
  sessionId: string;
}

/** Observation-only event names and payloads on pi.events. */
export interface SubagentsEventMap {
  "subagents:ready": SubagentsReadyEvent;
  "subagents:created": SubagentCreatedEvent;
  "subagents:started": SubagentStartedEvent;
  "subagents:activity": SubagentActivityEvent;
  "subagents:steered": SubagentSteeredEvent;
  "subagents:usage": SubagentUsageEvent;
  "subagents:completed": SubagentCompletedEvent;
  "subagents:failed": SubagentFailedEvent;
  "subagents:disposed": SubagentsDisposedEvent;
}
