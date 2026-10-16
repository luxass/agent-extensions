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

  private questionBody(width: number): string[] {
    const question = this.questions[this.tab]!;
    const draft = this.drafts[this.tab]!;
    const preview = this.preview();
    const sideBySide = Boolean(preview && width >= 96);
    const leftWidth = sideBySide ? Math.floor(width * 0.45) : width;
    const lines: string[] = [];
    const current = this.rows[this.tab]!;
    const add = (index: number, label: string, description?: string) => {
      if (index === current) this.selectedLine = lines.length;
      lines.push(
        ...this.wrap(
          `${index === current ? ">" : " "} ${label}`,
          leftWidth,
          index === current ? "accent" : "text",
        ),
      );
      if (description) lines.push(...this.wrap(`    ${description}`, leftWidth, "muted"));
      lines.push("");
    };
    question.options.forEach((option, index) => {
      const checked = draft.selected.has(index);
      const marker = question.multiSelect ? (checked ? "[x]" : "[ ]") : checked ? "(x)" : "( )";
      add(index, `${marker} ${index + 1}. ${option.label}`, option.description);
    });
    // Uncommitted editor text wins over the committed custom answer.
    const customText =
      this.editors.get(`${this.tab}:custom`)?.getExpandedText().trim() || draft.custom;
    add(
      question.options.length,
      `${question.multiSelect ? (customText ? "[x] " : "[ ] ") : ""}Type something.`,
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
    if (draft.notes) lines.push(...this.wrap(`Note: ${draft.notes}`, leftWidth, "muted"));
    if (this.warning) lines.push(...this.wrap(this.warning, leftWidth, "warning"));
    if (!preview) return lines;
    const previewWidth = sideBySide ? width - leftWidth - 3 : width;
    const rendered = this.previewLines(preview, previewWidth);
    const pane = [
      this.options.theme.fg("muted", "Preview · p opens full view"),
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
    const lines = [...this.wrap("Review your answers", width, "accent"), ""];
    this.questions.forEach((question, index) => {
      const answer = result.answers.find((candidate) => candidate.questionIndex === index);
      lines.push(
        ...this.wrap(
          `${index + 1}. ${question.header}: ${answer ? answerText(answer) : "Not answered"}`,
          width,
        ),
      );
      if (answer?.notes) lines.push(...this.wrap(`   Note: ${answer.notes}`, width, "muted"));
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
    this.selectedLine = lines.length + this.reviewRow;
    lines.push(
      ...["Submit answers", "Cancel questionnaire"].map((label, index) =>
        this.options.theme.fg(
          index === this.reviewRow ? "accent" : "text",
          `${index === this.reviewRow ? ">" : " "} ${label}`,
        ),
      ),
    );
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

  private renderTabs(width: number): string {
    const { theme } = this.options;
    const titles = this.questions.map((question, index) => {
      const draft = this.drafts[index]!;
      const label = `${index + 1}. ${question.header}${draft.selected.size || draft.custom ? " ✓" : ""}`;
      return index === this.tab
        ? theme.fg("accent", `[${stripTerminalSequences(label)}]`)
        : theme.fg("muted", stripTerminalSequences(label));
    });
    if (this.drafts.length > 1)
      titles.push(this.isReview ? theme.fg("accent", "[Review]") : theme.fg("muted", "Review"));
    const tabs = titles.join(" · ");
    if (visibleWidth(tabs) <= width) return tabs;
    // Too narrow for every title: show the position and the current title only.
    return theme.fg(
      "accent",
      `${this.tab + 1}/${titles.length} · ${stripTerminalSequences(this.questions[this.tab]?.header ?? "Review")}`,
    );
  }

  private renderHelp(width: number): string {
    if (this.mode === "custom" || this.mode === "notes")
      return `Enter save · Shift+Enter newline · Ctrl+] collapse · Esc ${this.mode === "notes" ? "save note" : "cancel"}`;
    if (this.mode === "preview" || this.mode === "question")
      return `↑↓ scroll ${this.mode} · Ctrl+] collapse · Esc back`;
    if (width < 70) return "q question · Enter choose · Ctrl+] collapse · Esc cancel";
    return `${this.drafts.length > 1 ? "Tab tabs · " : ""}↑↓ move · Enter choose · q question · n note · p preview · Ctrl+] collapse · Esc cancel`;
  }

  render(width: number): string[] {
    const { theme, tui } = this.options;
    if (this.collapsed)
      return [
        theme.fg(
          "dim",
          truncateToWidth(
            "Questions collapsed · Ctrl+] expand · Esc cancel",
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
    const reading = this.mode === "preview" || this.mode === "question";
    let heading =
      !this.isReview && !reading
        ? this.wrap(this.questions[this.tab]!.question, inner, "accent")
        : [];
    const headingLimit = Math.min(3, height - 6);
    if (heading.length > headingLimit)
      heading = [
        ...heading.slice(0, headingLimit - 1),
        theme.fg("muted", truncateToWidth("… q to read full question", inner, "")),
      ];
    // Borders, tabs, and help take four rows.
    this.page = height - 4 - heading.length;
    const lines = this.scroll.render(inner);
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
    return [
      theme.fg("borderAccent", `┌${"─".repeat(width - 2)}┐`),
      row(this.renderTabs(inner)),
      ...heading.map(row),
      ...visible.map(row),
      row(theme.fg("dim", this.renderHelp(width))),
      theme.fg("borderAccent", `└${"─".repeat(width - 2)}┘`),
    ];
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
