import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { createCatalog } from "./catalog.ts";
import { Delivery } from "./delivery.ts";
import { record } from "./io.ts";
import { AgentManager } from "./manager.ts";
import { agentRenderers, completionCards, plain } from "./render.ts";
import { childSessionContext } from "./sessions.ts";
import { restoreAttempts } from "./storage.ts";
import { createAgentTools } from "./tools.ts";
import { isSettled, sameOwner } from "./types.ts";
import { attachUi } from "./ui.ts";

export default function subagents(pi: ExtensionAPI): void {
  // Child sessions load extensions too; only the main session runs the orchestrator.
  if (childSessionContext.getStore()) return;
  let manager: AgentManager | undefined;
  let delivery: Delivery | undefined;
  let startup: Promise<AgentManager> | undefined;
  let disposeUi: (() => void) | undefined;
  let closing = false;
  /** Incremented on shutdown, so a startup that finishes late is discarded. */
  let epoch = 0;

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
      const outbox = new Delivery(pi, created, warn);
      manager = created;
      delivery = outbox;
      created.onComplete = (view) => outbox.add(view);
      created.onBoundary = (owner, state, context) => outbox.boundary(owner, state, context);
      disposeUi = attachUi(pi, created);
      if (catalog.warnings.length && ctx.hasUI)
        ctx.ui.notify(`Subagent catalog:\n${catalog.warnings.join("\n")}`, "warning");
      for (const view of created.undelivered()) outbox.add(view);
      return created;
    })();
    try {
      return await startup;
    } catch (error) {
      if (generation === epoch) startup = undefined;
      throw error;
    }
  }

  const [agent, collect, steer, models] = createAgentTools(getManager, undefined, true);
  pi.registerTool({ ...agent, ...agentRenderers(() => manager) });
  pi.registerTool({ ...collect, ...agentRenderers(() => manager, "Agent result") });
  pi.registerTool({ ...steer, ...agentRenderers(() => manager, "Steer agent") });
  pi.registerTool({ ...models, ...agentRenderers(() => manager, "Subagent models") });
  pi.registerMessageRenderer("subagent-completion", (message, options, theme) => {
    const rendered = completionCards(message.details, theme, options.expanded, () => manager);
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
  pi.on("turn_start", (_event, ctx) => delivery?.sync(ctx));
  pi.on("turn_end", (state, ctx) =>
    manager ? delivery?.boundary(manager.root, state, ctx) : undefined,
  );
  pi.on("agent_settled", () => delivery?.schedule());
  // After /tree navigation, deliver results that the new branch started but never received.
  pi.on("session_tree", (_event, ctx) => delivery?.rebranch(ctx));
  // Wait one tick, so the session is idle again after compaction.
  pi.on("session_compact", () => delivery?.schedule(0));
  pi.on("session_compact_failed", () => delivery?.schedule());

  pi.on("agent_before_settle", async (state, ctx) => {
    const service = manager;
    if (!service || !delivery || closing) return undefined;
    // Print and JSON modes exit when the main agent settles, so wait for its children first.
    if (ctx.mode === "print" || ctx.mode === "json") {
      const pending = service
        .list()
        .filter((view) => sameOwner(view.owner, service.root) && !isSettled(view.state));
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
      delivery.releaseGroups();
    }
    if (ctx.signal?.aborted || state.outcome !== "completed") return undefined;
    return (
      delivery.boundary(service.root, state, ctx) ??
      (ctx.hasPendingMessages() ? { continue: true } : undefined)
    );
  });

  pi.on("session_shutdown", async () => {
    closing = true;
    epoch += 1;
    delivery?.dispose();
    delivery = undefined;
    disposeUi?.();
    disposeUi = undefined;
    offWarnings();
    await manager?.dispose();
    await startup?.catch(() => undefined);
    manager = undefined;
    startup = undefined;
  });
}
