import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { AgentView, Owner, Usage } from "./types.ts";

/** Fields that identify the attempt in every attempt event. */
export interface AttemptSubject {
  /** Stable agent ID. It stays the same across resumes. */
  readonly id: string;
  /** ID of this execution. Each resume or restart creates a new one. */
  readonly attemptId: string;
  /** Handle, such as `reviewer` or `explore-2`. */
  readonly name: string;
  /** Definition name, such as `Explore`. */
  readonly agentType: string;
  /** The main session (`{ id: sessionId }`) or the parent attempt that owns this one. */
  readonly owner: Owner;
}

/**
 * Events emitted on `pi.events`. Other extensions can subscribe with
 * `pi.events.on("subagents:completed", (payload) => ...)`.
 */
export interface SubagentEvents {
  /** An attempt was created and is waiting for capacity. */
  "subagents:created": AttemptSubject;
  /** The child session started and the agent is working. */
  "subagents:started": AttemptSubject;
  /** Instructions were queued for a running attempt. */
  "subagents:steered": AttemptSubject;
  /** The attempt finished successfully. */
  "subagents:completed": AttemptSubject & {
    readonly state: "completed";
    readonly result: string;
  };
  /** The attempt failed or was stopped. `state` tells them apart. */
  "subagents:failed": AttemptSubject & {
    readonly state: "failed" | "cancelled";
    readonly result: string;
    readonly error?: string;
  };
  /** Final usage of a settled attempt, including its nested children. */
  "subagents:usage": AttemptSubject & { readonly usage: Usage };
  /** A warning for the user, such as a model outside the enabled scope. */
  "subagents:warning": { readonly error: string };
}

export function subject(view: AgentView): AttemptSubject {
  return {
    id: view.id,
    attemptId: view.attemptId,
    name: view.name,
    agentType: view.agentType,
    owner: { ...view.owner },
  };
}

/** Emit a typed event, so payloads cannot drift from the documented shape. */
export function emit<K extends keyof SubagentEvents>(
  pi: ExtensionAPI,
  name: K,
  payload: SubagentEvents[K],
): void {
  pi.events.emit(name, payload);
}
