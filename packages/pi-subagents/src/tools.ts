import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import type { SubagentThinking } from "./api.ts";
import { isSubagentFinished, type SubagentManager } from "./manager.ts";
import {
  agentToolDescription,
  subagentFinishedText,
  subagentStatusLine,
  subagentToolResult,
  type AgentToolDetails,
} from "./tool-text.ts";
import { AgentCardBody, subagentTitle } from "./ui/agent-card.ts";

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const agentParameters = Type.Object({
  subagent_type: Type.Optional(
    Type.String({ description: "Agent type for a new agent. Required unless resume is set." }),
  ),
  name: Type.Optional(
    Type.String({
      description:
        "Unique task name for a new agent: lowercase words joined by hyphens, such as auth-review. Required unless resume is set. Names are never reused in a session.",
    }),
  ),
  prompt: Type.String({ description: "The task, or for resume the follow-up instruction." }),
  resume: Type.Optional(
    Type.String({
      description: "Task name of a finished agent to continue in its saved conversation.",
    }),
  ),
  run_in_background: Type.Optional(
    Type.Boolean({
      description: "false waits for the answer. Otherwise the result arrives later by itself.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "provider/id, or part of one that matches exactly one model." }),
  ),
  thinking: Type.Optional(StringEnum(thinkingLevels, { description: "Thinking level." })),
  max_turns: Type.Optional(
    Type.Integer({ minimum: 0, description: "Turn limit. 0 means unlimited." }),
  ),
  inherit_context: Type.Optional(
    Type.Boolean({ description: "Give the agent a copy of the conversation you currently see." }),
  ),
});

const nameParameter = Type.Object({
  name: Type.String({ description: "Task name returned by Agent." }),
});

/** Registers the main session's tools: Agent, get_subagent_result, steer_subagent, stop_subagent. */
export function registerSubagentTools(pi: ExtensionAPI, manager: SubagentManager): void {
  pi.registerTool({
    name: "Agent",
    label: "Agent",
    description: agentToolDescription(manager),
    promptSnippet: "Delegate a task to a named agent that works in its own conversation",
    parameters: agentParameters,
    renderCall(args, theme) {
      const title = args.resume
        ? subagentTitle(theme, "resume", args.resume)
        : subagentTitle(theme, args.subagent_type, args.name);
      return new Text(title, 0, 0);
    },
    renderResult(result, options, theme, context) {
      const { id, run } = (result.details as AgentToolDetails | undefined) ?? {};
      if (!context.isError && id && manager.records.has(id)) {
        const hint = context.keyHint("app.tools.expand", "to expand");
        return new AgentCardBody(() => manager.runOutcome(id, run), theme, options.expanded, hint);
      }
      const text = result.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
      return new Text(theme.fg(context.isError ? "error" : "text", text), 0, 0);
    },
    async execute(_toolCallId, params, signal, onUpdate) {
      // Checked before the launch changes the record.
      const continued = params.resume ? manager.find(params.resume) : undefined;
      const startedOver =
        continued && manager.continuesWithoutConversation(continued)
          ? `${continued.name} was interrupted before it started, so it has no earlier conversation. It began now with only this prompt.\n\n`
          : "";
      // StringEnum keeps the schema provider-friendly but types its value as unknown.
      const record = manager.launch({
        ...params,
        thinking: params.thinking as SubagentThinking | undefined,
      });
      const details = { id: record.id, run: record.run };
      if (record.background) {
        const where =
          record.status === "queued" ? "queued for the background" : "running in the background";
        return subagentToolResult(
          `${startedOver}Started ${record.name} (${record.agentType}), ${where}. Its result arrives by itself. Do not poll it or repeat its work. Continue with other work, or tell the user what you started and end your turn.`,
          details,
        );
      }
      const update = () =>
        onUpdate?.(subagentToolResult(`${record.name}: ${record.activity}`, details));
      const unsubscribe = manager.subscribe(update);
      try {
        const outcome = await manager.waitForeground(record, signal);
        if (outcome === "background") {
          return subagentToolResult(
            `${record.name} moved to the background. Its result arrives by itself. Do not poll it or repeat its work.`,
            details,
          );
        }
        if (outcome === "aborted")
          return subagentToolResult(
            `Stopped ${record.name} because you were interrupted.`,
            details,
          );
        return subagentToolResult(startedOver + subagentFinishedText(record), details);
      } finally {
        unsubscribe();
      }
    },
  });

  pi.registerTool({
    name: "get_subagent_result",
    label: "Agent result",
    description:
      "Read the full result of a finished agent by task name. For a running or queued agent, report its status without waiting.",
    parameters: nameParameter,
    async execute(_toolCallId, params) {
      const record = manager.find(params.name);
      if (!record) throw new Error(`No agent named "${params.name}" exists in this session.`);
      if (!isSubagentFinished(record.status)) {
        return subagentToolResult(
          `${subagentStatusLine(record)} Current activity: ${record.activity}.`,
          {
            id: record.id,
          },
        );
      }
      manager.markReceipt(record, "consumed");
      return subagentToolResult(subagentFinishedText(record), { id: record.id });
    },
  });

  pi.registerTool({
    name: "steer_subagent",
    label: "Steer agent",
    description: "Send a correction to a running or queued agent by task name.",
    parameters: Type.Object({
      name: Type.String({ description: "Task name returned by Agent." }),
      message: Type.String({ description: "The correction for the agent." }),
    }),
    async execute(_toolCallId, params) {
      const record = await manager.steer(params.name, params.message);
      return subagentToolResult(`Sent the correction to ${record.name}.`, { id: record.id });
    },
  });

  pi.registerTool({
    name: "stop_subagent",
    label: "Stop agent",
    description:
      "Stop a running or queued agent by task name. Other agents keep running. No result is sent afterwards.",
    parameters: nameParameter,
    async execute(_toolCallId, params) {
      const record = await manager.stop(params.name, "model");
      return subagentToolResult(subagentStatusLine(record), { id: record.id });
    },
  });
}
