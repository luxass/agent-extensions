import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";

import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type BoundaryResult,
  type BoundaryState,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { matches, type AgentDefinition } from "./agents.ts";
import type { Catalog } from "./catalog.ts";
import { emit } from "./events.ts";
import type { SpawnRequest } from "./tools.ts";
import type { Thinking, Usage } from "./types.ts";

function usageSnapshot(session: AgentSession): Usage {
  const stats = session.getSessionStats();
  return { ...stats.tokens, cost: stats.cost };
}

function usageDelta(now: Usage, baseline: Usage): Usage {
  return {
    input: Math.max(0, now.input - baseline.input),
    output: Math.max(0, now.output - baseline.output),
    cacheRead: Math.max(0, now.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, now.cacheWrite - baseline.cacheWrite),
    cost: Math.max(0, now.cost - baseline.cost),
  };
}

/** Child loader discovery must not recursively register another root orchestrator. */
export const childSessionContext = new AsyncLocalStorage<boolean>();

const instructionSchema = Type.Object({
  version: Type.Literal(1),
  projectTrusted: Type.Boolean(),
  role: Type.String(),
  systemPrompt: Type.Optional(Type.String()),
  agentsFiles: Type.Array(Type.Object({ path: Type.String(), content: Type.String() })),
  append: Type.Array(Type.String()),
});

export interface SessionDriver {
  readonly session: AgentSession;
  readonly instructions: string;
  readonly sessionFile: string | undefined;
  readonly model: string | undefined;
  readonly thinking: Thinking | undefined;
  run(): Promise<string>;
  steer(text: string): Promise<void>;
  dispose(): Promise<void>;
}

interface RunnerInput {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  catalog: Catalog;
  request: SpawnRequest;
  definition: Readonly<AgentDefinition>;
  signal: AbortSignal;
  sessionDirectory: string;
  sessionFile?: string;
  instructions?: string;
  parentSession?: AgentSession;
  customTools: ToolDefinition[];
}

interface RunnerHooks {
  created(driver: SessionDriver): void;
  event(event: AgentSessionEvent): void;
  usage(usage: Usage): void;
  boundary?(state: BoundaryState, ctx: ExtensionContext): BoundaryResult | undefined;
}

