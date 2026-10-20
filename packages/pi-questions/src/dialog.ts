import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  CURSOR_MARKER,
  Editor,
  HStack,
  isKeyRelease,
  isKeyRepeat,
  Markdown,
  matchesKey,
  MouseRegion,
  Spacer,
  Text,
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
  type Question,
  type QuestionResult,
  type Questions,
} from "./questions.ts";
import { Viewport } from "./viewport.ts";

interface DialogOptions {
  params: Questions;
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  done: (result: QuestionResult) => void;
}

type Mode = "custom" | "notes" | "preview" | "question" | undefined;

/** One question's tab. Its editors hold the custom answer and the note. */
interface Tab {
  question: Question;
  selected: Set<number>;
  /** Options, then `Type something.`, then Next or Submit. */
  row: number;
  custom: Editor;
  notes: Editor;
}

interface Keys {
  cancel: boolean;
  confirm: boolean;
  up: boolean;
  down: boolean;
  newLine: boolean;
}

interface ButtonOptions {
  theme: Theme;
  label: string;
  description?: string;
  active: boolean;
  onActivate: () => void;
}

/** The width of tab cells separated by one column. */
const span = (sizes: number[]) => sizes.reduce((sum, size) => sum + size + 1, -1);

/** A whole-row button. Keyboard selection remains owned by the containing dialog. */
class Button extends MouseRegion {
  constructor({ theme, label, description, active, onActivate }: ButtonOptions) {
    super(
      {
        render(width) {
          const content = new Box(
            0,
            0,
            active ? (text) => theme.bg("selectedBg", text) : undefined,
          );
          const title = `${active ? "›" : " "} ${label}`;
          const styled = theme.fg(active ? "accent" : "text", title);
          content.addChild(new Text(active ? theme.bold(styled) : styled, 0, 0));
          if (description) {
            const indent = Math.min(7, Math.max(0, width - 1));
            content.addChild({
              render: () =>
                wrapTextWithAnsi(theme.fg("muted", description), width - indent).map(
                  (line) => " ".repeat(indent) + line,
                ),
              invalidate() {},
            });
          }
          return content.render(width);
        },
        invalidate() {},
      },
      (event) => {
        if (
          event.button !== "left" ||
          event.shift ||
          event.alt ||
          event.ctrl ||
          (event.type !== "press" && event.type !== "click") ||
          event.x < 0 ||
          event.x >= event.width ||
          event.y < 0 ||
          event.y >= event.height
        )
          return undefined;
        // Activating on press can reflow the choices before the click arrives.
        if (event.type === "click") onActivate();
        return { handled: true, focus: true };
      },
    );
  }
}

export class QuestionDialog implements Component, Focusable {
  private readonly options: DialogOptions;
  private readonly tabs: Tab[];
  private readonly globalNote: Editor;
  private readonly markdown = new Map<string, Markdown>();
  private readonly content = new Container();
  private readonly scroll: Viewport;
  private tab = 0;
  private mode: Mode;
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
  private bodyTop = 0;
  private bodyHeight = 0;

  constructor(options: DialogOptions) {
    this.options = options;
    this.tabs = options.params.questions.map((question) => {
      const tab: Tab = {
        question,
        selected: new Set(),
        row: 0,
        custom: this.newEditor(),
        notes: this.newEditor(),
      };
      // Single-choice custom text replaces the chosen option.
      if (!question.multiSelect)
        tab.custom.onChange = (text) => {
          if (text.trim()) tab.selected.clear();
        };
      return tab;
    });
    this.globalNote = this.newEditor();
    this.scroll = new Viewport(this.content, () => options.tui.requestRender());
  }

  get focused(): boolean {
    return this.focus;
  }
  set focused(value: boolean) {
    this.focus = value;
    this.syncFocus();
  }

  /** Undefined on the Review tab, which follows the question tabs when there are several. */
  private get current(): Tab | undefined {
    return this.tabs[this.tab];
  }

  private get isReview(): boolean {
    return this.tab === this.tabs.length;
  }

  /** Focusing the `Type something.` row, which follows the options, opens its editor. */
  private modeForRow(): Mode {
    const tab = this.current;
    return tab && tab.row === tab.question.options.length ? "custom" : undefined;
  }

