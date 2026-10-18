import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { HerdrBlockedReporter } from "@luxass/herdr-agent-shared";

import { QuestionDialog } from "./dialog.ts";
import {
  cancelledResult,
  findQuestionsProblem,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  QuestionsSchema,
  RESERVED_LABELS_TEXT,
  ResultSchema,
  type QuestionResult,
  type Questions,
} from "./questions.ts";

const TOOL_NAME = "ask_questions";
// Only one questionnaire can own Pi's editor slot. Others stack at the bottom as overlays.
let inlineInUse = false;

async function showQuestions(
  pi: ExtensionAPI,
  blocked: HerdrBlockedReporter,
  params: Questions,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<QuestionResult> {
  const problem = findQuestionsProblem(params);
  if (problem) return cancelledResult("invalid_questions", problem);
  if (ctx.mode !== "tui")
    return cancelledResult(
      "no_ui",
      "Questions were not shown. This tool requires interactive Pi. Ask the user in plain chat instead.",
    );
  if (signal?.aborted) return cancelledResult("aborted");
  let dialog: QuestionDialog | undefined;
  const abort = () => dialog?.abort();
  signal?.addEventListener("abort", abort);
  // Resolves to `undefined` when an inline mount finds the editor slot covered by an overlay.
  const mount = (overlay: boolean) =>
    ctx.ui.custom<QuestionResult | undefined>(
      (tui, theme, keybindings, done) => {
        // Do not mount an invisible question beneath an existing overlay.
        if (!overlay && tui.hasOverlay()) {
          done(undefined);
          return { render: () => [], invalidate() {} };
        }
        dialog = new QuestionDialog({ params, tui, theme, keybindings, done });
        if (signal?.aborted) dialog.abort();
        return dialog;
      },
      overlay
        ? {
            overlay: true,
            overlayOptions: { width: "100%", maxHeight: "70%", anchor: "bottom-center" },
          }
        : { overlay: false },
    );
  let ownsInlineSlot = !inlineInUse;
  if (ownsInlineSlot) inlineInUse = true;
  const releaseLabel = blocked.block("Waiting for answers");
  try {
    // Herdr's optional Pi integration owns state reporting and counts overlapping blockers.
    pi.events.emit("herdr:blocked", { active: true, label: "Waiting for answers" });
    if (ownsInlineSlot) {
      const result = await mount(false);
      if (result) return result;
      inlineInUse = false;
      ownsInlineSlot = false;
      if (signal?.aborted) return cancelledResult("aborted");
    }
    return (await mount(true)) ?? cancelledResult("aborted");
  } finally {
    if (ownsInlineSlot) inlineInUse = false;
    signal?.removeEventListener("abort", abort);
    pi.events.emit("herdr:blocked", { active: false });
    await releaseLabel();
  }
}
export default function askQuestions(pi: ExtensionAPI) {
  const blocked = new HerdrBlockedReporter({
    source: "pi-questions:blocked",
    agent: "pi",
    appliesToSource: "herdr:pi",
  });
  pi.on("session_shutdown", () => blocked.clear());
  pi.registerTool<typeof QuestionsSchema, QuestionResult>({
    name: TOOL_NAME,
    label: "Ask user",
    description: `Ask the user 1–${MAX_QUESTIONS} related questions in a tabbed questionnaire. Give each question ${MIN_OPTIONS}–${MAX_OPTIONS} distinct options with descriptions. Optional previews are Markdown: use code fences for code or ASCII mockups. The user can select one or several options, type a custom answer, add notes, and review before submitting. Do not author ${RESERVED_LABELS_TEXT} options. Never treat cancellation or unanswered questions as approval.`,
    promptSnippet:
      "Clarify unclear goals, scope, and constraints before implementation instead of guessing.",
    promptGuidelines: [
      `Before implementing a new system or substantial feature, use ${TOOL_NAME} to clarify unclear goals, scope, and constraints. Skip questions the user has already answered.`,
      `Use ${TOOL_NAME} when a meaningful user decision blocks progress, not for routine implementation details.`,
      "Batch related questions and describe the trade-offs of each option. The UI supplies custom answers and notes.",
      "Include Markdown previews when examples help the user compare alternatives.",
      "Do not infer a choice for cancelled or unanswered questions. Notes alone do not answer a question.",
    ],
    parameters: QuestionsSchema,
    outputSchema: ResultSchema,
    exposure: "model-only",
    // Sequential execution keeps two questionnaires from competing for input.
    executionMode: "sequential",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async execute(_id, params, signal, _update, ctx) {
      const result = await showQuestions(pi, blocked, params, ctx, signal);
      const prefix =
        result.message ??
        (result.cancelled
          ? "The questionnaire was cancelled. No answers were submitted."
          : "The user submitted these answers. Unanswered questions remain undecided.");
      return {
        content: [{ type: "text", text: `${prefix}\n${JSON.stringify(result, null, 2)}` }],
        details: result,
        structuredContent: result,
        isError: Boolean(result.error && result.error !== "aborted"),
      };
    },
    renderCall(args, theme) {
      const headers = Array.isArray(args.questions)
        ? args.questions
            .map((question) => question?.header)
            .filter((header) => typeof header === "string")
        : [];
      return new Text(
        theme.fg("toolTitle", "Ask user") +
          theme.fg("muted", ` · ${stripTerminalSequences(headers.join(" · "))}`),
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      const details = result.details;
      if (!details)
        return new Text(
          result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
          0,
          0,
        );
      if (options.expanded) return new Text(JSON.stringify(details, null, 2), 0, 0);
      const count = details.answers.length;
      const label = details.error
        ? (details.message ?? details.error)
        : details.cancelled
          ? "Questionnaire cancelled"
          : `${count} ${count === 1 ? "answer" : "answers"} submitted${details.unanswered?.length ? ` · ${details.unanswered.length} unanswered` : ""}`;
      return new Text(
        theme.fg(details.cancelled ? "warning" : "success", stripTerminalSequences(label)),
        0,
        0,
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui")
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== TOOL_NAME));
  });
}
