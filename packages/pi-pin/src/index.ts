import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

import { createOverlay, type PinAction } from "./overlay.ts";
import { getMessages, PIN_ENTRY, resolveMessage, type PinMessage } from "./state.ts";

function messages(ctx: ExtensionContext): PinMessage[] {
  return getMessages(ctx.sessionManager.getEntries());
}

function status(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const count = messages(ctx).filter((message) => message.pinned).length;
  ctx.ui.setStatus(
    "pi-pin",
    count ? `${count} ${count === 1 ? "pin" : "pins"} · /pins` : undefined,
  );
}

function isAssistantReply(entry: SessionEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.role === "assistant" &&
    entry.message.content.some((block) => block.type === "text" && block.text.trim().length > 0)
  );
}

function lastReply(ctx: ExtensionContext): PinMessage {
  const branch = ctx.sessionManager.getBranch();
  const entry = branch.findLast(isAssistantReply);
  const message = entry && messages(ctx).find((candidate) => candidate.id === entry.id);
  if (!message) throw new Error("No completed assistant reply to pin in this branch.");
  return message;
}

function recentMessage(ctx: ExtensionContext, position: number): PinMessage {
  if (!Number.isSafeInteger(position) || position < 1)
    throw new Error("Use a positive whole number: /pin 1 pins the latest conversation message.");

  const available = new Map(messages(ctx).map((message) => [message.id, message]));
  const conversation = ctx.sessionManager.getBranch().filter((entry) => {
    if (entry.type !== "message" || !available.has(entry.id)) return false;
    if (entry.message.role === "user") return true;
    return isAssistantReply(entry);
  });
  const entry = conversation.at(-position);
  if (!entry)
    throw new Error(
      `Only ${conversation.length} conversation messages are available in this branch. Run /pin to choose a message.`,
    );
  return available.get(entry.id)!;
}

function pinTarget(ctx: ExtensionContext, selector: string): PinMessage {
  if (selector === "last") return lastReply(ctx);
  if (/^-?\d+$/.test(selector)) return recentMessage(ctx, Number(selector));
  const id = selector.startsWith("id:") ? selector.slice(3) : selector;
  if (!id) throw new Error("Specify a message ID after id:. Run /pin to choose a message.");
  return resolveMessage(messages(ctx), id);
}

export default function pin(pi: ExtensionAPI) {
  function save(ctx: ExtensionContext, message: PinMessage, pinned: boolean, label?: string): void {
    if (message.pinned === pinned && (label === undefined || message.label === label)) {
      ctx.ui.notify(pinned ? `Already pinned: ${message.id}` : `Not pinned: ${message.id}`, "info");
      return;
    }
    pi.appendEntry(PIN_ENTRY, {
      targetId: message.id,
      pinned,
      label: pinned ? label || message.label : undefined,
    });
    status(ctx);
    ctx.ui.notify(`${pinned ? "Pinned" : "Unpinned"}: ${message.id}`, "info");
  }

  async function browse(
    ctx: ExtensionCommandContext,
    pinnedOnly: boolean,
    initialId?: string,
  ): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(
        "The pin popup requires interactive Pi. Use /pin <id> or /unpin <id>.",
        "warning",
      );
      return;
    }
    const available = messages(ctx).filter((message) => !pinnedOnly || message.pinned);
    if (!available.length) {
      ctx.ui.notify(
        pinnedOnly ? "No pins yet. Run /pin to choose a message." : "No messages to pin yet.",
        "info",
      );
      return;
    }
    const result = await ctx.ui.custom<PinAction | undefined>(
      (tui, theme, keybindings, done) =>
        createOverlay({
          tui,
          theme,
          keybindings,
          messages: available,
          pinnedOnly,
          initialId,
          done,
        }),
      { overlay: true, overlayOptions: { width: "85%", maxHeight: "80%", anchor: "center" } },
    );
    if (!result) return;
    const message = resolveMessage(messages(ctx), result.id);
    if (result.action === "pin" || result.action === "unpin") {
      save(ctx, message, result.action === "pin");
      return;
    }
    if (!ctx.isIdle()) {
      ctx.ui.notify("Wait for the agent to finish before navigating to a pin.", "warning");
      return;
    }
    if (
      !(await ctx.ui.confirm(
        "Go to message?",
        "This changes the active conversation position, not just the scroll position. Later messages remain in /tree. Continue?",
      ))
    )
      return;
    await ctx.waitForIdle();
    const navigation = await ctx.navigateTree(message.id, { summarize: false });
    if (!navigation.cancelled)
      ctx.ui.notify(`Navigated to ${message.id}. Use /tree to return.`, "info");
  }

  pi.registerCommand("pin", {
    description:
      "Pin a message: /pin opens picker; /pin <number>, /pin last, or /pin <id> [label] pins directly",
    handler: async (args, ctx) => {
      try {
        const input = args.trim();
        if (!input) {
          await browse(ctx, false);
          return;
        }
        const [id, ...words] = input.split(/\s+/);
        const message = pinTarget(ctx, id!);
        save(ctx, message, true, words.join(" ") || undefined);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("pins", {
    description: "Open saved messages in a popup; /pins <id> opens one directly",
    handler: async (args, ctx) => {
      try {
        const id = args.trim();
        const target = id
          ? resolveMessage(
              messages(ctx).filter((message) => message.pinned),
              id,
            )
          : undefined;
        await browse(ctx, true, target?.id);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("unpin", {
    description: "Remove a saved message: /unpin <id>",
    handler: async (args, ctx) => {
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Use /unpin <id>, or open /pins and press Ctrl+P on a message.", "info");
        return;
      }
      try {
        save(ctx, resolveMessage(messages(ctx), id), false);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerShortcut("alt+shift+p", {
    description: "Pin the latest completed assistant reply",
    handler: (ctx) => {
      try {
        save(ctx, lastReply(ctx), true);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => status(ctx));
  pi.on("session_tree", (_event, ctx) => status(ctx));
}
