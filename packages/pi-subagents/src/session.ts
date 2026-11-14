import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { Message } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  stripFrontmatter,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_SUBAGENT_TOOLS,
  isSubagentControlTool,
  type SubagentDefinition,
} from "./agents.ts";
import type { SubagentThinking } from "./api.ts";
import type { SubagentSettings } from "./settings.ts";

type SubagentModel = NonNullable<ExtensionContext["model"]>;

const BUILTIN_TOOLS = new Set([
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);
const PACKAGE_DIRECTORY = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WRAP_UP_INSTRUCTION =
  "You have one turn left. Wrap up now: report your findings, what you changed, and any unfinished work. Do not start new work.";

/** Optional `Agent` call parameters. Values in the agent file win over these (S3). */
export interface SubagentOverrides {
  model?: string;
  thinking?: SubagentThinking;
  max_turns?: number;
  inherit_context?: boolean;
}

/** Launch policy resolved and validated before a task name is reserved (S1, S3, S4). */
export interface SubagentPolicy {
  definition: SubagentDefinition;
  model: SubagentModel;
  thinking: SubagentThinking;
  maxTurns: number;
  tools: string[];
  extensionPaths: string[];
  codemode: boolean;
  mcp: boolean;
  inherited: Message[];
}

/** Builds the model runtime shared by all agents of one main session, copying its providers. */
export async function createSubagentRuntime(ctx: ExtensionContext): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create();
  for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
    const provider = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
    if (provider) runtime.registerNativeProvider(provider);
    const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
    if (config) runtime.registerProvider(providerId, config);
  }
  return runtime;
}

/** Copies the conversation the main model currently sees, for `inherit_context` (S7). */
export function inheritedSubagentContext(ctx: ExtensionContext): Message[] {
  // Pi's own conversion before a model request. Summaries, extension messages such as earlier agent
  // results, and `!` command output become user messages, exactly as the main model sees them.
  const messages = convertToLlm(
    structuredClone(ctx.sessionManager.buildSessionProjection().messages),
  );
  const answeredCalls = new Set(
    messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
  );
  const keptCalls = new Set<string>();
  const inherited: Message[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      // A tool call without a result would leave the transcript invalid for the provider.
      const content = message.content.filter((part) => {
        if (part.type !== "toolCall") return true;
        if (!answeredCalls.has(part.id)) return false;
        keptCalls.add(part.id);
        return true;
      });
      if (content.length) inherited.push({ ...message, content });
    } else if (message.role !== "toolResult" || keptCalls.has(message.toolCallId)) {
      inherited.push(message);
    }
  }
  return inherited;
}

/** Finds the one available model a `model` value names, by exact id or a unique fragment (S3). */
function resolveSubagentModel(ctx: ExtensionContext, requested: string | undefined): SubagentModel {
  if (!requested) {
    if (!ctx.model)
      throw new Error("No model selected: choose a model in Pi before starting an agent.");
    return ctx.model;
  }
  const available = ctx.modelRegistry.getAvailable();
  const exact = available.find((model) => `${model.provider}/${model.id}` === requested);
  if (exact) return exact;
  const fragment = requested.toLowerCase();
  const matches = available.filter((model) =>
    `${model.provider}/${model.id}`.toLowerCase().includes(fragment),
  );
  const [only] = matches;
  if (matches.length === 1 && only) return only;
  const names = matches
    .slice(0, 5)
    .map((model) => `${model.provider}/${model.id}`)
    .join(", ");
  throw new Error(
    matches.length === 0
      ? `No available model matches "${requested}".`
      : `Model "${requested}" matches ${matches.length} models (${names}). Use provider/id.`,
  );
}

/** Resolves model, thinking, turn limit, and tool access for one start or continuation. */
export function resolveSubagentPolicy(options: {
  definition: SubagentDefinition;
  overrides: SubagentOverrides;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  settings: SubagentSettings;
}): SubagentPolicy {
  const { definition, overrides, ctx, pi, settings } = options;
  const tools = [...new Set(definition.tools ?? DEFAULT_SUBAGENT_TOOLS)];
  const extensionPaths = new Set<string>();
  let codemode = false;
  let mcp = false;
  const mainTools = pi.getAllTools();
  for (const name of tools) {
    if (isSubagentControlTool(name))
      throw new Error(`Agents cannot use ${name}: only the main session coordinates agents.`);
    if (BUILTIN_TOOLS.has(name)) continue;
    if (name.startsWith("mcp__")) {
      mcp = true;
      codemode = true;
      continue;
    }
    const path = mainTools.find((tool) => tool.name === name)?.sourceInfo.path;
    if (!path)
      throw new Error(
        `Tool ${name} is not available in the main session, so no extension provides it.`,
      );
    if (path === "builtin:codemode") {
      codemode = true;
    } else if (path === "builtin:mcp") {
      mcp = true;
      codemode = true;
    } else if (path.startsWith("builtin:")) {
      throw new Error(`Tool ${name} comes from Pi's ${path} extension, which agents cannot load.`);
    } else {
      const absolute = resolve(path);
      if (absolute === PACKAGE_DIRECTORY || absolute.startsWith(PACKAGE_DIRECTORY + sep)) {
        throw new Error(`Tool ${name} belongs to pi-subagents, which never loads inside an agent.`);
      }
      extensionPaths.add(path);
    }
  }
  if (codemode && !tools.includes("codemode")) tools.push("codemode");
  // Checked here so a missing skill rejects the call before its task name is used (S1). Pi lists
  // each of the main session's skills as the command `skill:<name>`.
  const mainSkills = new Set(
    pi.getCommands().flatMap((command) => (command.source === "skill" ? [command.name] : [])),
  );
  const missingSkill = (definition.skills ?? []).find((name) => !mainSkills.has(`skill:${name}`));
  if (missingSkill) {
    throw new Error(`Skill ${missingSkill} listed by agent type ${definition.name} was not found.`);
  }
  return {
    definition,
    model: resolveSubagentModel(ctx, definition.model ?? overrides.model),
    thinking: definition.thinking ?? overrides.thinking ?? ctx.thinkingLevel ?? "off",
    maxTurns: definition.max_turns ?? overrides.max_turns ?? settings.maxTurns,
    tools,
    extensionPaths: [...extensionPaths],
    codemode,
    mcp,
    inherited: overrides.inherit_context ? inheritedSubagentContext(ctx) : [],
  };
}

