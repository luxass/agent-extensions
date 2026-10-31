import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { restoreAttempts } from "./attempts.ts";
import { createCatalog } from "./catalog.ts";
import { record } from "./io.ts";
import { AgentManager } from "./manager.ts";
import { type AgentCard, agentRenderers, completionCards, plain } from "./render.ts";
import { childSessionContext } from "./sessions.ts";
import { coreAgentParameters, createAgentTools, inlineView } from "./tools.ts";
import { isSettled, type AgentView } from "./transcript.ts";
import { attachUi } from "./ui.ts";

export default function subagents(pi: ExtensionAPI): void {
  if (childSessionContext.getStore()) return;
  let manager: AgentManager | undefined;
  let startup: Promise<AgentManager> | undefined;
  let disposeUi: (() => void) | undefined;
  let closing = false;
  let epoch = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let groupDeadline: number | undefined;
  let flushing: Promise<void> | undefined;
  const outbox = new Map<string, AgentView>();
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

  function schedule(): void {
    if (closing || !manager || !outbox.size) return;
    if (timer) clearTimeout(timer);
    const individual = [...outbox.values()].some(
      (view) => view.owner.attemptId || manager?.deliveryMode(view.attemptId) !== "group",
    );
    const delay =
      individual || !manager.joinedPending()
        ? 50
        : Math.max(0, (groupDeadline ?? Date.now()) - Date.now());
    timer = setTimeout(() => {
      timer = undefined;
      void flush().catch(warn);
    }, delay);
  }

  async function flush(): Promise<void> {
    if (flushing) return flushing;
    const service = manager;
    if (closing || !service) return;
    flushing = (async () => {
      const ready: AgentView[] = [];
      for (const [id, view] of outbox) {
        if (service.isConsumed(id)) {
          outbox.delete(id);
          continue;
        }
        if (view.owner.attemptId) {
          await service.notifyOwner(view);
          service.delivered(id);
          outbox.delete(id);
        } else if (
          service.deliveryMode(id) !== "group" ||
          !service.joinedPending() ||
          Date.now() >= (groupDeadline ?? 0)
        )
          ready.push(view);
      }
      if (ready.length) {
        const budget = Math.max(120, Math.floor(24000 / ready.length) - 300);
        childSessionContext.exit(() =>
          pi.sendMessage(
            {
              customType: "subagent-completion",
              display: true,
              details: { agents: ready.map(inlineView) },
              content: ready
                .map(
                  (view) =>
                    `${view.displayName} · ${view.task} · ${view.state}\nAgent: ${view.id}\nAttempt: ${view.attemptId}\nRecord: ${view.outputFile}\n${(view.error ? `${view.error}\n` : "") + (view.result || view.activity).slice(0, budget)}`,
                )
                .join("\n\n"),
            },
            { triggerTurn: true, deliverAs: "followUp" },
          ),
        );
        for (const view of ready) {
          service.delivered(view.attemptId);
          outbox.delete(view.attemptId);
        }
      }
      if (![...outbox.values()].some((view) => service.deliveryMode(view.attemptId) === "group"))
        groupDeadline = undefined;
      schedule();
    })();
    try {
      await flushing;
    } finally {
      flushing = undefined;
    }
  }

  function finished(service: AgentManager, view: AgentView): void {
    if (closing || manager !== service || !view.background || service.isConsumed(view.attemptId))
      return;
    outbox.set(view.attemptId, view);
    if (service.deliveryMode(view.attemptId) === "group") groupDeadline ??= Date.now() + 30000;
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
  pi.on("turn_end", async () => {
    if (outbox.size) await flush().catch(warn);
  });
  pi.on("agent_before_settle", async (_event, ctx) => {
    const service = manager;
    if ((ctx.mode !== "print" && ctx.mode !== "json") || !service || closing) return undefined;
    const pending = service
      .list()
      .filter((view) => view.owner.id === service.root.id && !isSettled(view.state));

    const abort = (): void => {
      for (const view of pending) void service.stop(view.id, undefined, view.attemptId).catch(warn);
    };

    ctx.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (ctx.signal?.aborted) abort();
      await Promise.all(pending.map((view) => service.wait(view.id, view.attemptId)));
    } finally {
      ctx.signal?.removeEventListener("abort", abort);
    }
    if (outbox.size) {
      groupDeadline = 0;
      await flush().catch(warn);
    }
    return ctx.hasPendingMessages() ? { continue: true } : undefined;
  });
  pi.on("session_shutdown", async () => {
    closing = true;
    epoch += 1;
    if (timer) clearTimeout(timer);
    timer = undefined;
    groupDeadline = undefined;
    outbox.clear();
    disposeUi?.();
    disposeUi = undefined;
    for (const card of cards) card.dispose();
    cards.clear();
    offWarnings();
    await manager?.dispose();
    await startup?.catch(() => undefined);
    await flushing?.catch(() => undefined);
    manager = undefined;
    startup = undefined;
  });
}
