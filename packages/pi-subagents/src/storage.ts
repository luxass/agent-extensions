import { access, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { parseAgent, serializeAgent } from "./agents.ts";
import { Attempt } from "./attempts.ts";
import { branchState, type BranchState } from "./delivery.ts";
import { atomicWrite, isMissing, readText } from "./io.ts";
import type { AgentManager } from "./manager.ts";
import { agentParameters } from "./tools.ts";
import { decodeTranscript, promptTitle, taskTitle } from "./transcript.ts";
import {
  isSettled,
  sameOwner,
  thinkingSchema,
  usageSchema,
  type AgentView,
  type TranscriptRow,
} from "./types.ts";

/**
 * Files under `<agentDir>/subagents/<main-session-id>/v1/`:
 * - `attempts/<attemptId>.json`: the saved record below.
 * - `attempts/<attemptId>.transcript.json`: the conversation view, written once settled.
 * - `sessions/<attemptId>/`: the SDK session of the attempt.
 */
const maxRecordBytes = 8_000_000;
const maxTranscriptBytes = 8_000_000;

const uuid = Type.String({ pattern: "^[a-f0-9-]{36}$" });

const recordSchema = Type.Object({
  version: Type.Literal(1),
  id: uuid,
  attemptId: uuid,
  attemptNumber: Type.Integer({ minimum: 1 }),
  owner: Type.Object({ id: Type.String(), attemptId: Type.Optional(Type.String()) }),
  depth: Type.Integer({ minimum: 1 }),
  name: Type.String(),
  /** The request after defaults were applied. Resume reuses it. */
  request: agentParameters,
  /** The definition as a Markdown file, so resume keeps the original policy. */
  definition: Type.String(),
  source: Type.Union([
    Type.Literal("builtin"),
    Type.Literal("project"),
    Type.Literal("user"),
    Type.Literal("package"),
  ]),
  /** Instruction snapshot from the child session, so resume keeps the original prompt. */
  instructions: Type.Optional(Type.String()),
  state: Type.String(),
  activity: Type.String(),
  background: Type.Boolean(),
  createdAt: Type.Number(),
  startedAt: Type.Optional(Type.Number()),
  finishedAt: Type.Optional(Type.Number()),
  result: Type.String(),
  error: Type.Optional(Type.String()),
  usage: usageSchema,
  lifetimeUsage: usageSchema,
  turns: Type.Number(),
  toolCalls: Type.Number(),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(thinkingSchema),
  sessionFile: Type.Optional(Type.String()),
  /** False when the SDK session cleanup was not confirmed. Resume is then blocked. */
  cleanupSafe: Type.Boolean(),
  /** `suppressed`: shutdown cancelled delivery on every branch. */
  delivery: Type.Union([
    Type.Literal("inline"),
    Type.Literal("pending"),
    Type.Literal("consumed"),
    Type.Literal("suppressed"),
  ]),
});

type AttemptRecord = Static<typeof recordSchema>;

function transcriptFile(view: AgentView): string {
  return view.outputFile.replace(/\.json$/, ".transcript.json");
}

function toRecord(
  attempt: Attempt,
  state: AgentView["state"],
  error?: string,
  finishedAt?: number,
): AttemptRecord {
  const view = attempt.view;
  return {
    version: 1,
    id: view.id,
    attemptId: view.attemptId,
    attemptNumber: view.attemptNumber,
    owner: { ...view.owner },
    depth: view.depth,
    name: view.name,
    request: attempt.request,
    definition: serializeAgent(view.definition),
    source: view.definition.source,
    instructions: attempt.instructions,
    state,
    activity: view.activity,
    background: view.background,
    createdAt: view.createdAt,
    startedAt: view.startedAt,
    finishedAt,
    result: view.result,
    error,
    usage: { ...view.usage },
    lifetimeUsage: { ...view.lifetimeUsage },
    turns: view.turns,
    toolCalls: view.toolCalls,
    model: view.model,
    thinking: view.thinking,
    sessionFile: view.sessionFile,
    cleanupSafe: attempt.cleanupSafe,
    delivery: attempt.deliverySuppressed
      ? "suppressed"
      : attempt.consumed
        ? "consumed"
        : view.background
          ? "pending"
          : "inline",
  };
}

/**
 * Save the attempt record. Once settled, also save the conversation view, unless it is too
 * large: an oversized view must not block the terminal record, and the SDK session file still
 * holds the full conversation.
 */
export async function writeAttempt(
  attempt: Attempt,
  state: AgentView["state"],
  error?: string,
  finishedAt?: number,
  transcript?: readonly TranscriptRow[],
): Promise<void> {
  const data = JSON.stringify(toRecord(attempt, state, error, finishedAt));
  if (Buffer.byteLength(data) > maxRecordBytes)
    throw new Error("Attempt record exceeds 8 MB; read the SDK session file for the conversation.");
  if (transcript && isSettled(state)) {
    const conversation = JSON.stringify(transcript);
    if (Buffer.byteLength(conversation) <= maxTranscriptBytes)
      await atomicWrite(transcriptFile(attempt.view), conversation);
  }
  await atomicWrite(attempt.view.outputFile, data);
}

export async function readTranscript(view: AgentView): Promise<readonly TranscriptRow[]> {
  let text: string;
  try {
    text = await readText(transcriptFile(view), maxTranscriptBytes);
  } catch (error) {
    if (!isMissing(error)) throw error;
    throw new Error(
      `No saved conversation view. Read the SDK session file instead: ${view.sessionFile ?? "unavailable"}`,
      { cause: error },
    );
  }
  return decodeTranscript(JSON.parse(text));
}

/** Load saved attempts of this main session. Corrupt files are reported and left unchanged. */
export async function restoreAttempts(manager: AgentManager): Promise<void> {
  const directory = join(manager.directory, "attempts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = (await readdir(directory)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
  const branch = branchState(manager.context);
  const restored: Attempt[] = [];
  for (const file of files) {
    try {
      const value: unknown = JSON.parse(await readText(join(directory, file), maxRecordBytes));
      if (!Value.Check(recordSchema, value)) throw new Error("Invalid attempt record.");
      restored.push(await restore(manager, value, join(directory, file), branch));
    } catch (error) {
      manager.warn(`Cannot restore ${file}: ${String(error)}. The file was left unchanged.`);
    }
  }
  for (const attempt of restored.toSorted((a, b) => a.view.createdAt - b.view.createdAt))
    manager.insertRestored(attempt);
  manager.changed();
}

async function restore(
  manager: AgentManager,
  saved: AttemptRecord,
  outputFile: string,
  branch: BranchState,
): Promise<Attempt> {
  const definition = parseAgent(saved.definition, `${saved.id}.md`, saved.source);
  // An unsettled record may still belong to another live process; never rewrite it.
  const savedState =
    saved.state === "completed" || saved.state === "cancelled" || saved.state === "failed"
      ? saved.state
      : undefined;
  const settled = savedState !== undefined;
  let sessionIssue: string | undefined;
  if (saved.sessionFile)
    await access(saved.sessionFile).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
      sessionIssue = "The saved SDK session file is missing. Its result remains readable.";
    });
  const cleanupSafe = saved.cleanupSafe && settled && !sessionIssue;
  const view: AgentView = {
    id: saved.id,
    attemptId: saved.attemptId,
    attemptNumber: saved.attemptNumber,
    owner: saved.owner,
    depth: saved.depth,
    name: saved.name,
    agentType: definition.name,
    displayName: definition.displayName ?? definition.name,
    task: taskTitle({
      task:
        saved.request.description || promptTitle(saved.request.prompt) || "Task title unavailable",
    }),
    prompt: saved.request.prompt,
    state: savedState ?? "failed",
    activity: saved.activity,
    background: saved.background,
    createdAt: saved.createdAt,
    startedAt: saved.startedAt,
    finishedAt: saved.finishedAt,
    result: saved.result,
    error: settled
      ? saved.error
      : "Saved execution was not settled. It is not controlled by this instance; Resume is blocked until cleanup can be established. Start a new attempt explicitly if appropriate.",
    model: saved.model,
    thinking: saved.thinking,
    usage: saved.usage,
    lifetimeUsage: saved.lifetimeUsage,
    turns: saved.turns,
    toolCalls: saved.toolCalls,
    outputFile,
    sessionFile: saved.sessionFile,
    definition,
    transcript: [],
    transcriptLoaded: false,
    resumeBlocked: cleanupSafe
      ? undefined
      : (sessionIssue ?? "Saved cleanup could not be confirmed. Start a fresh session explicitly."),
  };
  const attempt = new Attempt(manager, view, saved.request);
  attempt.instructions = saved.instructions;
  attempt.cleanupSafe = cleanupSafe;
  attempt.restoredUnsettled = !settled;
  attempt.deliverySuppressed = saved.delivery === "suppressed";
  // The current branch decides background delivery: a main-session result is pending only when
  // this branch started the agent and does not have its result yet. /tree navigation re-checks.
  attempt.consumed =
    attempt.deliverySuppressed ||
    saved.delivery === "inline" ||
    !settled ||
    !sameOwner(saved.owner, manager.root) ||
    !branch.started.has(saved.attemptId) ||
    branch.received.has(saved.attemptId);
  attempt.resolve(view);
  return attempt;
}