/** One live child session. Each `run` is one start or continuation with its own turn budget. */
export interface SubagentSession {
  readonly session: AgentSession;
  /** True when the turn limit stopped work that was still going. */
  partial: boolean;
  run(prompt: string): Promise<void>;
  dispose(): Promise<void>;
}

/** Creates or reopens an agent's session without loading unrelated extensions (S3, S4, S6, S7). */
export async function createSubagentSession(options: {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  runtime: ModelRuntime;
  policy: SubagentPolicy;
  sessionId: string;
  sessionDirectory: string;
  sessionFile?: string;
  onEvent: (event: AgentSessionEvent) => void;
}): Promise<SubagentSession> {
  const { ctx, pi, runtime, policy } = options;
  const projectTrusted = ctx.isProjectTrusted();
  // The session's settings stay in memory. A session saves its model and thinking level to its
  // settings, and an agent must never change the user's settings files.
  const settingsManager = SettingsManager.inMemory(pi.getSettings(), { projectTrusted });
  // The loader reads the settings files, so it knows which paths are global and which belong to
  // the project. It resolves each from its own folder, and it only reads while loading.
  const resourceSettings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted });
  const resourceLoader: DefaultResourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    settingsManager: resourceSettings,
    noExtensions: true,
    additionalExtensionPaths: policy.extensionPaths,
    extensionFactories: [
      ...(policy.codemode ? [createCodemodeExtension({ mode: "on" })] : []),
      ...(policy.mcp ? [createMcpExtension()] : []),
    ],
    // Runs after skills load, so the agent's listed skills can be added in full.
    appendSystemPromptOverride: (base) => {
      const skills = resourceLoader.getSkills().skills;
      const skillTexts = (policy.definition.skills ?? []).map((name) => {
        const skill = skills.find((candidate) => candidate.name === name);
        if (!skill)
          throw new Error(
            `Skill ${name} listed by agent type ${policy.definition.name} was not found.`,
          );
        return stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
      });
      return [...base, policy.definition.body, ...skillTexts].filter(Boolean);
    },
  });
  await resourceLoader.reload();
  // reload() collects load errors and does not throw. Without its extension the agent would run
  // without a tool it was given, and still report success (S4).
  const [loadError] = resourceLoader.getExtensions().errors;
  if (loadError) {
    throw new Error(`Extension ${loadError.path} failed to load for the agent: ${loadError.error}`);
  }

  let sessionManager: SessionManager;
  if (options.sessionFile) {
    await access(options.sessionFile);
    sessionManager = SessionManager.open(options.sessionFile);
  } else {
    sessionManager = SessionManager.create(ctx.cwd, options.sessionDirectory, {
      id: options.sessionId,
      parentSession: ctx.sessionManager.getSessionFile(),
    });
    for (const message of policy.inherited) sessionManager.appendMessage(message);
  }

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    modelRuntime: runtime,
    model: policy.model,
    thinkingLevel: policy.thinking,
    tools: policy.tools,
    settingsManager,
    resourceLoader,
    sessionManager,
  });
  // A reopened session restores its saved model. The current definition and call decide instead.
  if (options.sessionFile) {
    await session.setModel(policy.model);
    session.setThinkingLevel(policy.thinking);
  }

  let turns = 0;
  let disposed = false;
  const child: SubagentSession = {
    session,
    partial: false,
    async run(prompt) {
      turns = 0;
      child.partial = false;
      const text = policy.maxTurns === 1 ? `${prompt}\n\n${WRAP_UP_INSTRUCTION}` : prompt;
      await session.prompt(text, { expandPromptTemplates: false });
      await session.waitForIdle();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await session.abort();
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session.dispose();
      }
    },
  };

  session.subscribe((event) => {
    if (event.type === "turn_start" && policy.maxTurns > 0 && turns >= policy.maxTurns) {
      // Another turn means work remains after the last allowed turn.
      child.partial = true;
      session.agent.abort();
    }
    if (event.type === "turn_end") {
      turns++;
      // A turn without tool calls is the agent's final answer. A wrap-up message there would force
      // one more turn, and that reply would replace the answer (S6: stop only if work remains).
      const workRemains = event.toolResults.length > 0;
      if (policy.maxTurns > 1 && turns === policy.maxTurns - 1 && workRemains) {
        session.agent.steer({ role: "user", content: WRAP_UP_INSTRUCTION, timestamp: Date.now() });
      }
    }
    options.onEvent(event);
  });

  try {
    // Print mode has no UI, so interactive tools fail inside an agent (S4).
    await session.bindExtensions({ mode: "print" });
  } catch (error) {
    await child.dispose();
    throw error;
  }
  return child;
}
