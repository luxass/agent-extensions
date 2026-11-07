import type {
  BoundaryResult,
  BoundaryState,
  CustomMessageEntryDraft,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { AgentManager } from "./manager.ts";
import { childSessionContext } from "./sessions.ts";
import { inlineView, sameOwner, type AgentView, type Owner } from "./types.ts";

/** Grouped completions wait at most this long after the first one settles. */
const groupWindowMs = 30_000;

/** Both entry types share this shape: `subagent-start` and `subagent-receipt`. */
const attemptEntry = Type.Object({ version: Type.Literal(1), attemptId: Type.String() });
const completionMessage = Type.Object({
  agents: Type.Array(Type.Object({ attemptId: Type.String() })),
});
const collectedResult = Type.Object({
  attemptId: Type.String(),
  snapshot: Type.Object({
    state: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
    ]),
  }),
});

export interface BranchState {
  /** Top-level attempts that were started on this branch. */
  readonly started: ReadonlySet<string>;
  /**
   * Attempts whose result is already on this branch: a collection receipt,
   * a completion message, or a settled tool result.
   */
  readonly received: ReadonlySet<string>;
}

/**
 * Read only the current branch, from the root to the current position. After /tree navigation,
 * entries on other branches are not part of this conversation, so they do not count.
 */
export function branchState(ctx: ExtensionContext): BranchState {
  const started = new Set<string>();
  const received = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && Value.Check(attemptEntry, entry.data)) {
      if (entry.customType === "subagent-start") started.add(entry.data.attemptId);
      if (entry.customType === "subagent-receipt") received.add(entry.data.attemptId);
    }
    if (entry.type === "custom_message" && entry.customType === "subagent-completion") {
      const details: unknown = entry.details;
      if (Value.Check(completionMessage, details))
        for (const agent of details.agents) received.add(agent.attemptId);
    }
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const details: unknown = entry.message.details;
      if (Value.Check(collectedResult, details)) received.add(details.attemptId);
    }
  }
  return { started, received };
}

