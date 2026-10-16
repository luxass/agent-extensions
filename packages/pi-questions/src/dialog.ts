import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  isKeyRelease,
  isKeyRepeat,
  Markdown,
  matchesKey,
  ScrollView,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import {
  answerText,
  cancelledResult,
  collectAnswers,
  type AnswerDraft,
  type QuestionResult,
  type Questions,
} from "./questions.ts";

interface DialogOptions {
  params: Questions;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  done: (result: QuestionResult) => void;
}

type EditMode = "custom" | "notes";
type Mode = EditMode | "preview" | "question" | undefined;

interface Keys {
  cancel: boolean;
  confirm: boolean;
  up: boolean;
  down: boolean;
  newLine: boolean;
}

export class QuestionDialog implements Component, Focusable {
  private readonly options: DialogOptions;
  private readonly questions: Questions["questions"];
  private readonly drafts: AnswerDraft[];
  private readonly rows: number[];
  private readonly editors = new Map<string, Editor>();
  private readonly markdown = new Map<string, Markdown>();
  private readonly scroll: ScrollView;
  private tab = 0;
  private mode: Mode;
  private globalNote = "";
  private reviewRow = 0;
  private focus = false;
  private closed = false;
  private collapsed = false;
  private followSelection = true;
  private selectedLine = 0;
  private page = 1;
  private warning = "";
  private headerTargets: { tab: number; start: number; end: number }[] = [];
  private mouseWidth = 0;

  constructor(options: DialogOptions) {
    this.options = options;
    this.questions = options.params.questions;
    this.drafts = this.questions.map(() => ({
      selected: new Set<number>(),
      custom: "",
      notes: "",
    }));
    this.rows = this.questions.map(() => 0);
    this.scroll = new ScrollView(
      {
        render: (width) => this.body(width),
        invalidate: () => this.markdown.clear(),
      },
      { scrollbar: "hidden" },
    );
  }

  get focused(): boolean {
    return this.focus;
  }
  set focused(value: boolean) {
    this.focus = value;
    this.syncFocus();
  }

  /** The Review tab follows the question tabs and only exists with several questions. */
  private get isReview(): boolean {
    return this.tab === this.drafts.length;
  }

  /** Focusing the `Type something.` row, which follows the options, opens its editor. */
  private modeForRow(tab: number): Mode {
    const question = this.questions[tab];
    return question && this.rows[tab] === question.options.length ? "custom" : undefined;
  }

  private syncFocus(): void {
    for (const editor of this.editors.values()) editor.focused = false;
    if (!this.collapsed && (this.mode === "custom" || this.mode === "notes"))
      this.editor(this.mode).focused = this.focus;
  }

