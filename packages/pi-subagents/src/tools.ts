import type { Usage as ModelUsage } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { AgentManager } from "./manager.ts";
import {
  inlineView,
  isSettled,
  thinkingSchema,
  turnLimitSchema,
  type AgentView,
  type Owner,
  type Usage,
} from "./types.ts";

export const agentParameters = Type.Object(
  {
    prompt: Type.String({ minLength: 1 }),
    description: Type.Optional(
      Type.String({
        description:
          "A short title of 3 to 6 words, shown in the agent list. For example: Review delivery changes.",
      }),
    ),
    subagent_type: Type.Optional(Type.String()),
    name: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9_-]{1,80}$" })),
    model: Type.Optional(
      Type.String({
        description:
          "Optional provider/modelId override. Use list_subagent_models for choices. Omit to use the definition's default or inherit the parent's model.",
      }),
    ),
    thinking: Type.Optional(thinkingSchema),
    max_turns: Type.Optional(turnLimitSchema),
    isolated: Type.Optional(Type.Boolean()),
    inherit_context: Type.Optional(Type.Boolean()),
    run_in_background: Type.Optional(Type.Boolean()),
    resume: Type.Optional(Type.String()),
    join: Type.Optional(Type.Union([Type.Literal("individual"), Type.Literal("group")])),
  },
  { additionalProperties: false },
);

export type SpawnRequest = Static<typeof agentParameters>;

export const resultParameters = Type.Object({
  agent_id: Type.String(),
  wait: Type.Optional(Type.Boolean()),
  verbose: Type.Optional(Type.Boolean()),
});

export const steerParameters = Type.Object({
  agent_id: Type.String(),
  message: Type.String({ minLength: 1 }),
});

/** Session statistics expose total cost, not provider-specific cost attribution. */
function toolUsage(usage: Usage): ModelUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
  };
}

function result(view: AgentView, usage?: ReturnType<typeof toolUsage>) {
  const body = `${view.displayName} · ${view.task}\nState: ${view.state}${view.error ? `\n${view.error}` : ""}\n${view.result || view.activity}\nAgent: ${view.id}\nAttempt: ${view.attemptId}\nRecord: ${view.outputFile}`;
  return {
    content: [
      {
        type: "text" as const,
        text:
          body.length > 24000
            ? `${body.slice(0, 23800)}\n[Preview truncated; read ${view.outputFile} for the full result.]`
            : body,
      },
    ],
    details: { id: view.id, attemptId: view.attemptId, snapshot: inlineView(view) },
    usage,
    isError: view.state === "failed" || view.state === "cancelled",
  };
}

async function foreground(
  service: AgentManager,
  view: AgentView,
  owner: Owner,
  signal?: AbortSignal,
): Promise<AgentView> {
  const abort = () => {
    const current = service.attempt(view.id, view.attemptId);
    if (current && !current.background)
      void service.stop(view.id, owner, view.attemptId).catch(() => {});
  };

  signal?.addEventListener("abort", abort, { once: true });
  let unsubscribe: (() => void) | undefined;
  service.waiting(owner, view.attemptId, true);
  const handedOff = new Promise<AgentView>((done) => {
    const check = () => {
      const current = service.attempt(view.id, view.attemptId);
      if (current?.background) done(current);
    };

    unsubscribe = service.subscribe(check);
    check();
  });
  try {
    if (signal?.aborted) abort();
    return await Promise.race([service.wait(view.id, view.attemptId, signal), handedOff]);
  } catch (error) {
    if (signal?.aborted && !service.attempt(view.id, view.attemptId)?.background) {
      await service.stop(view.id, owner, view.attemptId);
      return service.attempt(view.id, view.attemptId) ?? view;
    }
    throw error;
  } finally {
    unsubscribe?.();
    signal?.removeEventListener("abort", abort);
    service.waiting(owner, view.attemptId, false);
  }
}

