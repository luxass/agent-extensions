import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import type { SubagentDefinition } from "./agents.ts";
import type { SubagentRecord } from "./manager.ts";

/** What the `Agent` tool's result and progress carry, so the card can find its agent. */
export interface AgentToolDetails {
  id?: string;
  /** The run this call started, so its card keeps that run's outcome after a later resume. */
  run?: number;
}

/** A plain text tool result that points the card at its agent. */
export function subagentToolResult(
  text: string,
  details: AgentToolDetails = {},
): AgentToolResult<AgentToolDetails> {
  return { content: [{ type: "text", text }], details };
}

/** One line for the model: task name, type, status, and whether the turn limit cut it short. */
export function subagentStatusLine(record: SubagentRecord): string {
  const partial = record.partial ? " (partial: turn limit reached)" : "";
  return `${record.name} (${record.agentType}) is ${record.status}${partial}.`;
}

/** The status line followed by the agent's answer, or its error when it has none. */
export function subagentFinishedText(record: SubagentRecord): string {
  const body = record.result || record.error || "(no answer)";
  const error = record.error && record.result ? `\nError: ${record.error}` : "";
  return `${subagentStatusLine(record)}\n\n${body}${error}`;
}

/** Describes the available types and their tools, so the model can choose (S1). */
export function agentToolDescription(available: readonly SubagentDefinition[] | undefined): string {
  const types = (available ?? [])
    .map((definition) => {
      const tools = (definition.tools ?? ["read", "bash", "edit", "write"]).join(", ");
      return `- ${definition.name}: ${definition.description} Tools: ${tools}.`;
    })
    .join("\n");
  return [
    "Start an agent that works on a task in its own conversation, or continue a finished agent with resume.",
    "Agents run in the background by default, and their results arrive by themselves. Set run_in_background: false to wait for the answer.",
    "Every new agent needs a unique task name. Agents share the project's files and cannot start other agents.",
    "A user message that starts with @<agent type> asks for a new agent of that type.",
    "",
    "When to delegate:",
    "- Delegate self-contained work that can run while you do something else, such as a separate search, review, or change.",
    "- Do the work yourself when your next step depends on it, or when it is quicker than writing the brief.",
    "",
    "Writing the prompt:",
    "- A new agent knows only its prompt, unless inherit_context is true. Brief it like a capable colleague who has not seen this conversation: the goal, the relevant files, what you already know or tried, and what to report back.",
    "- Ask for the concrete result you need next, not open-ended exploration.",
    "- Agents that edit files at the same time must change different files.",
    "",
    "After starting:",
    "- Do not poll a background agent, wait for it, or repeat its work. Continue with other work, or tell the user what you started and end your turn.",
    "- Use steer_subagent to correct a running agent, and resume to give a finished agent a follow-up.",
    "- The user sees only a short preview of each result. Tell them what matters.",
    "",
    "Available agent types:",
    // Without a list, the session has not started and no request can reach the model yet.
    available ? types || "- none" : "- listed when the session has started",
  ].join("\n");
}
