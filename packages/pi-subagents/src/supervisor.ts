import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  ScrollView,
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { ConversationPane, PreviewPane } from "./conversation.ts";
import { rebuildTree, renderPanel } from "./panel.ts";
import { animationClock } from "./render.ts";
import type { AgentService } from "./tools.ts";
import { isSettled, type AgentView } from "./transcript.ts";

type Mode = "preview" | "conversation" | "details";

export type Filter = "all" | "active" | "finished";

export type Exit = "close" | "definitions" | "settings";

type Composer = { action: "steer" | "resume" | "restart"; target: AgentView };

export type TreeRow = { view: AgentView; indent: number };

export class Supervisor implements Component, Focusable {
  fullscreen = false;
  selectedId?: string;
  views: readonly AgentView[] = [];
  tree: TreeRow[] = [];
  filter: Filter = "all";
  mode: Mode = "preview";
  detailsFromConversation = false;
  help = false;
  previewFocused = false;
  historicalAttempt?: string;
  composer?: Composer;
  confirmStop?: AgentView;
  busy = false;
  closed = false;
  message = "";
  hasFocus = false;
  readonly input = new Input({
    prompt: "› ",
    placeholder: "Message to the selected agent",
  });
  readonly conversation: ConversationPane;
  readonly preview = new PreviewPane();
  detailContent: string[] = [];
  detailView?: AgentView;
  detailWidth = 0;
  readonly details = new ScrollView(
    { render: () => this.detailContent, invalidate() {} },
    { scrollbar: "hidden" },
  );
  readonly unsubscribe: () => void;
  unsubscribeClock?: () => void;
  bodyY = 5;
  contentX = 3;
  navY = 3;
  expandX = 0;
  headerY = 1;
  navHits: { start: number; end: number; key: string }[] = [];
  bodyHeight = 1;
  listHeight = 1;
  listRowHeight = 3;
  listWidth = 1;
  listStart = 0;
  wide = false;
  inputY = -1;
  footerY = -1;
  filterHits: { start: number; end: number; filter: Filter }[] = [];
  actionHits: { start: number; end: number; key: string; row: number }[] = [];
  helpContent: string[] = [];
  readonly helpScroll = new ScrollView(
    { render: () => this.helpContent, invalidate() {} },
    { scrollbar: "hidden" },
  );
  loaded = new Set<string>();

  constructor(
    readonly ctx: ExtensionContext,
    readonly service: AgentService,
    readonly tui: TUI,
    readonly theme: Theme,
    readonly done: (result: Exit) => void,
    selectedId?: string,
  ) {
    this.selectedId = selectedId;
    this.conversation = new ConversationPane(tui, ctx.cwd, theme);
    this.input.onEscape = () => {
      this.composer = undefined;
      this.input.focused = false;
      this.redraw();
    };
    this.input.onSubmit = (text) => this.submit(text);
    this.unsubscribe = service.subscribe(() => this.refresh());
    this.refresh();
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.input.focused = value && !!this.composer;
  }

  get readingPane(): boolean {
    return this.fullscreen && this.mode !== "preview";
  }

  redraw = (): void => {
    if (!this.closed) this.tui.requestRender();
  };

  refresh(): void {
    if (this.closed) return;
    this.views = this.service.list();
    rebuildTree(this);
    this.syncClock();
    this.loadSelected();
    this.redraw();
  }

  syncClock(): void {
    const active =
      !this.help &&
      (this.mode === "preview"
        ? this.tree.some(({ view }) => !isSettled(view.state))
        : !!this.selected() && !isSettled(this.selected()!.state));
    if (active && !this.unsubscribeClock)
      this.unsubscribeClock = animationClock.subscribe(this.redraw);
    else if (!active) {
      this.unsubscribeClock?.();
      this.unsubscribeClock = undefined;
    }
  }

  selected(): AgentView | undefined {
    const current = this.views.find((view) => view.id === this.selectedId);
    return current && this.historicalAttempt
      ? (this.service.attempt(current.id, this.historicalAttempt) ?? current)
      : current;
  }

  isCurrent(view: AgentView): boolean {
    return this.views.some((entry) => entry.id === view.id && entry.attemptId === view.attemptId);
  }

  parentAlive(view: AgentView): boolean {
    if (!view.owner.attemptId) return view.owner.id === this.service.root.id;
    const parent = this.service.attempt(view.owner.id, view.owner.attemptId);
    return parent?.state === "running";
  }