export async function openSession(input: RunnerInput, hooks: RunnerHooks): Promise<SessionDriver> {
  return childSessionContext.run(true, async () => {
    const { pi, ctx, catalog, request, definition, parentSession } = input;
    const controller = new AbortController();
    const { signal } = controller;
    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let baseline: Usage | undefined;
    let disposed = false;
    let stopping: Promise<void> | undefined;
    let creating: Promise<AgentSession> | undefined;
    let binding: Promise<void> | undefined;
    let disposing: Promise<void> | undefined;
    let operation: Promise<string> | undefined;
    let turns = 0;
    let budgetReached = false;
    let text = "";
    let asynchronousError: unknown;
    const limit = request.max_turns ?? definition.maxTurns ?? catalog.settings.maxTurns;
    const wrapUp =
      "Your next turn is the final allowed turn. Finish with an honest summary of completed work, evidence, and anything unfinished.";

    const reportUsage = (): void => {
      if (session && baseline) hooks.usage(usageDelta(usageSnapshot(session), baseline));
    };

    const abortSession = (): Promise<void> => {
      stopping ??= session ? session.abort() : Promise.resolve();
      return stopping;
    };

    const onAbort = (): void => {
      controller.abort(input.signal.reason);
      if (session)
        void abortSession().catch((error: unknown) => {
          asynchronousError = error;
        });
    };

    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) onAbort();

    const dispose = (): Promise<void> => {
      if (disposing) return disposing;
      disposed = true;
      controller.abort(new Error("Child session disposed."));
      input.signal.removeEventListener("abort", onAbort);
      unsubscribe?.();
      disposing = childSessionContext.run(true, async () => {
        // Creation can finish after cancellation. This cleanup still owns its result.
        const created = session ?? (await creating?.catch(() => undefined));
        if (!created) return;
        try {
          const stopped = created.abort();
          // Observe abort failures while non-cancellable extension startup drains.
          void stopped.catch(() => {});
          // Finish startup before shutdown, so no later startup hook can reopen resources.
          // The manager bounds its wait and blocks resume if cleanup cannot be confirmed.
          await binding?.catch(() => {});
          let shutdownError: Error | undefined;
          const offError = created.extensionRunner.onError((error) => {
            if (error.event === "session_shutdown")
              shutdownError ??= new Error(`Extension shutdown failed: ${error.error}`);
          });
          try {
            await created.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
            if (shutdownError) throw shutdownError;
          } finally {
            offError();
            await stopped;
          }
        } finally {
          try {
            reportUsage();
          } finally {
            created.dispose();
          }
        }
      });
      return disposing;
    };

    // Observe losing promises too: SDK creation and extension startup are not cancellable.
    const wait = async <T>(promise: Promise<T>): Promise<T> => {
      let abort!: () => void;
      const cancellation = new Promise<never>((_done, reject) => {
        abort = () => reject(signal.reason ?? new Error("Child session cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      try {
        return await Promise.race([promise, cancellation]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    };

    const permitted = (name: string): boolean => {
      if (signal.aborted || disposed || budgetReached) return false;
      if (matches(name, definition.disallowedTools)) return false;
      if (["Agent", "get_subagent_result", "steer_subagent", "list_subagent_models"].includes(name))
        return (
          definition.allowedSubagents.length > 0 &&
          (!definition.tools || matches(name, definition.tools))
        );
      return !definition.tools || matches(name, definition.tools);
    };

    try {
      signal.throwIfAborted();
      const cwd = ctx.cwd;
      const modelRuntime = await wait(ModelRuntime.create());
      for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
        const native = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
        if (native) modelRuntime.registerNativeProvider(native);
        const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
        if (config) modelRuntime.registerProvider(providerId, config);
      }
      const modelName = request.model ?? definition.model;
      const available = ctx.modelRegistry.getAvailable();
      const exact = modelName
        ? available.filter(
            (model) => `${model.provider}/${model.id}`.toLowerCase() === modelName.toLowerCase(),
          )
        : [];
      const candidates = exact.length
        ? exact
        : modelName
          ? available.filter((model) =>
              `${model.provider}/${model.id}`.toLowerCase().includes(modelName.toLowerCase()),
            )
          : [];
      if (modelName && candidates.length !== 1)
        throw new Error(`Model '${modelName}' is unavailable or ambiguous. Use provider/modelId.`);
      const model = modelName ? candidates[0] : (parentSession?.model ?? ctx.model);
      if (
        catalog.settings.scopeModels &&
        model &&
        ctx.scopedModels.length &&
        !ctx.scopedModels.some(
          (entry) => entry.model.provider === model.provider && entry.model.id === model.id,
        )
      ) {
        if (request.model)
          throw new Error("Requested model is outside the parent's enabled model scope.");
        if (definition.model)
          emit(pi, "subagents:warning", {
            error:
              "The agent definition pins a model outside the parent's enabled scope. Its explicit definition is authoritative.",
          });
      }
      const isolated = definition.isolated === true || request.isolated === true;
      const noExtensions =
        isolated ||
        !ctx.isProjectTrusted() ||
        process.argv.includes("--no-extensions") ||
        process.argv.includes("-ne");
      const noMcp = process.argv.includes("--no-mcp");

      const scope: ExtensionFactory = (extension) => {
        extension.on("turn_end", (state, ctx) => hooks.boundary?.(state, ctx));
        extension.on("agent_before_settle", (state, ctx) => hooks.boundary?.(state, ctx));
        // The tool_call hook also sees nested calls (codemode), unlike agent.beforeToolCall.
        extension.on("tool_call", (event) =>
          permitted(event.toolName)
            ? undefined
            : { block: true, reason: "This tool is not permitted for this agent." },
        );
      };

      const stored: unknown =
        input.instructions === undefined ? undefined : JSON.parse(input.instructions);
      if (stored !== undefined && !Value.Check(instructionSchema, stored))
        throw new Error(
          "The saved instruction snapshot is unsupported. Start a fresh session explicitly.",
        );
      const saved = Value.Check(instructionSchema, stored) ? stored : undefined;
      if (saved?.projectTrusted && !ctx.isProjectTrusted())
        throw new Error(
          "Project trust was revoked. Resume cannot reuse saved project instructions; restart explicitly in the current context.",
        );
      const instructions =
        saved?.role ?? (await wait(catalog.prompt({ ...definition, memory: undefined })));
      // Memory is mutable reference data; saved instructions never contain it.
      const memory = definition.memory
        ? await wait(catalog.prompt({ ...definition, prompt: "", skills: [] }))
        : "";
      const parentSettings = SettingsManager.create(ctx.cwd, getAgentDir(), {
        projectTrusted: ctx.isProjectTrusted(),
      });
      const settingsManager = SettingsManager.inMemory(parentSettings.getSettings(), {
        projectTrusted: ctx.isProjectTrusted(),
      });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir(),
        settingsManager: parentSettings,
        noExtensions,
        disabledBuiltinExtensions: noExtensions
          ? ["codemode", "tool-search", "mcp"]
          : noMcp
            ? ["mcp"]
            : [],
        extensionFactories: noExtensions
          ? [scope]
          : [
              scope,
              createCodemodeExtension({ mode: "on" }),
              createToolSearchExtension(),
              ...(noMcp ? [] : [createMcpExtension()]),
            ],
        systemPrompt: definition.promptMode === "replace" ? instructions : undefined,
        agentsFilesOverride: saved ? () => ({ agentsFiles: saved.agentsFiles }) : undefined,
        systemPromptOverride: saved ? () => saved.systemPrompt : undefined,

        appendSystemPromptOverride: (base) => [
          ...(saved?.append ?? base),
          `Turn budget: ${limit} (0 means unlimited). Reserve your final turn for a concise, honest result.`,
          ...(memory ? [memory] : []),
        ],

        appendSystemPrompt: [
          ...(definition.promptMode === "replace" ? [] : [instructions]),
          "You are a child session. Work only on your assigned task. Your checkout is shared; do not assume file isolation.",
        ],

        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter((extension) => !extension.tools.has("Agent")),
        }),
      });
      await wait(loader.reload());
      const instructionSnapshot = JSON.stringify({
        version: 1,
        projectTrusted: ctx.isProjectTrusted(),
        role: instructions,
        systemPrompt: loader.getSystemPrompt(),
        agentsFiles: loader.getAgentsFiles().agentsFiles,
        append: loader.getAppendSystemPrompt().slice(0, memory ? -2 : -1),
      });
      await wait(mkdir(input.sessionDirectory, { recursive: true, mode: 0o700 }));
      signal.throwIfAborted();
      let sessionManager = input.sessionFile
        ? SessionManager.open(input.sessionFile, input.sessionDirectory, cwd)
        : SessionManager.create(cwd, input.sessionDirectory);
      if (!input.sessionFile && request.inherit_context) {
        const path = sessionManager.getSessionFile();
        if (!path) throw new Error("Cannot create the inherited child transcript.");
        const entries = [
          sessionManager.getHeader(),
          ...(parentSession?.sessionManager ?? ctx.sessionManager).getBranch(),
        ];
        await wait(
          writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
            flag: "wx",
            mode: 0o600,
          }),
        );
        sessionManager = SessionManager.open(path, input.sessionDirectory, cwd);
      }
      const customTools = input.customTools.filter((tool) => permitted(tool.name));
      signal.throwIfAborted();
      creating = createAgentSession({
        cwd,
        modelRuntime,
        model,
        thinkingLevel:
          request.thinking ??
          definition.thinking ??
          parentSession?.thinkingLevel ??
          ctx.thinkingLevel,
        resourceLoader: loader,
        settingsManager,
        sessionManager,
        excludeTools: [...definition.disallowedTools],
        tools: definition.tools
          ? [...definition.tools, ...customTools.map((tool) => tool.name)]
          : undefined,
        customTools,
      }).then((result) => {
        session = result.session;
        return result.session;
      });
      const created = await wait(creating);
      signal.throwIfAborted();
      baseline = usageSnapshot(created);
      unsubscribe = created.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
          text += event.assistantMessageEvent.delta;
        if (event.type === "message_end" && event.message.role === "assistant") {
          const answer = event.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          if (answer) text = answer;
        }
        if (event.type === "turn_start") {
          turns += 1;
          if (limit > 0 && turns > limit) {
            budgetReached = true;
            void abortSession().catch((error: unknown) => {
              asynchronousError = error;
            });
          }
        }
        if (event.type === "turn_end" && limit > 1 && turns === limit - 1)
          void created
            .sendCustomMessage(
              { customType: "subagents:turn-budget", content: wrapUp, display: true },
              { deliverAs: "steer" },
            )
            .catch((error: unknown) => {
              asynchronousError = error;
            });
        if (event.type === "message_end" || event.type === "compaction_end") reportUsage();
        hooks.event(event);
      });
      const driver: SessionDriver = {
        session: created,
        instructions: instructionSnapshot,

        get sessionFile() {
          return created.sessionFile;
        },

        get model() {
          return created.model ? `${created.model.provider}/${created.model.id}` : undefined;
        },

        get thinking() {
          return created.thinkingLevel;
        },

        run() {
          operation ??= childSessionContext.run(true, async () => {
            try {
              signal.throwIfAborted();
              await wait(
                created.prompt(`${request.prompt}${limit === 1 ? `\n${wrapUp}` : ""}`, {
                  expandPromptTemplates: false,
                  source: "extension",
                }),
              );
              signal.throwIfAborted();
              if (asynchronousError) throw asynchronousError;
              const final = created.messages.at(-1);
              if (final?.role === "assistant" && final.stopReason === "error")
                throw new Error(final.errorMessage || "Child model request failed.");
              return limit > 0 && turns >= limit && final?.role !== "assistant"
                ? `${text}\n\nTurn limit reached before a final answer. Work may be unfinished; inspect the conversation for partial tool results.`
                : text;
            } catch (error) {
              if (budgetReached && !signal.aborted)
                return `${text}\n\nTurn limit reached. Work may be unfinished; partial results are preserved in the conversation.`;
              throw error;
            } finally {
              reportUsage();
            }
          });
          return operation;
        },

        async steer(message) {
          signal.throwIfAborted();
          await wait(created.steer(message, undefined, { source: "extension" }));
        },

        dispose,
      };
      // The owner must be able to stop this driver while session_start hooks are still running.
      hooks.created(driver);
      signal.throwIfAborted();
      binding = created.bindExtensions({});
      await wait(binding);
      signal.throwIfAborted();
      return driver;
    } catch (error) {
      try {
        reportUsage();
      } finally {
        await dispose();
      }
      throw error;
    }
  });
}
