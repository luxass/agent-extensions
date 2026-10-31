import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";

import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  defineTool,
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

import type { AgentDefinition } from "./agents.ts";
import type { Catalog } from "./catalog.ts";
import {
  matches,
  usageDelta,
  usageSnapshot,
  type SpawnRequest,
  type Thinking,
  type Usage,
} from "./tools.ts";

/** Child loader discovery must not recursively register another root orchestrator. */
export const childSessionContext = new AsyncLocalStorage<boolean>();

/** Schema patterns run off the UI thread and are terminated if validation stalls. */
async function validateStructured(
  schema: unknown,
  value: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const serialized = JSON.stringify({ schema, value });
  if (serialized.length > 2_000_000 || JSON.stringify(schema).length > 64_000)
    throw new Error("Structured output or schema exceeds its size limit.");
  signal?.throwIfAborted();
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { Value } = await import(workerData.module);
      const { schema, value } = JSON.parse(workerData.serialized);
      parentPort.postMessage(Value.Check(schema, value));
    })().catch(error => { throw error; });
  `,
    { eval: true, workerData: { module: import.meta.resolve("typebox/value"), serialized } },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  try {
    await new Promise<void>((done, reject) => {
      abort = () => {
        reject(new Error("Structured output validation cancelled."));
      };
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        reject(new Error("Structured output validation exceeded one second."));
      }, 1000);
      worker.once("message", (valid: unknown) => {
        if (valid === true) done();
        else reject(new Error("Structured output does not match the requested schema."));
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0) reject(new Error(`Validation worker exited (${code}).`));
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await worker.terminate();
  }
}

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
  run(): Promise<{ text: string; structured?: unknown }>;
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
    let operation: Promise<{ text: string; structured?: unknown }> | undefined;
    let turns = 0;
    let budgetReached = false;
    let text = "";
    let structured: unknown;
    let hasStructured = false;
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
      if (name === "SubagentWorkflow") return false;
      if (name === "StructuredOutput") return request.schema !== undefined;
      if (["Agent", "get_subagent_result", "steer_subagent"].includes(name))
        return (
          definition.allowedSubagents.length > 0 &&
          (!definition.tools || matches(name, definition.tools))
        );
      return !definition.tools || matches(name, definition.tools);
    };

    try {
      signal.throwIfAborted();
      const cwd = request.cwd ? resolve(request.cwd) : ctx.cwd;
      if (!(await wait(stat(cwd))).isDirectory()) throw new Error("Agent cwd is not a directory.");
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
          pi.events.emit("subagents:warning", {
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
      const [targetPath, parentPath] = await wait(Promise.all([realpath(cwd), realpath(ctx.cwd)]));
      const sameProject = targetPath === parentPath;
      const settingsManager = SettingsManager.inMemory(parentSettings.getSettings(), {
        projectTrusted: ctx.isProjectTrusted() && sameProject,
      });
      if (!sameProject)
        pi.events.emit("subagents:warning", {
          error:
            "Alternate cwd uses parent settings. Target project configuration is not trusted; automatic project-local MCP discovery is disabled there.",
        });
      const loader = new DefaultResourceLoader({
        cwd: ctx.cwd,
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
          extensions: base.extensions.filter(
            (extension) =>
              !extension.tools.has("Agent") && !extension.tools.has("SubagentWorkflow"),
          ),
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
      if (request.schema !== undefined)
        customTools.push(
          defineTool({
            name: "StructuredOutput",
            label: "Structured output",
            description: `Return the task result as value, matching this JSON schema: ${JSON.stringify(request.schema)}`,
            parameters: Type.Object({ value: Type.Unknown() }),

            execute: async (_id, params) => {
              signal.throwIfAborted();
              await validateStructured(request.schema, params.value, signal);
              signal.throwIfAborted();
              structured = params.value;
              hasStructured = true;
              return {
                content: [{ type: "text", text: "Structured result accepted." }],
                details: undefined,
              };
            },
          }),
        );
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
        excludeTools: [...definition.disallowedTools, "SubagentWorkflow"],
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
      const previous = created.agent.beforeToolCall;
      created.agent.beforeToolCall = async (context, toolSignal) => {
        if (!permitted(context.toolCall.name))
          return { block: true, reason: "This tool is not permitted for this agent." };
        return previous?.(context, toolSignal);
      };
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
                created.prompt(
                  `${request.prompt}${request.schema !== undefined ? "\nReturn the final result with StructuredOutput." : ""}${limit === 1 ? `\n${wrapUp}` : ""}`,
                  { expandPromptTemplates: false, source: "extension" },
                ),
              );
              signal.throwIfAborted();
              if (asynchronousError) throw asynchronousError;
              if (
                request.schema !== undefined &&
                !hasStructured &&
                !budgetReached &&
                !(limit > 0 && turns >= limit)
              ) {
                await wait(
                  created.sendCustomMessage(
                    {
                      customType: "subagents:structured-output",
                      content:
                        "Return your completed result now through StructuredOutput. Do not perform additional work.",
                      display: true,
                    },
                    { triggerTurn: true },
                  ),
                );
                signal.throwIfAborted();
              }
              const final = created.messages.at(-1);
              if (final?.role === "assistant" && final.stopReason === "error")
                throw new Error(final.errorMessage || "Child model request failed.");
              if (
                request.schema !== undefined &&
                !hasStructured &&
                !budgetReached &&
                !(limit > 0 && turns >= limit)
              )
                throw new Error("The agent did not return the requested structured output.");
              const answer =
                limit > 0 && turns >= limit && final?.role !== "assistant"
                  ? `${text}\n\nTurn limit reached before a final answer. Work may be unfinished; inspect the conversation for partial tool results.`
                  : text;
              return hasStructured ? { text: answer, structured } : { text: answer };
            } catch (error) {
              if (budgetReached && !signal.aborted) {
                const answer = `${text}\n\nTurn limit reached. Work may be unfinished; partial results are preserved in the conversation.`;
                return hasStructured ? { text: answer, structured } : { text: answer };
              }
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