  definitionAvailable(view: AgentView): boolean {
    return this.service.catalog
      .definitions()
      .some((definition) => definition.name === view.agentType && definition.enabled);
  }

  canResume(view: AgentView): boolean {
    return (
      this.isCurrent(view) &&
      isSettled(view.state) &&
      !view.resumeBlocked &&
      !!view.sessionFile &&
      this.parentAlive(view) &&
      this.definitionAvailable(view)
    );
  }

  canRestart(view: AgentView): boolean {
    return this.isCurrent(view) && isSettled(view.state) && this.definitionAvailable(view);
  }

  canSteer(view: AgentView): boolean {
    return this.isCurrent(view) && view.state === "running";
  }

  canStop(view: AgentView): boolean {
    return this.isCurrent(view) && !isSettled(view.state) && view.state !== "settling";
  }

  loadSelected(): void {
    const view = this.selected();
    if (
      this.mode === "preview" ||
      !view ||
      view.transcriptLoaded ||
      this.loaded.has(view.attemptId)
    )
      return;
    this.loaded.add(view.attemptId);
    void this.service.loadTranscript(view.id, view.attemptId).catch((error: unknown) => {
      if (!this.closed && this.selected()?.attemptId === view.attemptId) {
        this.message = `Could not load this conversation: ${String(error)}`;
        this.redraw();
      }
    });
  }

