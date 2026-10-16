import { Type, type Static } from "typebox";
import { Errors } from "typebox/value";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

/** Labels the dialog supplies itself. Authored options must not duplicate them. */
export const RESERVED_LABELS = ["Other", "Type something.", "Next"] as const;

/** Human-readable list of reserved labels, e.g. for tool descriptions and errors. */
export const RESERVED_LABELS_TEXT = `${RESERVED_LABELS.slice(0, -1).join(", ")}, or ${RESERVED_LABELS.at(-1)}`;
// RESERVED_LABELS lowercased without punctuation, for matching.
const RESERVED = new Set(["other", "type something", "next"]);

const OptionSchema = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: MAX_LABEL_LENGTH }),
    description: Type.String({ minLength: 1 }),
    preview: Type.Optional(
      Type.String({ description: "Markdown, code, or a mockup for this option." }),
    ),
  },
  { additionalProperties: false },
);

export const QuestionsSchema = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          question: Type.String({ minLength: 1 }),
          header: Type.String({ minLength: 1, maxLength: MAX_HEADER_LENGTH }),
          options: Type.Array(OptionSchema, { minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS }),
          multiSelect: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_QUESTIONS },
    ),
  },
  { additionalProperties: false },
);

const QuestionIndexSchema = Type.Integer({ minimum: 0, maximum: MAX_QUESTIONS - 1 });

export const ResultSchema = Type.Object(
  {
    answers: Type.Array(
      Type.Object(
        {
          questionIndex: QuestionIndexSchema,
          question: Type.String(),
          kind: Type.Union([Type.Literal("option"), Type.Literal("custom"), Type.Literal("multi")]),
          answer: Type.Union([Type.String(), Type.Null()]),
          selected: Type.Optional(Type.Array(Type.String())),
          notes: Type.Optional(Type.String()),
          preview: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    cancelled: Type.Boolean(),
    globalNote: Type.Optional(Type.String()),
    unanswered: Type.Optional(Type.Array(QuestionIndexSchema)),
    message: Type.Optional(Type.String()),
    error: Type.Optional(
      Type.Union([
        Type.Literal("no_ui"),
        Type.Literal("invalid_questions"),
        Type.Literal("aborted"),
      ]),
    ),
  },
  { additionalProperties: false },
);

export type Questions = Static<typeof QuestionsSchema>;
export type Question = Questions["questions"][number];
export type QuestionResult = Static<typeof ResultSchema>;
export type QuestionError = NonNullable<QuestionResult["error"]>;
export type Answer = QuestionResult["answers"][number];

export interface AnswerDraft {
  selected: Set<number>;
  custom: string;
  notes: string;
}

/** Builds a result that carries no answers, optionally explaining why. */
export function cancelledResult(error?: QuestionError, message?: string): QuestionResult {
  return {
    answers: [],
    cancelled: true,
    ...(error ? { error } : {}),
    ...(message ? { message } : {}),
  };
}

/** Returns a model-readable problem description, or `undefined` when the questions are valid. */
export function findQuestionsProblem(params: unknown): string | undefined {
  const problems = new Set<string>();
  for (const error of Errors(QuestionsSchema, params))
    // `additionalProperties: false` also reports a less useful `schema is false` entry.
    if (error.keyword !== "boolean") problems.add(`${error.instancePath || "/"} ${error.message}`);
  if (problems.size)
    return `Provide 1–${MAX_QUESTIONS} questions with ${MIN_OPTIONS}–${MAX_OPTIONS} options each, non-empty text, headers up to ${MAX_HEADER_LENGTH} characters, and labels up to ${MAX_LABEL_LENGTH} characters. Problems: ${[...problems].slice(0, 5).join("; ")}.`;
  const { questions } = params as Questions;
  const seenQuestions = new Set<string>();
  for (const question of questions) {
    const key = question.question.trim().toLowerCase();
    if (!key || !question.header.trim()) return "Questions and headers must not be blank.";
    if (seenQuestions.has(key)) return "Questions must be distinct.";
    seenQuestions.add(key);
    const seenLabels = new Set<string>();
    for (const option of question.options) {
      const label = option.label.trim().toLowerCase();
      if (!label || !option.description.trim())
        return "Option labels and descriptions must not be blank.";
      // Ignore punctuation so `Other:` or `Type something` still match.
      if (
        RESERVED.has(
          label
            .replace(/[^\p{L}\p{N}\s]/gu, "")
            .replace(/\s+/g, " ")
            .trim(),
        )
      )
        return `Do not author ${RESERVED_LABELS_TEXT} options. The UI provides custom answers and navigation.`;
      if (seenLabels.has(label)) return "Option labels must be distinct within each question.";
      seenLabels.add(label);
    }
  }
  return undefined;
}

export function collectAnswers(
  params: Questions,
  drafts: readonly AnswerDraft[],
  globalNote: string,
): QuestionResult {
  const answers: Answer[] = [];
  const unanswered: number[] = [];
  params.questions.forEach((question, questionIndex) => {
    const draft = drafts[questionIndex];
    if (!draft) return;
    const options = question.options.filter((_option, index) => draft.selected.has(index));
    const custom = draft.custom.trim();
    const notes = draft.notes.trim();
    const answered = options.length > 0 || custom.length > 0;
    if (!answered) unanswered.push(questionIndex);
    if (!answered && !notes) return;
    const notesField = notes ? { notes } : {};
    if (question.multiSelect) {
      answers.push({
        questionIndex,
        question: question.question,
        kind: "multi",
        answer: custom || null,
        selected: options.map((option) => option.label),
        ...notesField,
      });
      return;
    }
    const [option] = options;
    answers.push({
      questionIndex,
      question: question.question,
      kind: option ? "option" : "custom",
      answer: option?.label ?? (custom || null),
      ...notesField,
      ...(option?.preview ? { preview: option.preview } : {}),
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
  if (answer.kind === "multi")
    return (
      [...(answer.selected ?? []), ...(answer.answer ? [answer.answer] : [])].join(", ") ||
      "Not answered"
    );
  return answer.answer || "Not answered";
}
