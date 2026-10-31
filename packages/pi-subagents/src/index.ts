import {
  VERSION,
  type BoundaryResult,
  type BoundaryState,
  type CustomMessageEntryDraft,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { restoreAttempts } from "./attempts.ts";
import { createCatalog } from "./catalog.ts";
import { record } from "./io.ts";
import { AgentManager, type Owner } from "./manager.ts";
import { type AgentCard, agentRenderers, completionCards, plain } from "./render.ts";
import { childSessionContext } from "./sessions.ts";
import { coreAgentParameters, createAgentTools, inlineView, receivedAttempts } from "./tools.ts";
import { isSettled, type AgentView } from "./transcript.ts";
import { attachUi } from "./ui.ts";

function completion(views: AgentView[]): CustomMessageEntryDraft {
  const budget = Math.max(120, Math.floor(24000 / views.length) - 300);
  return {
    type: "custom_message",
    customType: "subagent-completion",
    display: true,
    details: { agents: views.map(inlineView) },
    content: views
      .map(
        (view) =>
          `${view.displayName} · ${view.task} · ${view.state}\nAgent: ${view.id}\nAttempt: ${view.attemptId}\nRecord: ${view.outputFile}\n${(view.error ? `${view.error}\n` : "") + (view.result || view.activity).slice(0, budget)}`,
      )
      .join("\n\n"),
  };
}

export default function subagents(pi: ExtensionAPI): void {
  if (childSessionContext.getStore()) return;
  let manager: AgentManager | undefined;
  let startup: Promise<AgentManager> | undefined;
  let disposeUi: (() => void) | undefined;
  let closing = false;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let groupDeadline: number | undefined;
  const outbox = new Map<string, AgentView>();
  const inFlight = new Set<string>();
  const cards = new Set<AgentCard>();

  const warn = (error: unknown): void => {
    try {
      if (!closing && manager?.context.hasUI) {
        manager.context.ui.notify(String(error), "warning");
        return;
      }
    } catch {
      /* The outgoing UI context can already be invalidated. */
    }
    console.error(`[pi-subagents] ${String(error)}`);
  };

  const offWarnings = pi.events.on("subagents:warning", (payload: unknown) => {
    if (record(payload) && typeof payload.error === "string") warn(payload.error);
  });

  function ready(owner: Owner, ctx: ExtensionContext, retry = false): AgentView[] {
    const service = manager;
    if (closing || !service) return [];
    const received = receivedAttempts(ctx);
    const views: AgentView[] = [];
    for (const [id, view] of outbox) {
      if (view.owner.id !== owner.id || view.owner.attemptId !== owner.attemptId) continue;
      if (received.has(id)) service.delivered(id);
      if (service.isConsumed(id)) {
        outbox.delete(id);
        inFlight.delete(id);
        continue;
      }
      if (retry) inFlight.delete(id);
      if (
        !inFlight.has(id) &&
        (owner.attemptId ||
          service.deliveryMode(id) !== "group" ||
          !service.joinedPending() ||
          Date.now() >= (groupDeadline ?? 0))
      )
        views.push(view);
    }
    if (
      ![...outbox.values()].some(
        (view) => !view.owner.attemptId && service.deliveryMode(view.attemptId) === "group",
      )
    )
      groupDeadline = undefined;
    return views;
  }

  function boundary(
    owner: Owner,
    state: BoundaryState,
    ctx: ExtensionContext,
  ): BoundaryResult | undefined {
    if (state.outcome !== "completed" || ctx.signal?.aborted) return undefined;
    const views = ready(owner, ctx, true);
    if (!views.length) return undefined;
    for (const view of views) inFlight.add(view.attemptId);
    return { entries: [...state.entries, completion(views)], continue: true };
  }

  function flushIdle(): void {
    const service = manager;
    if (closing || !service || !service.context.isIdle()) return;
    const views = ready(service.root, service.context);
    if (!views.length) return;
    const message = completion(views);
    for (const view of views) inFlight.add(view.attemptId);
    try {
      childSessionContext.exit(() => pi.sendMessage(message, { triggerTurn: true }));
    } catch (error) {
      for (const view of views) inFlight.delete(view.attemptId);
      warn(error);
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const service = manager;
    if (closing || !service) return;
    for (const [id, view] of outbox) {
      if (
        view.owner.attemptId &&
        service.attempt(view.owner.id, view.owner.attemptId)?.state !== "running"
      ) {
        outbox.delete(id);
        inFlight.delete(id);
      }
    }
    if (!service.context.isIdle()) return;
    const pending = [...outbox.values()].filter(
      (view) =>
        !view.owner.attemptId &&
        !inFlight.has(view.attemptId) &&
        !service.isConsumed(view.attemptId),
    );
    if (!pending.length) return;
    const individual = pending.some((view) => service.deliveryMode(view.attemptId) !== "group");
    const delay =
      individual || !service.joinedPending()
        ? 50
        : Math.max(0, (groupDeadline ?? Date.now()) - Date.now());
    timer = setTimeout(() => {
      timer = undefined;
      try {
        flushIdle();
      } catch (error) {
        warn(error);
      }
    }, delay);
  }

  function finished(service: AgentManager, view: AgentView): void {
    if (closing || manager !== service || !view.background || service.isConsumed(view.attemptId))
      return;
    outbox.set(view.attemptId, view);
    if (!view.owner.attemptId && service.deliveryMode(view.attemptId) === "group")
      groupDeadline ??= Date.now() + 30000;
    schedule();
  }

  async function getManager(ctx: ExtensionContext): Promise<AgentManager> {
    if (closing) throw new Error("Subagents are shutting down.");
    if (manager) {
      manager.context = ctx;
      return manager;
    }
    const generation = epoch;
    startup ??= (async () => {
      const [major = 0, minor = 0] = VERSION.split(".").map(Number);
      if (major < 1 || (major === 1 && minor < 4))
        throw new Error("Subagents requires Pi 1.4.0 or newer.");
      const catalog = await createCatalog(ctx);
      if (closing || generation !== epoch) throw new Error("Agent startup was cancelled.");
      const created = new AgentManager(pi, ctx, catalog);
      await restoreAttempts(created);
      if (closing || generation !== epoch) {
        await created.dispose();
        throw new Error("Agent startup was cancelled.");
      }
      manager = created;
      created.onComplete = (view) => finished(created, view);
      created.onBoundary = (owner, state, context) =>
        manager === created ? boundary(owner, state, context) : undefined;
      disposeUi = attachUi(pi, created);
      if (catalog.warnings.length && ctx.hasUI)
        ctx.ui.notify(`Subagent catalog:\n${catalog.warnings.join("\n")}`, "warning");
      for (const view of created.undelivered()) finished(created, view);
      return created;
    })();
    try {
      return await startup;
    } catch (error) {
      if (generation === epoch) startup = undefined;
      throw error;
    }
  }

  const [agent, collect, steer] = createAgentTools(getManager, undefined, true);
  pi.registerTool({
    ...agent,
    parameters: coreAgentParameters,
    ...agentRenderers(() => manager, cards),
  });
  pi.registerTool(collect);
  pi.registerTool(steer);
  pi.registerMessageRenderer("subagent-completion", (message, options, theme) => {
    const rendered = completionCards(message.details, theme, options.expanded);
    if (rendered) return rendered;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
    return new Text(plain(text).slice(0, options.expanded ? 24000 : 160), 0, 0);
  });
  pi.on("session_start", async (_event, ctx) => {
    closing = false;
    await getManager(ctx);
  });
  pi.on("tool_execution_start", (event) => {
    manager?.toolRoots.set(
      event.toolCallId,
      event.parentToolCallId
        ? (manager.toolRoots.get(event.parentToolCallId) ?? event.parentToolCallId)
        : event.toolCallId,
    );
  });
  pi.on("tool_execution_end", (event) => {
    manager?.toolRoots.delete(event.toolCallId);
  });
  pi.on("tool_result", (event) => {
    if (event.usage !== undefined) manager?.captureUsage(event.toolCallId);
  });
  pi.on("message_end", (event) => {
    if (event.message.role === "toolResult")
      manager?.commitUsage(event.message.toolCallId, event.message.usage !== undefined);
  });
  pi.on("turn_start", (_event, ctx) => {
    if (manager) ready(manager.root, ctx);
  });
  pi.on("turn_end", (state, ctx) => (manager ? boundary(manager.root, state, ctx) : undefined));
  pi.on("agent_settled", () => {
    schedule();
  });
  pi.on("session_compact", () => {
    if (closing) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        schedule();
      } catch (error) {
        warn(error);
      }
    }, 0);
  });
  pi.on("session_compact_failed", () => {
    schedule();
  });
  pi.on("agent_before_settle", async (state, ctx) => {
    const service = manager;
    if (!service || closing) return undefined;
    if (ctx.mode === "print" || ctx.mode === "json") {
      const pending = service
        .list()
        .filter((view) => view.owner.id === service.root.id && !isSettled(view.state));
      const abort = (): void => {
        for (const view of pending)
          void service.stop(view.id, undefined, view.attemptId).catch(warn);
      };
      ctx.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (ctx.signal?.aborted) abort();
        await Promise.all(pending.map((view) => service.wait(view.id, view.attemptId)));
      } finally {
        ctx.signal?.removeEventListener("abort", abort);
      }
      groupDeadline = 0;
    }
    if (ctx.signal?.aborted || state.outcome !== "completed") return undefined;
    return (
      boundary(service.root, state, ctx) ??
      (ctx.hasPendingMessages() ? { continue: true } : undefined)
    );
  });
  pi.on("session_shutdown", async () => {
    closing = true;
    epoch += 1;
    if (timer) clearTimeout(timer);
    timer = undefined;
    groupDeadline = undefined;
    outbox.clear();
    inFlight.clear();
    disposeUi?.();
    disposeUi = undefined;
    for (const card of cards) card.dispose();
    cards.clear();
    offWarnings();
    await manager?.dispose();
    await startup?.catch(() => undefined);
    manager = undefined;
    startup = undefined;
  });
}