  select(id: string): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.historicalAttempt = undefined;
    this.preview.reset();
    this.conversation.reset();
    this.details.scrollToStart();
    this.message = "";
    rebuildTree(this);
    this.syncClock();
    this.loadSelected();
    this.redraw();
  }

  changeFilter(filter: Filter): void {
    this.filter = filter;
    const selected = this.selected();
    if (selected && filter !== "all" && (filter === "finished") !== isSettled(selected.state))
      this.selectedId = undefined;
    this.historicalAttempt = undefined;
    rebuildTree(this);
    this.syncClock();
    this.loadSelected();
    this.redraw();
  }

  act(action: () => Promise<unknown>): void {
    if (this.busy || this.closed) return;
    this.busy = true;
    this.message = "";
    void action()
      .catch((error: unknown) => {
        if (!this.closed) {
          this.message = String(error);
          this.ctx.ui.notify(this.message, "error");
        }
      })
      .finally(() => {
        this.busy = false;
        this.refresh();
      });
    this.redraw();
  }

  compose(action: Composer["action"], target: AgentView): void {
    this.composer = { action, target };
    this.input.setValue(action === "restart" ? target.prompt : "");
    this.input.focused = this.focused;
    this.redraw();
  }

  submit(text: string): void {
    const composer = this.composer;
    if (!composer || this.busy || !text.trim()) return;
    const { target, action } = composer;
    this.act(async () => {
      const latest = this.service.get(target.id);
      if (latest.attemptId !== target.attemptId)
        throw new Error("This agent has a newer attempt. Select it before sending a message.");
      if (action === "steer") {
        if (!this.canSteer(latest))
          throw new Error("This attempt is no longer running. Use Resume to continue it.");
        await this.service.steer(target.id, text.trim(), undefined, target.attemptId);
      } else if (action === "resume") {
        if (!this.canResume(latest))
          throw new Error(
            "This attempt cannot be resumed. Its owner must still be running and its saved policy must be available.",
          );
        await this.service.spawn(
          { prompt: text.trim(), resume: target.id, run_in_background: true },
          target.owner,
        );
      } else {
        if (!this.canRestart(latest))
          throw new Error(
            "This agent cannot restart until it has settled and its definition is enabled.",
          );
        if (!this.parentAlive(target)) {
          await this.service.spawn({
            prompt: text.trim(),
            subagent_type: target.agentType,
            run_in_background: true,
          });
        } else
          await this.service.spawn(
            { prompt: text.trim(), resume: target.id, run_in_background: true },
            target.owner,
            true,
          );
      }
      if (!this.closed) {
        this.composer = undefined;
        this.input.focused = false;
        this.historicalAttempt = undefined;
      }
    });
  }

  attempt(direction: number): void {
    const view = this.selected();
    if (!view) return;
    const history = this.service.history(view.id);
    const index = history.findIndex((entry) => entry.attemptId === view.attemptId);
    const next = history[Math.max(0, Math.min(history.length - 1, index + direction))];
    if (!next) return;
    this.historicalAttempt = this.isCurrent(next) ? undefined : next.attemptId;
    this.conversation.reset();
    this.details.scrollToStart();
    this.syncClock();
    this.loadSelected();
    this.redraw();
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.composer) {
      this.input.handleInput(data);
      return;
    }
    if (this.confirmStop) {
      if (data === "y" || matchesKey(data, "enter")) {
        const target = this.confirmStop;
        this.confirmStop = undefined;
        this.act(() => this.service.stop(target.id, undefined, target.attemptId));
      } else if (data === "n" || matchesKey(data, "escape")) this.confirmStop = undefined;
      this.redraw();
      return;
    }
    if (this.help) {
      if (matchesKey(data, "escape") || data === "?") {
        this.help = false;
        this.syncClock();
      } else if (data === "f") this.fullscreen = !this.fullscreen;
      else if (matchesKey(data, "up")) this.helpScroll.scrollBy(-1);
      else if (matchesKey(data, "down")) this.helpScroll.scrollBy(1);
      else if (matchesKey(data, "pageUp")) this.helpScroll.scrollBy(-this.bodyHeight);
      else if (matchesKey(data, "pageDown")) this.helpScroll.scrollBy(this.bodyHeight);
      this.redraw();
      return;
    }
    if (data === "?") this.help = true;
    else if (matchesKey(data, "escape")) {
      if (this.readingPane && this.mode === "details" && this.detailsFromConversation) {
        this.mode = "conversation";
        this.detailsFromConversation = false;
      } else if (this.mode !== "preview") {
        this.mode = "preview";
        this.fullscreen = false;
        this.detailsFromConversation = false;
        this.previewFocused = false;
        this.historicalAttempt = undefined;
      } else this.done("close");
    } else if (data === "f") this.fullscreen = !this.fullscreen;
    else if (matchesKey(data, "tab")) this.previewFocused = !this.previewFocused;
    else if (data === "n" && this.mode === "conversation") this.conversation.toggleNotices();
    else if (data === "1") this.changeFilter("all");
    else if (data === "2") this.changeFilter("active");
    else if (data === "3") this.changeFilter("finished");
    else if (data === "c") this.done("definitions");
    else if (data === ",") this.done("settings");
    else if (data === "[" && this.mode !== "preview") this.attempt(-1);
    else if (data === "]" && this.mode !== "preview") this.attempt(1);
    else {
      const view = this.selected();
      if (matchesKey(data, "enter") && view) {
        if (this.mode !== "conversation") this.fullscreen = true;
        this.mode = "conversation";
        this.detailsFromConversation = false;
        this.previewFocused = true;
        this.loaded.delete(view.attemptId);
        this.loadSelected();
      } else if (data === "d" && view) {
        this.detailsFromConversation = this.readingPane && this.mode === "conversation";
        this.mode = "details";
        this.previewFocused = true;
        this.loadSelected();
      } else if (data === "s" && view && this.canSteer(view) && !this.busy)
        this.compose("steer", view);
      else if (data === "r" && view && this.canResume(view) && !this.busy)
        this.compose("resume", view);
      else if (data === "R" && view && this.canRestart(view) && !this.busy)
        this.compose("restart", view);
      else if (data === "x" && view && this.canStop(view) && !this.busy) this.confirmStop = view;
      else if (matchesKey(data, "up") || matchesKey(data, "down")) {
        const direction = matchesKey(data, "up") ? -1 : 1;
        if (this.mode === "preview" && !this.previewFocused) {
          const index = this.tree.findIndex(({ view: entry }) => entry.id === this.selectedId);
          const next = this.tree[Math.max(0, Math.min(this.tree.length - 1, index + direction))];
          if (next) this.select(next.view.id);
        } else this.scrollBy(direction);
      } else if (matchesKey(data, "pageUp"))
        this.scrollBy(-Math.max(1, this.scroll().viewportHeight - 2));
      else if (matchesKey(data, "pageDown"))
        this.scrollBy(Math.max(1, this.scroll().viewportHeight - 2));
      else if (matchesKey(data, "end")) this.scroll().scrollToEnd();
      else if (matchesKey(data, "home")) this.scroll().scrollToStart();
    }
    this.syncClock();
    this.redraw();
  }

  scroll(): ScrollView {
    return this.mode === "conversation"
      ? this.conversation.scroll
      : this.mode === "details"
        ? this.details
        : this.preview.scroll;
  }

  scrollBy(lines: number): void {
    const scroll = this.scroll();
    scroll.scrollTo(scroll.scrollTop + lines, { disableFollow: true });
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed) return undefined;
    if (this.composer && event.y === this.inputY)
      return this.input.handleMouse({
        ...event,
        x: event.x - this.contentX,
        y: 0,
        width: Math.max(1, event.width - this.contentX * 2),
        height: 1,
      });
    if (event.type === "wheel") {
      if (this.help) this.helpScroll.scrollBy(event.wheelDelta ?? 0);
      else if (!this.composer && !this.confirmStop && !this.help) {
        if (
          this.mode === "preview" &&
          event.y >= this.bodyY &&
          event.y < this.bodyY + this.listHeight &&
          (!this.wide || event.x < this.contentX + this.listWidth)
        ) {
          const index = Math.max(
            0,
            Math.min(this.tree.length - 1, this.listStart + (event.wheelDelta ?? 0)),
          );
          const row = this.tree[index];
          if (row) this.select(row.view.id);
        } else this.scrollBy(event.wheelDelta ?? 0);
      }
      this.redraw();
      return { handled: true, render: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;

    const send = (key: string): void =>
      this.handleInput(
        key === "enter"
          ? "\r"
          : key === "escape"
            ? "\x1b"
            : key === "tab"
              ? "\t"
              : key === "end"
                ? "\x1b[F"
                : key,
      );

    if (event.y === this.footerY) {
      const hit = this.actionHits.find((entry) => event.x >= entry.start && event.x < entry.end);
      if (hit) send(hit.key);
    } else if (!this.composer && !this.confirmStop) {
      if (event.y === this.headerY && event.x >= this.expandX) send("f");
      else if (event.y === this.navY && !this.help) {
        const tab = this.navHits.find((entry) => event.x >= entry.start && event.x < entry.end);
        const filter = this.filterHits.find(
          (entry) => event.x >= entry.start && event.x < entry.end,
        );
        if (tab) send(tab.key);
        else if (filter) this.changeFilter(filter.filter);
      } else if (
        !this.help &&
        this.mode === "preview" &&
        event.y >= this.bodyY &&
        event.y < this.bodyY + this.listHeight &&
        (!this.wide || event.x < this.contentX + this.listWidth)
      ) {
        const row =
          this.tree[this.listStart + Math.floor((event.y - this.bodyY) / this.listRowHeight)];
        if (row) {
          this.select(row.view.id);
          this.previewFocused = false;
          if ((event.clickCount ?? 1) > 1) send("enter");
        }
      } else if (
        !this.help &&
        this.mode === "conversation" &&
        event.y >= this.bodyY &&
        event.y < this.bodyY + this.bodyHeight &&
        this.conversation.toggleNoticeAt(event.y - this.bodyY)
      )
        return { handled: true, render: true, focus: true };
      else this.previewFocused = true;
    }
    this.redraw();
    return { handled: true, render: true, focus: true };
  }

  invalidate(): void {
    this.preview.invalidate();
    this.conversation.invalidate();
    this.detailView = undefined;
    this.input.invalidate();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.unsubscribeClock?.();
    this.unsubscribeClock = undefined;
    this.input.focused = false;
    this.input.onSubmit = undefined;
    this.input.onEscape = undefined;
    this.loaded.clear();
  }

  render(width: number): string[] {
    return renderPanel(this, width);
  }
}