  private editor(mode: EditMode): Editor {
    const key = `${this.tab}:${mode}`;
    const existing = this.editors.get(key);
    if (existing) return existing;
    const { tui, theme } = this.options;
    const tab = this.tab;
    const editor = new Editor(
      tui,
      {
        borderColor: (text) => theme.fg("accent", text),
        selectList: {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      },
      { paddingX: 0 },
    );
    editor.onChange = () => {
      // Multi-select custom text counts while typing; single-choice text counts once committed.
      if (mode === "custom" && this.questions[tab]?.multiSelect)
        this.drafts[tab]!.custom = editor.getExpandedText().trim();
    };
    editor.onSubmit = (text) => {
      const value = text.trim();
      const question = this.questions[tab];
      const draft = this.drafts[tab];
      // An empty single-choice custom answer is not a choice.
      if (mode === "custom" && !value && !question?.multiSelect) return;
      // Pi's Editor clears itself on submit. Keep saved text editable on return.
      editor.setText(value);
      if (mode === "notes") {
        if (draft) draft.notes = value;
        else this.globalNote = value;
      } else if (draft) {
        draft.custom = value;
        if (value && !question?.multiSelect) draft.selected.clear();
      }
      // Leaving a note returns to the custom editor if that row is focused.
      this.mode = mode === "notes" ? this.modeForRow(tab) : undefined;
      if (mode === "custom") {
        // If we are in multi select mode, we should not advance.
        if (!question?.multiSelect) this.advance();
      }

      this.syncFocus();
      this.followSelection = true;
      tui.requestRender();
    };
    this.editors.set(key, editor);
    return editor;
  }

  private switchTab(tab: number): void {
    const count = this.drafts.length + (this.drafts.length > 1 ? 1 : 0);
    this.tab = (tab + count) % count;
    this.mode = this.modeForRow(this.tab);
    this.warning = "";
    this.scroll.scrollToStart();
    this.followSelection = true;
    this.syncFocus();
  }

  /** Moves to the next tab, or submits directly when there is only one question. */
  private advance(): void {
    if (this.drafts.length > 1) {
      this.switchTab(this.tab + 1);
      return;
    }
    const result = collectAnswers(this.options.params, this.drafts, this.globalNote);
    if (result.answers.length) this.finish(result);
    else this.warning = "Choose an option, write an answer, or add a note.";
  }

  private moveRow(delta: number): void {
    if (this.isReview) this.reviewRow = (this.reviewRow + delta + 2) % 2;
    else {
      const question = this.questions[this.tab]!;
      // Options, `Type something.`, and a Next or Submit row when needed.
      const count =
        question.options.length + (question.multiSelect || this.questions.length === 1 ? 2 : 1);
      this.rows[this.tab] = (this.rows[this.tab]! + delta + count) % count;
      this.mode = this.modeForRow(this.tab);
      this.syncFocus();
    }
    this.followSelection = true;
  }

  private finish(result: QuestionResult): void {
    if (this.closed) return;
    this.closed = true;
    this.options.done(result);
  }

  abort(): void {
    this.finish(cancelledResult("aborted"));
  }

  private choose(): void {
    if (this.isReview) {
      if (this.reviewRow === 1) {
        this.finish(cancelledResult());
        return;
      }
      const result = collectAnswers(this.options.params, this.drafts, this.globalNote);
      if (!result.answers.length && !result.globalNote) {
        this.warning = "Provide an answer or a note before submitting.";
        this.followSelection = true;
        return;
      }
      this.finish(result);
      return;
    }
    const question = this.questions[this.tab]!;
    const row = this.rows[this.tab]!;
    const draft = this.drafts[this.tab]!;
    if (row === question.options.length) {
      this.mode = "custom";
      this.scroll.scrollToStart();
      this.syncFocus();
    } else if (row > question.options.length) {
      // The Next or Submit row.
      this.advance();
    } else if (question.multiSelect) {
      if (draft.selected.has(row)) draft.selected.delete(row);
      else draft.selected.add(row);
    } else {
      draft.selected.clear();
      draft.selected.add(row);
      draft.custom = "";
      this.advance();
    }
    this.followSelection = true;
  }

  private preview(): string | undefined {
    return this.questions[this.tab]?.options[this.rows[this.tab] ?? 0]?.preview;
  }

  private wrap(
    text: string,
    width: number,
    color: "text" | "muted" | "accent" | "warning" = "text",
  ): string[] {
    return wrapTextWithAnsi(this.options.theme.fg(color, stripTerminalSequences(text)), width);
  }

  private previewLines(text: string, width: number): string[] {
    let component = this.markdown.get(text);
    if (!component) {
      component = new Markdown(stripTerminalSequences(text), 0, 0, getMarkdownTheme());
      this.markdown.set(text, component);
    }
    return component.render(width);
  }

  private get answeredCount(): number {
    return this.drafts.filter((draft) => draft.selected.size > 0 || draft.custom.trim()).length;
  }

  /** Keep selection backgrounds inside the content pane, including wrapped lines. */
  private highlight(text: string, width: number, active: boolean): string {
    if (!active) return text;
    const fitted = truncateToWidth(text, width, "");
    return this.options.theme.bg(
      "selectedBg",
      fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted))),
    );
  }

  private questionBody(width: number): string[] {
    const question = this.questions[this.tab]!;
    const draft = this.drafts[this.tab]!;
    const preview = this.preview();
    const sideBySide = Boolean(preview && width >= 96);
    const leftWidth = sideBySide ? Math.floor(width * 0.45) : width;
    const lines: string[] = [];
    const current = this.rows[this.tab]!;
    const add = (index: number, label: string, description?: string) => {
      const active = index === current;
      if (active) this.selectedLine = lines.length;
      const title = this.wrap(
        `${active ? "›" : " "} ${label}`,
        leftWidth,
        active ? "accent" : "text",
      );
      lines.push(
        ...title.map((line) =>
          this.highlight(active ? this.options.theme.bold(line) : line, leftWidth, active),
        ),
      );
      if (description) {
        const indent = Math.min(7, Math.max(0, leftWidth - 1));
        lines.push(
          ...this.wrap(description, leftWidth - indent, "muted").map((line) =>
            this.highlight(" ".repeat(indent) + line, leftWidth, active),
          ),
        );
      }
      lines.push("");
    };
    question.options.forEach((option, index) => {
      const checked = draft.selected.has(index);
      const marker = question.multiSelect ? (checked ? "■" : "□") : checked ? "●" : "○";
      add(index, `${marker} ${index + 1}  ${option.label}`, option.description);
    });
    // Uncommitted editor text wins over the committed custom answer.
    const customText =
      this.editors.get(`${this.tab}:custom`)?.getExpandedText().trim() || draft.custom;
    add(
      question.options.length,
      `${question.multiSelect ? (customText ? "■ " : "□ ") : "✎ "}Type something.`,
      this.mode === "custom" ? undefined : customText || "Write your own answer.",
    );
    if (this.mode === "custom") lines.push(...this.editor("custom").render(width), "");
    if (this.questions.length === 1 && !question.multiSelect)
      add(
        question.options.length + 1,
        "Submit",
        "Submit an answer or a note. Notes alone leave this question undecided.",
      );
    else if (question.multiSelect)
      add(question.options.length + 1, "Next", "Keep these choices and move to the next tab.");
    if (draft.notes) lines.push(...this.wrap(`✎ Note: ${draft.notes}`, leftWidth, "muted"));
    if (this.warning) lines.push(...this.wrap(`! ${this.warning}`, leftWidth, "warning"));
    if (!preview) return lines;
    const previewWidth = sideBySide ? width - leftWidth - 3 : width;
    const rendered = this.previewLines(preview, previewWidth);
    const pane = [
      this.options.theme.fg("accent", "Preview"),
      ...this.wrap(question.options[current]!.label, previewWidth, "muted"),
      this.options.theme.fg("borderMuted", "─".repeat(previewWidth)),
      ...rendered.slice(0, 10),
    ];
    if (rendered.length > 10) pane.push(this.options.theme.fg("dim", "… press p to read more"));
    if (!sideBySide) return [...lines, "", ...pane];
    return Array.from({ length: Math.max(lines.length, pane.length) }, (_unused, index) => {
      const left = truncateToWidth(lines[index] ?? "", leftWidth, "");
      return (
        left +
        " ".repeat(Math.max(0, leftWidth - visibleWidth(left))) +
        this.options.theme.fg("borderAccent", " │ ") +
        (pane[index] ?? "")
      );
    });
  }

  private reviewBody(width: number): string[] {
    const result = collectAnswers(this.options.params, this.drafts, this.globalNote);
    const lines = [
      this.options.theme.bold(this.options.theme.fg("accent", "Review your answers")),
      ...this.wrap(
        "Tab to revisit a question. Unanswered questions stay undecided.",
        width,
        "muted",
      ),
      "",
    ];
    this.questions.forEach((question, index) => {
      const answer = result.answers.find((candidate) => candidate.questionIndex === index);
      const answered = !result.unanswered?.includes(index);
      lines.push(
        ...this.wrap(
          `${answered ? "✓" : "○"} ${index + 1}. ${question.header}`,
          width,
          answered ? "accent" : "warning",
        ),
        ...this.wrap(question.question, width, "muted"),
        ...this.wrap(`  ${answer ? answerText(answer) : "Not answered"}`, width),
      );
      if (answer?.notes) lines.push(...this.wrap(`  ✎ ${answer.notes}`, width, "muted"));
      lines.push("");
    });
    if (this.globalNote)
      lines.push("", ...this.wrap(`Global note: ${this.globalNote}`, width, "muted"));
    if (result.unanswered?.length)
      lines.push(
        "",
        ...this.wrap(
          `Unanswered: ${result.unanswered.map((index) => this.questions[index]!.header).join(", ")}. Submitting leaves these undecided.`,
          width,
          "warning",
        ),
      );
    if (this.warning) lines.push("", ...this.wrap(this.warning, width, "warning"));
    lines.push("");
    ["Submit answers", "Cancel questionnaire"].forEach((label, index) => {
      const active = index === this.reviewRow;
      if (active) this.selectedLine = lines.length;
      lines.push(
        ...this.wrap(`${active ? "›" : " "} ${label}`, width, active ? "accent" : "muted").map(
          (line) => this.highlight(line, width, active),
        ),
      );
    });
    return lines;
  }

  private body(width: number): string[] {
    if (this.mode === "notes") {
      const title = this.isReview ? "Global note" : "Question note";
      return [this.options.theme.fg("accent", title), ...this.editor("notes").render(width)];
    }
    if (this.mode === "preview") return this.previewLines(this.preview() ?? "", width);
    if (this.mode === "question")
      return this.wrap(this.questions[this.tab]!.question, width, "accent");
    this.selectedLine = 0;
    return this.isReview ? this.reviewBody(width) : this.questionBody(width);
  }

  private renderNavigation(width: number): string[] {
    const { theme } = this.options;
    const titles = this.questions.map((question) => stripTerminalSequences(question.header));
    if (titles.length === 1) return [theme.fg("muted", truncateToWidth(titles[0]!, width, ""))];
    titles.push("Review");
    const titleWidths = titles.map(visibleWidth);
    const titleWidth = titleWidths.reduce((sum, size) => sum + size, 0);
    const gap =
      width >= titleWidth + 2 * (titles.length - 1) ? 2 : width >= titles.length * 2 - 1 ? 1 : 0;
    const available = width - gap * (titles.length - 1);
    const padding = titleWidth + titles.length * 2 <= available ? 2 : 0;
    const sizes = titleWidths.map((size) => size + padding);
    let used = sizes.reduce((sum, size) => sum + size, 0);
    // Short tabs keep their space; only the widest titles shrink when necessary.
    while (used > available) {
      const widest = sizes.indexOf(Math.max(...sizes));
      sizes[widest]!--;
      used--;
    }
    const spare = available - used;
    const extra = Math.floor(spare / titles.length);
    const remainder = spare % titles.length;
    // Mouse coordinates include the frame's two-column left inset.
    let column = 2;
    const cells = titles.map((title, index) => {
      const size = sizes[index]! + extra + (index < remainder ? 1 : 0);
      this.headerTargets.push({ tab: index, start: column, end: column + size });
      column += size + gap;
      const compact = index === this.questions.length ? "R" : String(index + 1);
      const label =
        titleWidths[index]! <= size
          ? title
          : size < 4
            ? compact
            : truncateToWidth(title, size, "…");
      const padding = size - visibleWidth(label);
      const centered =
        " ".repeat(Math.floor(padding / 2)) + label + " ".repeat(Math.ceil(padding / 2));
      const active = index === this.tab;
      return {
        title: active ? theme.bold(theme.fg("accent", centered)) : theme.fg("muted", centered),
        rail: theme.fg(active ? "accent" : "borderMuted", (active ? "━" : "─").repeat(size)),
      };
    });
    return [
      cells.map((cell) => cell.title).join(" ".repeat(gap)),
      cells.map((cell) => cell.rail).join(theme.fg("borderMuted", "─".repeat(gap))),
    ];
  }

  private renderHelp(width: number): string {
    const { theme } = this.options;
    let hints: [string, string][];
    if (this.mode === "custom" || this.mode === "notes")
      hints = [
        ["Enter", "save"],
        ["Esc", this.mode === "notes" ? "save note" : "cancel"],
        ["Shift+Enter", "newline"],
        ["Ctrl+]", "collapse"],
      ];
    else if (this.mode === "preview" || this.mode === "question")
      hints = [
        ["↑↓", "scroll"],
        ["Esc", "back"],
        ["Home/End", "jump"],
        ["Ctrl+]", "collapse"],
      ];
    else {
      const question = this.questions[this.tab];
      const onAction = question && this.rows[this.tab]! > question.options.length;
      let confirm = "choose";
      if (this.isReview) confirm = this.reviewRow === 0 ? "submit" : "cancel";
      else if (onAction) confirm = this.questions.length === 1 ? "submit" : "next";
      else if (question?.multiSelect) confirm = "toggle";
      hints = [
        ["Enter", confirm],
        ["↑↓", "move"],
        ["Esc", "cancel"],
      ];
      if (this.drafts.length > 1) hints.push(["Tab", "next"]);
      if (this.isReview) hints.push(["Home/End", "scroll"]);
      if (this.preview()) hints.push(["p", "preview"]);
      hints.push(["n", "note"], ["Ctrl+]", "collapse"]);
      if (!this.isReview) hints.push(["q", "question"]);
    }
    let help = "";
    for (const [key, label] of hints) {
      const hint = theme.fg("accent", key) + theme.fg("dim", ` ${label}`);
      const candidate = help ? help + theme.fg("borderMuted", " · ") + hint : hint;
      if (visibleWidth(candidate) <= width) help = candidate;
    }
    return help || truncateToWidth(theme.fg("accent", "Esc"), width, "");
  }

  private border(width: number, left: string, right: string, top: boolean): string {
    const { theme } = this.options;
    const available = width - 4;
    const status = visibleWidth(right) <= Math.floor(available / 2) ? right : "";
    const title = truncateToWidth(left, available - visibleWidth(status), "");
    const gap = width - 2 - visibleWidth(title) - visibleWidth(status);
    return (
      theme.fg("borderAccent", top ? "╭─" : "╰─") +
      title +
      theme.fg("borderMuted", "─".repeat(Math.max(0, gap - 2))) +
      status +
      theme.fg("borderAccent", top ? "─╮" : "─╯")
    );
  }

  render(width: number): string[] {
    const { theme, tui } = this.options;
    this.headerTargets = [];
    this.mouseWidth = width;
    if (this.collapsed)
      return [
        theme.fg(
          "dim",
          truncateToWidth(
            `Questions · ${this.answeredCount}/${this.questions.length} answered · Ctrl+] expand · Esc cancel`,
            Math.max(0, width),
            "",
          ),
        ),
      ];
    // Cap the editor-slot height to leave room for the transcript.
    const height = Math.min(tui.terminal.rows, Math.max(12, Math.floor(tui.terminal.rows * 0.7)));
    if (width < 12 || height < 8)
      return [
        truncateToWidth("Resize to answer · Ctrl+] collapse · Esc cancel", Math.max(0, width), ""),
      ];
    const inner = width - 4;
    const navigation = this.renderNavigation(inner);
    const reading = this.mode === "preview" || this.mode === "question";
    let heading =
      !this.isReview && !reading
        ? this.wrap(this.questions[this.tab]!.question, inner, "text").map((line) =>
            theme.bold(line),
          )
        : [];
    const headingLimit = Math.min(3, height - navigation.length - 5);
    if (heading.length > headingLimit)
      heading = [
        ...heading.slice(0, headingLimit - 1),
        theme.fg("muted", truncateToWidth("… q to read full question", inner, "")),
      ];
    if (heading.length) heading.push("");
    // Borders and help take three rows. Short content leaves more transcript visible.
    const lines = this.scroll.render(inner);
    this.page = Math.min(
      height - 3 - navigation.length - heading.length,
      Math.max(1, lines.length),
    );
    this.scroll.updateLayout(lines.length, this.page, () => tui.requestRender());
    const editing = this.mode === "custom" || this.mode === "notes";
    const focusLine = editing
      ? lines.findIndex((line) => line.includes(CURSOR_MARKER))
      : this.selectedLine;
    if ((editing || this.followSelection) && !reading && focusLine >= 0) {
      if (focusLine < this.scroll.scrollTop) this.scroll.scrollTo(focusLine);
      else if (focusLine >= this.scroll.scrollTop + this.page)
        this.scroll.scrollTo(focusLine - this.page + 1);
    }
    this.followSelection = false;
    const visible = lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + this.page);
    while (visible.length < this.page) visible.push("");
    const row = (text: string) => {
      const fitted = truncateToWidth(text, inner, "");
      return (
        theme.fg("borderAccent", "│ ") +
        fitted +
        " ".repeat(Math.max(0, inner - visibleWidth(fitted))) +
        theme.fg("borderAccent", " │")
      );
    };
    const question = this.questions[this.tab];
    const context =
      this.mode === "notes"
        ? "Note · optional"
        : this.mode === "custom"
          ? "Custom answer"
          : this.mode === "preview"
            ? "Option preview"
            : this.mode === "question"
              ? "Full question"
              : this.isReview
                ? "Review before submitting"
                : question?.multiSelect
                  ? "Choose any that apply"
                  : "Choose one";
    const start = this.scroll.scrollTop;
    const end = Math.min(lines.length, start + this.page);
    const position =
      lines.length > this.page
        ? ` ${start > 0 ? "↑ " : ""}${start + 1}–${end} / ${lines.length}${end < lines.length ? " ↓" : ""} `
        : "";
    return [
      this.border(
        width,
        theme.fg("accent", theme.bold(" Ask questions ")),
        theme.fg("muted", ` ${this.answeredCount}/${this.questions.length} answered `),
        true,
      ),
      ...navigation.map(row),
      ...heading.map(row),
      ...visible.map(row),
      row(this.renderHelp(inner)),
      this.border(width, theme.fg("dim", ` ${context} `), theme.fg("muted", position), false),
    ];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (
      this.closed ||
      this.collapsed ||
      event.width !== this.mouseWidth ||
      event.button !== "left" ||
      event.shift ||
      event.alt ||
      event.ctrl ||
      (event.type !== "press" && event.type !== "click") ||
      (event.y !== 1 && event.y !== 2)
    )
      return undefined;
    const target = this.headerTargets.find(
      (header) => event.x >= header.start && event.x < header.end,
    );
    if (!target) return undefined;
    // Claim the press so Pi delivers a click instead of starting transcript selection.
    if (event.type === "press" || target.tab === this.tab) return { handled: true, focus: true };
    // Notes use the same save-on-leave behavior as Escape in their editor.
    if (this.mode === "notes") {
      const editor = this.editor("notes");
      editor.onSubmit?.(editor.getExpandedText());
    }
    this.switchTab(target.tab);
    this.options.tui.requestRender();
    return { handled: true, focus: true };
  }

  handleInput(data: string): void {
    if (this.closed || isKeyRelease(data)) return;
    const { keybindings, tui } = this.options;
    // Collapse must work in every mode without changing any answers or editor drafts.
    if (matchesKey(data, "ctrl+]")) {
      if (!isKeyRepeat(data)) {
        this.collapsed = !this.collapsed;
        this.syncFocus();
        this.followSelection = true;
        tui.requestRender();
      }
      return;
    }
    const keys: Keys = {
      cancel: keybindings.matches(data, "tui.select.cancel"),
      confirm:
        keybindings.matches(data, "tui.select.confirm") ||
        keybindings.matches(data, "tui.input.submit"),
      up: keybindings.matches(data, "tui.select.up"),
      down: keybindings.matches(data, "tui.select.down"),
      newLine: keybindings.matches(data, "tui.input.newLine"),
    };
    if (this.collapsed) {
      if (keys.cancel) this.finish(cancelledResult());
      return;
    }
    // These keys belong to Pi's transcript, not the questionnaire's body.
    if (
      keybindings.matches(data, "tui.select.pageUp") ||
      keybindings.matches(data, "tui.select.pageDown")
    )
      return;
    if (this.mode === "notes") this.handleNotesInput(data, keys);
    else if (this.mode === "custom") this.handleCustomInput(data, keys);
    else if (this.mode === "preview" || this.mode === "question") {
      if (keys.cancel) {
        this.mode = undefined;
        this.scroll.scrollToStart();
        this.followSelection = true;
      } else this.scrollInput(data);
    } else this.handleBrowseInput(data, keys);
    tui.requestRender();
  }

  /** Enter and Escape both save the note. */
  private handleNotesInput(data: string, keys: Keys): void {
    const editor = this.editor("notes");
    if (keys.cancel || (keys.confirm && !keys.newLine)) editor.onSubmit?.(editor.getExpandedText());
    else editor.handleInput(data);
  }

  private handleCustomInput(data: string, keys: Keys): void {
    const editor = this.editor("custom");
    if (keys.cancel) this.finish(cancelledResult());
    else if (keys.newLine) editor.handleInput(data);
    else if (keys.confirm && !isKeyRepeat(data)) editor.onSubmit?.(editor.getExpandedText());
    else if (matchesKey(data, "ctrl+u")) editor.setText("");
    // Up and Down leave the editor at its edges, keeping the draft.
    else if (keys.up && editor.getCursor().line === 0) this.moveRow(-1);
    else if (keys.down && editor.getCursor().line === editor.getLines().length - 1) this.moveRow(1);
    else editor.handleInput(data);
  }

  private handleBrowseInput(data: string, keys: Keys): void {
    const multiTab = this.drafts.length > 1;
    const question = this.questions[this.tab];
    if (keys.cancel) this.finish(cancelledResult());
    else if (multiTab && (matchesKey(data, "tab") || matchesKey(data, "right")))
      this.switchTab(this.tab + 1);
    else if (multiTab && (matchesKey(data, "shift+tab") || matchesKey(data, "left")))
      this.switchTab(this.tab - 1);
    else if (keys.up || keys.down) this.moveRow(keys.up ? -1 : 1);
    else if (keys.confirm && !isKeyRepeat(data)) this.choose();
    else if (
      matchesKey(data, "space") &&
      !isKeyRepeat(data) &&
      question?.multiSelect &&
      this.rows[this.tab]! < question.options.length
    )
      this.choose();
    else if (matchesKey(data, "n") && !isKeyRepeat(data)) {
      this.mode = "notes";
      this.scroll.scrollToStart();
      this.syncFocus();
    } else if (matchesKey(data, "q") && question) {
      this.mode = "question";
      this.scroll.scrollToStart();
    } else if (matchesKey(data, "p") && this.preview()) {
      this.mode = "preview";
      this.scroll.scrollToStart();
    } else if (/^[1-9]$/.test(data) && question) {
      const index = Number(data) - 1;
      if (index < question.options.length) {
        this.rows[this.tab] = index;
        this.choose();
      }
    } else if (matchesKey(data, "delete") && question) {
      const draft = this.drafts[this.tab]!;
      draft.selected.clear();
      draft.custom = "";
      this.editors.get(`${this.tab}:custom`)?.setText("");
    } else this.scrollInput(data);
  }

  private scrollInput(data: string): void {
    const { keybindings } = this.options;
    if (keybindings.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
    else if (keybindings.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
    else if (matchesKey(data, "home")) this.scroll.scrollToStart();
    else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
  }

  invalidate(): void {
    this.markdown.clear();
    for (const editor of this.editors.values()) editor.invalidate();
  }
}
