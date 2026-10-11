import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { DEFAULT_BTW_TOOLS, type BtwToolName } from "./settings.ts";

const SIDE_PROMPT =
  "The user is asking a side question (a 'btw') about the conversation above. The main agent keeps its own thread; handle the side question here. Answer directly and briefly.";

const SUMMARY_PROMPT =
  "Summarize this side conversation for the main agent. Keep decisions, findings, open questions, and next steps. Output only the summary.";

export interface Exchange {
  question: string;
  answer: AssistantMessage;
}

export interface ToolRow {
  id: string;
  name: string;
  detail: string;
  status: "running" | "done" | "error";
}

export interface BtwState {
  thread: Exchange[];
  pending?: { question: string; text: string; tools: ToolRow[]; error?: string };
  busy: boolean;
}

export function answerText(message: AssistantMessage): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

interface SideSessionOptions {
  ctx: ExtensionContext;
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  thread: readonly Exchange[];
  tools: readonly BtwToolName[];
}

export async function createSideSession({
  ctx,
  thinkingLevel,
  thread,
  tools,
}: SideSessionOptions): Promise<AgentSession> {
  const toolAccess =
    tools.length === 0
      ? "No tools are enabled in this side session."
      : `Your enabled tools are: ${tools.join(", ")}. ${
          tools.every((tool) => DEFAULT_BTW_TOOLS.includes(tool))
            ? "Your tools are read-only."
            : "Use tools only for actions requested in this side conversation."
        }`;
  const resourceLoader = new DefaultResourceLoader({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    appendSystemPrompt: [
      `${SIDE_PROMPT} ${toolAccess} Do not assume tools from the main conversation are available here.`,
    ],
  });
  await resourceLoader.reload();

  // Seeding with the main branch keeps its system prompt in front, so the request shares the
  // main chat's prefix and Pi only appends a patch for SIDE_PROMPT and the configured tools.
  const sessionManager = SessionManager.inMemory(
    ctx.cwd,
    undefined,
    ctx.sessionManager.getBranch(),
  );
  for (const { question, answer } of thread) {
    sessionManager.appendMessage({ role: "user", content: question, timestamp: answer.timestamp });
    sessionManager.appendMessage(answer);
  }

  // A fresh SDK runtime only knows built-ins and models.json. Copy provider registrations
  // without reloading their extensions, which would also enable unrelated tools and hooks.
  const modelRuntime = await ModelRuntime.create();
  for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
    const provider = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
    if (provider) modelRuntime.registerNativeProvider(provider);
    const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
    if (config) modelRuntime.registerProvider(providerId, config);
  }

  const { session } = await createAgentSession({
    cwd: ctx.cwd,
    modelRuntime,
    model: ctx.model,
    thinkingLevel,
    tools: [...tools],
    resourceLoader,
    sessionManager,
  });
  return session;
}

export async function summarize(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
  thread: Exchange[],
): Promise<string> {
  const transcript = thread
    .map(({ question, answer }) => `User: ${question}\n\nAssistant: ${answerText(answer)}`)
    .join("\n\n---\n\n");
  const response = await ctx.modelRegistry.complete(model, {
    systemPrompt: SUMMARY_PROMPT,
    messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? "Summary failed");
  }
  return answerText(response);
}