function completion(views: readonly AgentView[]): CustomMessageEntryDraft {
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

/**
 * Deliver settled background attempts to their owner as completion messages.
 * While the owner is busy, completions join its next boundary. While it is idle,
 * a short timer sends them and starts a turn.
 */
export class Delivery {
  private readonly outbox = new Map<string, AgentView>();
  /** Sent but not yet seen in session history. */
  private readonly inFlight = new Set<string>();
  private groupDeadline?: number;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly manager: AgentManager,
    private readonly warn: (error: unknown) => void,
  ) {}

  /** Queue a settled background attempt that its owner has not collected. */
  add(view: AgentView): void {
    if (
      this.closed ||
      !view.background ||
      !this.canDeliver(view) ||
      this.manager.isConsumed(view.attemptId)
    )
      return;
    this.outbox.set(view.attemptId, view);
    if (this.grouped(view)) this.groupDeadline ??= Date.now() + groupWindowMs;
    this.schedule();
  }

  /** Release grouped completions now, for print mode after all work settles. */
  releaseGroups(): void {
    this.groupDeadline = 0;
  }

  /** Drop entries that history already shows as received. */
  sync(ctx: ExtensionContext): void {
    this.ready(this.manager.root, ctx);
  }

  /**
   * After /tree navigation, queue every finished top-level background result that the new
   * branch started but never received. Results that the branch already has, or that it never
   * asked for, stay out.
   */
  rebranch(ctx: ExtensionContext): void {
    if (this.closed) return;
    const { started, received } = branchState(ctx);
    for (const view of this.manager.finishedBackgroundAttempts())
      if (this.canDeliver(view) && started.has(view.attemptId) && !received.has(view.attemptId)) {
        this.manager.markUndelivered(view.attemptId);
        // The previous branch may have had this delivery in flight; this branch needs its own.
        this.inFlight.delete(view.attemptId);
        this.add(view);
      }
    // Pi reports the session as busy while it emits session_tree, so wait one tick.
    this.schedule(0);
  }

  /** Append ready completions to a finished turn of `owner` and continue it. */
  boundary(owner: Owner, state: BoundaryState, ctx: ExtensionContext): BoundaryResult | undefined {
    if (this.closed || state.outcome !== "completed" || ctx.signal?.aborted) return undefined;
    // A boundary means earlier sends were processed or lost, so retry in-flight entries.
    const views = this.ready(owner, ctx, true);
    if (!views.length) return undefined;
    for (const view of views) this.inFlight.add(view.attemptId);
    return { entries: [...state.entries, completion(views)], continue: true };
  }

  /** Plan the next idle delivery. Busy sessions deliver at their next boundary instead. */
  schedule(delay?: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed) return;
    if (delay !== undefined) {
      this.timer = setTimeout(() => this.schedule(), delay);
      return;
    }
    // A nested owner that stopped running can no longer receive its children's results.
    for (const [id, view] of this.outbox)
      if (
        view.owner.attemptId &&
        this.manager.attempt(view.owner.id, view.owner.attemptId)?.state !== "running"
      ) {
        this.outbox.delete(id);
        this.inFlight.delete(id);
      }
    if (!this.manager.context.isIdle()) return;
    const { started } = branchState(this.manager.context);
    const pending = [...this.outbox.values()].filter(
      (view) =>
        !view.owner.attemptId &&
        started.has(view.attemptId) &&
        !this.inFlight.has(view.attemptId) &&
        !this.manager.isConsumed(view.attemptId),
    );
    if (!pending.length) return;
    const wait = pending.some((view) => !this.held(view))
      ? 50
      : Math.max(0, (this.groupDeadline ?? 0) - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.flush();
      } catch (error) {
        this.warn(error);
      }
    }, wait);
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.outbox.clear();
    this.inFlight.clear();
  }

  private canDeliver(view: AgentView): boolean {
    const attempt = this.manager.attempts.get(view.attemptId);
    return !!attempt && !attempt.restoredUnsettled && !attempt.deliverySuppressed;
  }

  private grouped(view: AgentView): boolean {
    return !view.owner.attemptId && this.manager.deliveryMode(view.attemptId) === "group";
  }

  /** Grouped completions wait until every grouped attempt settles or the window ends. */
  private held(view: AgentView): boolean {
    return (
      this.grouped(view) && this.manager.joinedPending() && Date.now() < (this.groupDeadline ?? 0)
    );
  }

  private ready(owner: Owner, ctx: ExtensionContext, retry = false): AgentView[] {
    if (this.closed) return [];
    const { started, received } = branchState(ctx);
    const views: AgentView[] = [];
    for (const [id, view] of this.outbox) {
      if (!sameOwner(view.owner, owner)) continue;
      if (!this.canDeliver(view)) {
        this.outbox.delete(id);
        this.inFlight.delete(id);
        continue;
      }
      if (received.has(id)) this.manager.delivered(id);
      if (this.manager.isConsumed(id)) {
        this.outbox.delete(id);
        this.inFlight.delete(id);
        continue;
      }
      // The user navigated to a branch that never asked for this agent. Keep the result
      // queued: navigating back to the branch that started it delivers it there.
      if (!view.owner.attemptId && !started.has(id)) continue;
      if (retry) this.inFlight.delete(id);
      if (!this.inFlight.has(id) && !this.held(view)) views.push(view);
    }
    if (![...this.outbox.values()].some((view) => this.grouped(view)))
      this.groupDeadline = undefined;
    return views;
  }

  private flush(): void {
    if (this.closed || !this.manager.context.isIdle()) return;
    const views = this.ready(this.manager.root, this.manager.context);
    for (const view of views) this.inFlight.add(view.attemptId);
    // A short idle send must not strand grouped entries until another event arrives.
    this.schedule();
    if (!views.length) return;
    try {
      childSessionContext.exit(() => this.pi.sendMessage(completion(views), { triggerTurn: true }));
    } catch (error) {
      for (const view of views) this.inFlight.delete(view.attemptId);
      this.warn(error);
    }
  }
}
