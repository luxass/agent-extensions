import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { createOverlay } from "./overlay";
import { answerText, createSideSession, summarize, type BtwState, type Exchange } from "./session";
import { getBtwTools, type BtwToolName } from "./settings.ts";

const EXCHANGE_ENTRY = "btw-exchange";
const RESET_ENTRY = "btw-reset";

const CONTINUE = "Continue side thread";
const FRESH = "Start fresh";
const KEEP = "Keep side thread";
const INJECT = "Inject summary into main chat";

type ToolDetailArgs = {
  pattern?: string;
  path?: string;
  command?: string;
};

function toolDetail({ args }: { args: ToolDetailArgs }): string {
  return args.pattern ?? args.path ?? args.command ?? "";
}

export default function btw(pi: ExtensionAPI) {
  const state: BtwState = { thread: [], busy: false };

  function restore(ctx: ExtensionContext): void {
    state.thread = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === RESET_ENTRY) state.thread = [];
      if (entry.customType === EXCHANGE_ENTRY) state.thread.push(entry.data as Exchange);
    }
  }

  function reset(): void {
    if (state.thread.length === 0) return;
    state.thread = [];
    pi.appendEntry(RESET_ENTRY);
  }

  function track(event: AgentSessionEvent): void {
    const { pending } = state;
    if (pending == null) return;
    if (event.type === "message_update" && event.message.role === "assistant") {
      pending.text = answerText(event.message);
    } else if (event.type === "tool_execution_start") {
      pending.tools.push({
        id: event.toolCallId,
        name: event.toolName,
        detail: toolDetail(event),
        status: "running",
      });
    } else if (event.type === "tool_execution_end") {
      const row = pending.tools.find(({ id }) => id === event.toolCallId);
      if (row) row.status = event.isError ? "error" : "done";
    }
  }

  async function open(
    ctx: ExtensionCommandContext,
    initial: string,
    tools: readonly BtwToolName[],
  ): Promise<void> {
    // Lives only while the overlay is open, so each opening sees the latest main conversation.
    let side: AgentSession | undefined;

    await ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        async function ask(question: string): Promise<void> {
          const pending: NonNullable<BtwState["pending"]> = { question, text: "", tools: [] };
          state.pending = pending;
          state.busy = true;
          tui.requestRender();
          try {
            if (side == null) {
              side = await createSideSession({
                ctx,
                thinkingLevel: pi.getThinkingLevel(),
                thread: state.thread,
                tools,
              });
              side.subscribe((event) => {
                track(event);
                tui.requestRender();
              });
            }
            await side.prompt(question);
            const answer = side.messages.at(-1);
            if (answer?.role !== "assistant") throw new Error("No answer");
            if (answer.stopReason === "aborted") throw new Error("Stopped");
            if (answer.stopReason === "error")
              throw new Error(answer.errorMessage ?? "Request failed");

            const exchange: Exchange = { question, answer };
            state.thread.push(exchange);
            pi.appendEntry(EXCHANGE_ENTRY, exchange);
            state.pending = undefined;
          } catch (error) {
            pending.error = error instanceof Error ? error.message : String(error);
          } finally {
            state.busy = false;
            tui.requestRender();
          }
        }

        if (initial) void ask(initial);
        return createOverlay({
          tui,
          theme,
          keybindings,
          title: ctx.model?.id ?? "no model",
          state,
          onAsk: (question) => void ask(question),
          onEscape: () => {
            if (state.busy) void side?.abort();
            else done();
          },
        });
      },
      {
        overlay: true,
        overlayOptions: { width: "80%", minWidth: 60, maxHeight: "80%", anchor: "center" },
      },
    );

    side?.dispose();
    state.pending = undefined;

    if (state.thread.length === 0) return;
    if ((await ctx.ui.select("Close btw", [KEEP, INJECT])) !== INJECT) return;
    if (ctx.model == null) throw new Error("No model selected");
    ctx.ui.notify("Summarizing side thread…");
    const summary = await summarize(ctx, ctx.model, state.thread);
    pi.sendUserMessage(`Summary of a side conversation:\n\n${summary}`, { deliverAs: "followUp" });
    reset();
  }

  pi.registerCommand("btw", {
    description: "ask a side question without derailing the main conversation",
    handler: async (args, ctx) => {
      const tools = getBtwTools(pi.getSettings());
      const question = args.trim();
      if (!question && state.thread.length > 0) {
        const choice = await ctx.ui.select("btw", [CONTINUE, FRESH]);
        if (choice == null) return;
        if (choice === FRESH) reset();
      }
      await open(ctx, question, tools);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restore(ctx);
  });
}