  private activeEditor(): Editor | undefined {
    if (this.mode === "notes") return this.current?.notes ?? this.globalNote;
    if (this.mode === "custom") return this.current?.custom;
    return undefined;
  }

  private syncFocus(): void {
    this.globalNote.focused = false;
    for (const tab of this.tabs) tab.custom.focused = tab.notes.focused = false;
    const editor = this.activeEditor();
    if (editor && !this.collapsed) editor.focused = this.focus;
  }

  private newEditor(): Editor {
    const { tui, theme } = this.options;
    return new Editor(
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
  }

  private collect(): QuestionResult {
    return collectAnswers(
      this.options.params,
      this.tabs.map((tab) => ({
        selected: tab.selected,
        custom: tab.custom.getExpandedText(),
        notes: tab.notes.getExpandedText(),
      })),
      this.globalNote.getExpandedText(),
    );
  }

  private switchTab(tab: number): void {
    const count = this.tabs.length + (this.tabs.length > 1 ? 1 : 0);
    this.tab = (tab + count) % count;
    this.mode = this.modeForRow();
    this.warning = "";
    this.scroll.scrollToStart();
    this.followSelection = true;
    this.syncFocus();
  }

  /** Moves to the next tab, or submits directly when there is only one question. */
  private advance(): void {
    if (this.tabs.length > 1) {
      this.switchTab(this.tab + 1);
      return;
    }
    const result = this.collect();
    if (result.answers.length) this.finish(result);
    else this.warning = "Choose an option, write an answer, or add a note.";
  }

  private moveRow(delta: number): void {
    if (this.isReview) this.reviewRow = (this.reviewRow + delta + 2) % 2;
    else {
      const tab = this.current!;
      const count = tab.question.options.length + 2;
      tab.row = (tab.row + delta + count) % count;
      this.mode = this.modeForRow();
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
      const result = this.collect();
      if (!result.answers.length && !result.globalNote) {
        this.warning = "Provide an answer or a note before submitting.";
        this.followSelection = true;
        return;
      }
      this.finish(result);
      return;
    }
    const tab = this.current!;
    const { question, row } = tab;
    if (row === question.options.length) {
      this.mode = "custom";
      this.scroll.scrollToStart();
      this.syncFocus();
    } else if (row > question.options.length) {
      // The Next or Submit row.
      this.advance();
    } else if (question.multiSelect) {
      if (tab.selected.has(row)) tab.selected.delete(row);
      else tab.selected.add(row);
    } else {
      tab.selected.clear();
      tab.selected.add(row);
      tab.custom.setText("");
      this.advance();
    }
    this.followSelection = true;
  }

  /** Enter saves the custom answer. A single-choice answer also moves on. */
  private submitCustom(): void {
    const { question, custom } = this.current!;
    // An empty single-choice custom answer is not a choice.
    if (!question.multiSelect && !custom.getExpandedText().trim()) return;
    this.mode = undefined;
    if (!question.multiSelect) this.advance();
    this.syncFocus();
    this.followSelection = true;
  }

  /** Enter and Escape both keep the note. */
  private closeNote(): void {
    // Leaving a note returns to the custom editor if that row is focused.
    this.mode = this.modeForRow();
    this.syncFocus();
    this.followSelection = true;
  }

  private activateRow(row: number): void {
    if (this.isReview) this.reviewRow = row;
    else this.current!.row = row;
    this.mode = undefined;
    this.choose();
    this.syncFocus();
  }

  private preview(): string | undefined {
    const tab = this.current;
    return tab?.question.options[tab.row]?.preview;
  }

  private wrap(
    text: string,
    width: number,
    color: "text" | "muted" | "accent" | "warning" = "text",
  ): string[] {
    return wrapTextWithAnsi(this.options.theme.fg(color, text), width);
  }

  private previewComponent(text: string): Markdown {
    let component = this.markdown.get(text);
    if (!component) {
      component = new Markdown(text, 0, 0, getMarkdownTheme());
      this.markdown.set(text, component);
    }
    return component;
  }

  private get answeredCount(): number {
    return this.tabs.filter((tab) => tab.selected.size > 0 || tab.custom.getExpandedText().trim())
      .length;
  }

  private questionBody(width: number): Component {
    const { theme } = this.options;
    const tab = this.current!;
    const { question } = tab;
    const preview = this.preview();
    const sideBySide = Boolean(preview && width >= 96);
    const leftWidth = sideBySide ? Math.floor(width * 0.45) : width;
    const choices = new Container();
    const add = (index: number, label: string, description?: string) => {
      const active = index === tab.row;
      // This measurement is only for keyboard scrolling. Containers route mouse events.
      if (active) this.selectedLine = choices.render(leftWidth).length;
      choices.addChild(
        new Button({
          theme,
          label,
          description,
          active,
          onActivate: () => this.activateRow(index),
        }),
      );
      choices.addChild(new Spacer(1));
    };
    question.options.forEach((option, index) => {
      const checked = tab.selected.has(index);
      const marker = question.multiSelect ? (checked ? "■" : "□") : checked ? "●" : "○";
      add(index, `${marker} ${index + 1}  ${option.label}`, option.description);
    });
    const customText = tab.custom.getExpandedText().trim();
    add(
      question.options.length,
      `${question.multiSelect ? (customText ? "■ " : "□ ") : "✎ "}Type something.`,
      this.mode === "custom" ? undefined : customText || "Write your own answer.",
    );
    if (this.mode === "custom") {
      choices.addChild(tab.custom);
      choices.addChild(new Spacer(1));
    }
    if (this.tabs.length === 1)
      add(
        question.options.length + 1,
        "Submit",
        "Submit an answer or a note. Notes alone leave this question undecided.",
      );
    else add(question.options.length + 1, "Next", "Keep this answer and move to the next tab.");
    const notes = tab.notes.getExpandedText().trim();
    if (notes)
      choices.addChild(
        new Text(this.wrap(`✎ Note: ${notes}`, leftWidth, "muted").join("\n"), 0, 0),
      );
    if (this.warning)
      choices.addChild(
        new Text(this.wrap(`! ${this.warning}`, leftWidth, "warning").join("\n"), 0, 0),
      );
    if (!preview) return choices;
    const pane: Component = {
      render: (paneWidth) => {
        const rendered = this.previewComponent(preview).render(paneWidth);
        const lines = [
          theme.fg("accent", "Preview"),
          ...this.wrap(question.options[tab.row]!.label, paneWidth, "muted"),
          theme.fg("borderMuted", "─".repeat(paneWidth)),
          ...rendered.slice(0, 10),
        ];
        if (rendered.length > 10) lines.push(theme.fg("dim", "… press p to read more"));
        return lines;
      },
      invalidate() {},
    };
    if (!sideBySide) {
      const layout = new Container();
      layout.addChild(choices);
      layout.addChild(new Spacer(1));
      layout.addChild(pane);
      return layout;
    }
    const previewWidth = width - leftWidth - 3;
    const divider: Component = {
      render: () =>
        Array.from(
          { length: Math.max(choices.render(leftWidth).length, pane.render(previewWidth).length) },
          () => theme.fg("borderAccent", " │ "),
        ),
      invalidate() {},
    };
    const layout = new HStack([
      { component: choices, basis: leftWidth, shrink: 0 },
      { component: divider, basis: 3, shrink: 0 },
      { component: pane, basis: previewWidth, shrink: 0 },
    ]);
    return {
      render: (available) => layout.render(available),
      // HStack's standalone handler uses vertical Container routing. Only the
      // choices pane is interactive here, so forward it with its actual width.
      handleMouse: (event) =>
        event.x >= 0 && event.x < leftWidth
          ? choices.handleMouse({ ...event, width: leftWidth })
          : undefined,
      invalidate: () => layout.invalidate(),
    };
  }

  private reviewBody(width: number): Component {
    const result = this.collect();
    const lines = [
      this.options.theme.bold(this.options.theme.fg("accent", "Review your answers")),
      ...this.wrap(
        "Tab to revisit a question. Unanswered questions stay undecided.",
        width,
        "muted",
      ),
      "",
    ];
    this.tabs.forEach(({ question }, index) => {
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
    if (result.globalNote)
      lines.push("", ...this.wrap(`Global note: ${result.globalNote}`, width, "muted"));
    if (result.unanswered?.length)
      lines.push(
        "",
        ...this.wrap(
          `Unanswered: ${result.unanswered.map((index) => this.tabs[index]!.question.header).join(", ")}. Submitting leaves these undecided.`,
          width,
          "warning",
        ),
      );
    if (this.warning) lines.push("", ...this.wrap(this.warning, width, "warning"));
    lines.push("");
    const content = new Container();
    content.addChild(new Text(lines.join("\n"), 0, 0));
    ["Submit answers", "Cancel questionnaire"].forEach((label, index) => {
      const active = index === this.reviewRow;
      if (active) this.selectedLine = content.render(width).length;
      content.addChild(
        new Button({
          theme: this.options.theme,
          label,
          active,
          onActivate: () => this.activateRow(index),
        }),
      );
    });
    return content;
  }

  private body(width: number): Component {
    if (this.mode === "notes") {
      const title = this.isReview ? "Global note" : "Question note";
      const content = new Container();
      content.addChild(new Text(this.options.theme.fg("accent", title), 0, 0));
      content.addChild(this.activeEditor()!);
      return content;
    }
    if (this.mode === "preview") return this.previewComponent(this.preview() ?? "");
    if (this.mode === "question")
      return new Text(this.wrap(this.current!.question.question, width, "accent").join("\n"), 0, 0);
    this.selectedLine = 0;
    return this.isReview ? this.reviewBody(width) : this.questionBody(width);
  }

  private renderNavigation(width: number): string[] {
    const { theme } = this.options;
    const titles = this.tabs.map((tab) => tab.question.header);
    if (titles.length === 1) return [theme.fg("muted", truncateToWidth(titles[0]!, width, ""))];
    titles.push("Review");
    // Tabs keep their natural width when they fit. Otherwise they share the width equally.
    let sizes = titles.map((title) => visibleWidth(title) + 2);
    if (span(sizes) > width) {
      const size = Math.max(1, Math.floor((width - titles.length + 1) / titles.length));
      sizes = titles.map(() => size);
    }
    // Mouse coordinates include the frame's two-column left inset.
    let column = 2;
    const cells = titles.map((title, index) => {
      const size = sizes[index]!;
      this.headerTargets.push({ tab: index, start: column, end: column + size });
      column += size + 1;
      const label = truncateToWidth(title, size, "…");
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
      cells.map((cell) => cell.title).join(" "),
      cells.map((cell) => cell.rail).join(theme.fg("borderMuted", "─")) +
        theme.fg("borderMuted", "─".repeat(Math.max(0, width - span(sizes)))),
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
      const tab = this.current;
      let confirm = "choose";
      if (this.isReview) confirm = this.reviewRow === 0 ? "submit" : "cancel";
      else if (tab && tab.row > tab.question.options.length)
        confirm = this.tabs.length === 1 ? "submit" : "next";
      else if (tab?.question.multiSelect) confirm = "toggle";
      hints = [
        ["Enter", confirm],
        ["↑↓", "move"],
        ["Esc", "cancel"],
      ];
      if (this.tabs.length > 1) hints.push(["Tab", "next"]);
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
    this.bodyHeight = 0;
    if (this.collapsed)
      return [
        theme.fg(
          "dim",
          truncateToWidth(
            `Questions · ${this.answeredCount}/${this.tabs.length} answered · Ctrl+] expand · Esc cancel`,
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
        ? this.wrap(this.current!.question.question, inner, "text").map((line) => theme.bold(line))
        : [];
    const headingLimit = Math.min(3, height - navigation.length - 5);
    if (heading.length > headingLimit)
      heading = [
        ...heading.slice(0, headingLimit - 1),
        theme.fg("muted", truncateToWidth("… q to read full question", inner, "")),
      ];
    if (heading.length) heading.push("");
    // Keep the component tree intact so containers can route clicks to buttons.
    this.content.clear();
    this.content.addChild(this.body(inner));
    // Borders and help take three rows. Short content leaves more transcript visible.
    this.scroll.maxHeight = height - 3 - navigation.length - heading.length;
    const editing = this.mode === "custom" || this.mode === "notes";
    const following = editing || this.followSelection;
    this.scroll.followLine = (lines) =>
      following && !reading
        ? editing
          ? lines.findIndex((line) => line.includes(CURSOR_MARKER))
          : this.selectedLine
        : undefined;
    const visible = this.scroll.render(inner);
    this.page = this.scroll.viewportHeight;
    this.bodyTop = 1 + navigation.length + heading.length;
    this.bodyHeight = visible.length;
    this.followSelection = false;
    const totalLines = this.scroll.totalLines;
    const row = (text: string) => {
      const fitted = truncateToWidth(text, inner, "");
      return (
        theme.fg("borderAccent", "│ ") +
        fitted +
        " ".repeat(Math.max(0, inner - visibleWidth(fitted))) +
        theme.fg("borderAccent", " │")
      );
    };
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
                : this.current?.question.multiSelect
                  ? "Choose any that apply"
                  : "Choose one";
    const start = this.scroll.scrollTop;
    const end = Math.min(totalLines, start + this.page);
    const position =
      totalLines > this.page
        ? ` ${start > 0 ? "↑ " : ""}${start + 1}–${end} / ${totalLines}${end < totalLines ? " ↓" : ""} `
        : "";
    return [
      this.border(
        width,
        theme.fg("accent", theme.bold(" Ask questions ")),
        theme.fg("muted", ` ${this.answeredCount}/${this.tabs.length} answered `),
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
      (event.type !== "press" && event.type !== "click")
    )
      return undefined;
    const header =
      event.y === 1 || event.y === 2
        ? this.headerTargets.find((target) => event.x >= target.start && event.x < target.end)
        : undefined;
    if (header) {
      if (event.type === "press" || header.tab === this.tab) return { handled: true, focus: true };
      this.switchTab(header.tab);
    } else {
      if (
        event.x < 2 ||
        event.x >= event.width - 2 ||
        event.y < this.bodyTop ||
        event.y >= this.bodyTop + this.bodyHeight
      )
        return undefined;
      const result = this.scroll.handleMouse({
        ...event,
        x: event.x - 2,
        y: event.y - this.bodyTop,
        width: event.width - 4,
        height: this.bodyHeight,
      });
      if (!result) return undefined;
    }
    this.options.tui.requestRender();
    // Keep focus and the press/click gesture on the dialog, not a button from a
    // previous render. Do not reclaim focus after submission restores Pi's editor.
    return { handled: true, focus: !this.closed };
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

  private handleNotesInput(data: string, keys: Keys): void {
    if (keys.cancel || (keys.confirm && !keys.newLine)) this.closeNote();
    else this.activeEditor()!.handleInput(data);
  }

  private handleCustomInput(data: string, keys: Keys): void {
    const editor = this.current!.custom;
    if (keys.cancel) this.finish(cancelledResult());
    else if (keys.newLine) editor.handleInput(data);
    else if (keys.confirm && !isKeyRepeat(data)) this.submitCustom();
    else if (matchesKey(data, "ctrl+u")) editor.setText("");
    // Up and Down leave the editor at its edges, keeping the draft.
    else if (keys.up && editor.getCursor().line === 0) this.moveRow(-1);
    else if (keys.down && editor.getCursor().line === editor.getLines().length - 1) this.moveRow(1);
    else editor.handleInput(data);
  }

  private handleBrowseInput(data: string, keys: Keys): void {
    const multiTab = this.tabs.length > 1;
    const tab = this.current;
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
      tab?.question.multiSelect &&
      tab.row < tab.question.options.length
    )
      this.choose();
    else if (matchesKey(data, "n") && !isKeyRepeat(data)) {
      this.mode = "notes";
      this.scroll.scrollToStart();
      this.syncFocus();
    } else if (matchesKey(data, "q") && tab) {
      this.mode = "question";
      this.scroll.scrollToStart();
    } else if (matchesKey(data, "p") && this.preview()) {
      this.mode = "preview";
      this.scroll.scrollToStart();
    } else if (/^[1-9]$/.test(data) && tab) {
      const index = Number(data) - 1;
      if (index < tab.question.options.length) {
        tab.row = index;
        this.choose();
      }
    } else if (matchesKey(data, "delete") && tab) {
      tab.selected.clear();
      tab.custom.setText("");
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
    this.globalNote.invalidate();
    for (const tab of this.tabs) {
      tab.custom.invalidate();
      tab.notes.invalidate();
    }
  }
}