/** Visibility callback receives a close function for lifecycle disposal; it is cleared on exit. */
export async function openSupervisor(
  ctx: ExtensionContext,
  service: AgentService,
  onMenu: (action: "definitions" | "settings") => Promise<void>,
  selectedId?: string,
  onVisibility?: (visible: boolean, close?: () => void) => void,
): Promise<void> {
  if (ctx.mode !== "tui") return;
  let cancelled = false;
  let finish: (() => void) | undefined;

  const close = (): void => {
    cancelled = true;
    finish?.();
  };

  onVisibility?.(true, close);
  try {
    for (;;) {
      if (cancelled) break;
      let panel: Supervisor | undefined;
      const result = await ctx.ui.custom<Exit>(
        (tui, theme, _keys, done) => {
          finish = () => done("close");
          panel = new Supervisor(ctx, service, tui, theme, done, selectedId);
          return panel;
        },
        {
          overlay: true,

          // Live accessors resize the same focused overlay without losing reading position.
          overlayOptions: {
            anchor: "center",
            get width() {
              return panel?.fullscreen ? "100%" : 128;
            },
            maxHeight: "100%",
            get margin() {
              return panel?.fullscreen ? 0 : 1;
            },
          },
        },
      );
      finish = undefined;
      selectedId = panel?.selectedId;
      if (cancelled || result === "close") break;
      await onMenu(result);
    }
  } finally {
    finish = undefined;
    onVisibility?.(false);
  }
}
