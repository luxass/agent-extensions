import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;

/** Labels the dialog supplies itself. Authored options must not duplicate them. */
export const RESERVED_LABELS_TEXT = "Other, Type something., or Next";
// Ignore case and punctuation so `Other:` or `Type something` still match.
const RESERVED_LABEL = /^\W*(other|type\W*something|next)\W*$/iu;

// Pi validates arguments against this schema and reports problems to the model.
// The `\\S` pattern rejects blank text.
export const QuestionsSchema = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          question: Type.String({ pattern: "\\S" }),
          header: Type.String({ pattern: "\\S", maxLength: 16 }),
          options: Type.Array(
            Type.Object(
              {
                label: Type.String({ pattern: "\\S", maxLength: 60 }),
                description: Type.String({ pattern: "\\S" }),
                preview: Type.Optional(
                  Type.String({ description: "Markdown, code, or a mockup for this option." }),
                ),
              },
              { additionalProperties: false },
            ),
            { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS },
          ),
          multiSelect: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_QUESTIONS },
    ),
  },
  { additionalProperties: false },
);

export type Questions = Static<typeof QuestionsSchema>;
export type Question = Questions["questions"][number];

export interface Answer {
  questionIndex: number;
  question: string;
  selected: string[];
  custom?: string;
  notes?: string;
}

export interface QuestionResult {
  answers: Answer[];
  cancelled: boolean;
  globalNote?: string;
  unanswered?: number[];
  message?: string;
  error?: "no_ui" | "invalid_questions" | "aborted";
}

/** The dialog's state for one question. */
export interface AnswerDraft {
  selected: Set<number>;
  custom: string;
  notes: string;
}

/** Builds a result that carries no answers, optionally explaining why. */
export function cancelledResult(error?: QuestionResult["error"], message?: string): QuestionResult {
  return {
    answers: [],
    cancelled: true,
    ...(error ? { error } : {}),
    ...(message ? { message } : {}),
  };
}

/** Returns a model-readable problem the schema cannot express, or `undefined`. */
export function findQuestionsProblem(params: Questions): string | undefined {
  if (
    params.questions.some((question) =>
      question.options.some((option) => RESERVED_LABEL.test(option.label)),
    )
  )
    return `Do not author ${RESERVED_LABELS_TEXT} options. The UI provides custom answers and navigation.`;
  return undefined;
}

/** Removes terminal control sequences from every authored string before display. */
export function sanitizeQuestions(params: Questions): Questions {
  return {
    questions: params.questions.map((question) => ({
      ...question,
      question: stripTerminalSequences(question.question),
      header: stripTerminalSequences(question.header),
      options: question.options.map((option) => ({
        ...option,
        label: stripTerminalSequences(option.label),
        description: stripTerminalSequences(option.description),
        ...(option.preview == null ? {} : { preview: stripTerminalSequences(option.preview) }),
      })),
    })),
  };
}

export function collectAnswers(
  params: Questions,
  drafts: readonly AnswerDraft[],
  globalNote: string,
): QuestionResult {
  const answers: Answer[] = [];
  const unanswered: number[] = [];
  params.questions.forEach((question, questionIndex) => {
    const draft = drafts[questionIndex]!;
    const selected = question.options
      .filter((_option, index) => draft.selected.has(index))
      .map((option) => option.label);
    const custom = draft.custom.trim();
    const notes = draft.notes.trim();
    if (!selected.length && !custom) unanswered.push(questionIndex);
    if (!selected.length && !custom && !notes) return;
    answers.push({
      questionIndex,
      question: question.question,
      selected,
      ...(custom ? { custom } : {}),
      ...(notes ? { notes } : {}),
    });
  });
  const note = globalNote.trim();
  return {
    answers,
    cancelled: false,
    ...(note ? { globalNote: note } : {}),
    ...(unanswered.length ? { unanswered } : {}),
  };
}

export function answerText(answer: Answer): string {
  return [...answer.selected, answer.custom].filter(Boolean).join(", ") || "Not answered";
}