/** Root and nested tools share behavior; only their captured owner/default differs. */
export function createAgentTools(
  provider: AgentManager | ((ctx: ExtensionContext) => Promise<AgentManager>),
  capturedOwner: Owner | undefined,
  root: boolean,
) {
  return [
    defineTool({
      name: "Agent",
      label: "Agent",
      parameters: agentParameters,
      description: root
        ? "Start a focused child agent. Background is the default; completion arrives automatically. Use foreground when your next action needs the result. Agents share the checkout. Use a stable ID or handle to collect, steer, or resume. Resume keeps saved instructions and tool permissions."
        : "Delegate to an allowed child. Nested calls wait in foreground by default so you can collect their results. Explicit background children are cancelled when your attempt finishes; collect needed results before finishing. Children share the checkout.",

      execute: async (_id, params, signal, onUpdate, ctx) => {
        signal?.throwIfAborted();
        const service = typeof provider === "function" ? await provider(ctx) : provider;
        const owner = capturedOwner ?? service.root;
        // Only main-session foreground results add child usage to the main totals.
        // Nested usage already rolls up into the parent attempt.
        const usage = (settled: AgentView) =>
          capturedOwner ? undefined : toolUsage(settled.usage);
        const view = await service.spawn(params, owner);
        if (isSettled(view.state)) {
          service.consume(view.id, view.attemptId, owner);
          return result(view, usage(view));
        }
        if (view.background) return result(view);
        // Send progress only when this child changed. Each update becomes an event in a nested
        // parent's session, which changes the parent and notifies listeners again; reacting to
        // every change would loop forever and block the event loop.
        let sent: AgentView | undefined;
        const unsubscribe = service.subscribe(() => {
          const current = service.attempt(view.id, view.attemptId);
          if (!current || current === sent) return;
          sent = current;
          onUpdate?.(result(current));
        });
        try {
          const completed = await foreground(service, view, owner, signal);
          // A handed-off attempt is still running; its completion arrives as a message.
          if (!isSettled(completed.state)) return result(completed);
          service.consume(completed.id, completed.attemptId, owner);
          return result(completed, usage(completed));
        } finally {
          unsubscribe();
        }
      },
    }),
    defineTool({
      name: "get_subagent_result",
      label: "Agent result",
      parameters: resultParameters,
      description:
        "Read one of your own agents' state and result. wait waits for this attempt, without cancelling it if waiting is interrupted. Terminal collection consumes its pending completion notification. verbose includes conversation data when available.",

      execute: async (_id, params, signal, _update, ctx) => {
        const service = typeof provider === "function" ? await provider(ctx) : provider;
        const owner = capturedOwner ?? service.root;
        let view = service.get(params.agent_id, owner);
        if (params.wait) {
          service.waiting(owner, view.attemptId, true);
          try {
            view = await service.wait(view.id, view.attemptId, signal);
          } finally {
            service.waiting(owner, view.attemptId, false);
          }
        }
        if (isSettled(view.state)) service.consume(view.id, view.attemptId, owner);
        const response = result(view);
        if (params.verbose) {
          await service.loadTranscript(view.id, view.attemptId).catch((error: unknown) => {
            response.content.push({ type: "text", text: String(error) });
          });
          const transcript = JSON.stringify(service.attempt(view.id, view.attemptId)?.transcript);
          if (transcript)
            response.content.push({
              type: "text",
              text:
                transcript.length <= 100000
                  ? transcript
                  : `Conversation is large; read ${view.sessionFile ?? view.outputFile}.`,
            });
        }
        return response;
      },
    }),
    defineTool({
      name: "steer_subagent",
      label: "Steer agent",
      parameters: steerParameters,
      description:
        "Send instructions to one of your running child attempts. Steering takes effect at the next safe execution boundary.",

      execute: async (_id, params, signal, _update, ctx) => {
        const service = typeof provider === "function" ? await provider(ctx) : provider;
        const owner = capturedOwner ?? service.root;
        signal?.throwIfAborted();
        const view = service.get(params.agent_id, owner);
        await service.steer(view.id, params.message, owner, view.attemptId);
        return { content: [{ type: "text", text: "Instructions queued." }], details: undefined };
      },
    }),
    defineTool({
      name: "list_subagent_models",
      label: "Subagent models",
      description:
        "List current provider/modelId choices for explicit Agent model overrides. Omit Agent.model to use the definition's default or inherit the parent's model. This tool does not start an agent.",
      parameters: Type.Object({}, { additionalProperties: false }),
      outputSchema: Type.Object({ models: Type.Array(Type.String()) }),
      annotations: { readOnlyHint: true, openWorldHint: false },

      execute: async (_id, _params, signal, _onUpdate, ctx) => {
        signal?.throwIfAborted();
        const service = typeof provider === "function" ? await provider(ctx) : provider;
        const context = service.context;
        const models = [
          ...new Set(
            context.modelRegistry
              .getAvailable()
              .filter(
                (model) =>
                  !service.catalog.settings.scopeModels ||
                  !context.scopedModels.length ||
                  context.scopedModels.some(
                    (entry) =>
                      entry.model.provider === model.provider && entry.model.id === model.id,
                  ),
              )
              .map((model) => `${model.provider}/${model.id}`),
          ),
        ].toSorted();
        const data = { models };
        return {
          content: [
            {
              type: "text",
              text: models.length
                ? models.join("\n")
                : "No models are available for explicit subagent model overrides.",
            },
          ],
          structuredContent: data,
          details: data,
        };
      },
    }),
  ] as const;
}
