import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { detailLines } from "./conversation.ts";
import { agentBadge, between, counts, elapsed, fit, helpLines, plain } from "./render.ts";
import type { Filter, Layout, Supervisor } from "./supervisor.ts";
import { taskTitle } from "./transcript.ts";
import { isSettled, type AgentView } from "./types.ts";

function renderDetails(
  panel: Supervisor,
  view: AgentView,
  width: number,
  height: number,
): string[] {
  if (view !== panel.detailView || width !== panel.detailWidth) {
    panel.detailView = view;
    panel.detailWidth = width;
    panel.detailContent = detailLines(view, panel.theme, width);
  }
  panel.details.updateLayout(panel.detailContent.length, height, panel.redraw);
  return panel.detailContent.slice(panel.details.scrollTop, panel.details.scrollTop + height);
}

function filters(panel: Supervisor, layout: Layout, width: number): string {
  const finished = panel.views.filter((view) => isSettled(view.state)).length;
  const entries: { filter: Filter; label: string; count: number }[] = [
    { filter: "all", label: "All", count: panel.views.length },
    { filter: "active", label: "Active", count: panel.views.length - finished },
    { filter: "finished", label: "Finished", count: finished },
  ];
  let line = "";
  layout.filterHits = [];
  for (const [index, entry] of entries.entries()) {
    const start = visibleWidth(line) + layout.contentX;
    const label = `${entry.label} ${entry.count}`;
    line +=
      panel.filter === entry.filter
        ? panel.theme.fg("accent", panel.theme.bold(label))
        : panel.theme.fg("muted", label);
    layout.filterHits.push({
      start,
      end: visibleWidth(line) + layout.contentX,
      filter: entry.filter,
    });
    if (index < entries.length - 1) line += "   ";
  }
  return fit(line, width);
}

function navigation(panel: Supervisor, layout: Layout, width: number): string {
  layout.navHits = [];
  const entries =
    panel.mode === "preview"
      ? [
          { key: "enter", label: "Output", selected: true },
          { key: "enter", label: "Conversation", selected: false },
          { key: "d", label: "Details", selected: false },
        ]
      : [
          { key: "escape", label: "← Agents", selected: false },
          { key: "enter", label: "Conversation", selected: panel.mode === "conversation" },
          { key: "d", label: "Details", selected: panel.mode === "details" },
        ];
  let text = "";
  for (const entry of entries) {
    const start =
      layout.contentX +
      (panel.mode === "preview" && layout.wide ? layout.listWidth + 3 : 0) +
      visibleWidth(text);
    text += entry.selected
      ? panel.theme.fg("accent", panel.theme.bold(entry.label))
      : panel.theme.fg("muted", entry.label);
    if (!(panel.mode === "preview" && entry.selected))
      layout.navHits.push({ start, end: start + visibleWidth(entry.label), key: entry.key });
    text += "   ";
  }
  return fit(text, width);
}

/** One quiet footer. The complete keyboard map is behind ?. */

function actions(
  panel: Supervisor,
  layout: Layout,
  view: AgentView | undefined,
  width: number,
): string {
  const entries = panel.composer
    ? [{ key: "enter", label: "Enter Send" }]
    : panel.confirmStop
      ? [
          { key: "y", label: "y Stop" },
          { key: "n", label: "n Keep running" },
        ]
      : panel.help
        ? []
        : panel.readingPane
          ? [
              panel.mode === "conversation"
                ? { key: "d", label: "d Details" }
                : { key: "enter", label: "Enter Conversation" },
              ...(panel.mode === "conversation" && panel.conversation.hasNotices
                ? [{ key: "n", label: "n Notices" }]
                : []),
              { key: "f", label: "f Restore" },
            ]
          : [
              ...(panel.mode !== "details" && !panel.scroll().isFollowingEnd
                ? [{ key: "end", label: "End Follow" }]
                : []),
              ...(panel.mode === "preview"
                ? [
                    { key: "tab", label: panel.previewFocused ? "Tab Agents" : "Tab Output" },
                    { key: "enter", label: "Enter Open" },
                  ]
                : []),
              ...(panel.mode === "conversation" && panel.conversation.hasNotices
                ? [{ key: "n", label: "n Notices" }]
                : []),
              ...(view && panel.canSteer(view) ? [{ key: "s", label: "s Steer" }] : []),
              ...(view && panel.canResume(view) ? [{ key: "r", label: "r Resume" }] : []),
              ...(view && panel.canStop(view) ? [{ key: "x", label: "x Stop" }] : []),
            ];
  const ending =
    panel.composer || panel.confirmStop
      ? "Esc Cancel"
      : panel.mode !== "preview" || panel.help
        ? "Esc Back"
        : "Esc Close";
  const right =
    width < 28
      ? "Esc"
      : `${panel.composer || panel.confirmStop || panel.help ? "" : "? Help   "}${ending}`;
  const budget = Math.max(0, width - visibleWidth(right) - 2);
  const readerHints =
    panel.readingPane && !panel.composer && !panel.confirmStop && !panel.help && width >= 72;
  const paused = panel.mode === "conversation" && !panel.conversation.scroll.isFollowingEnd;
  let left = readerHints ? `${paused ? "End Follow" : "↑↓ Scroll"}   [ ] Attempts` : "";
  layout.actionHits = [];
  if (readerHints) {
    const previous = layout.contentX + left.indexOf("[");
    layout.actionHits.push(
      { start: previous, end: previous + 1, key: "[" },
      { start: previous + 2, end: previous + 3, key: "]" },
    );
    if (paused)
      layout.actionHits.push({
        start: layout.contentX,
        end: layout.contentX + 10,
        key: "end",
      });
  }
  for (const entry of entries) {
    const gap = left ? "   " : "";
    if (visibleWidth(left + gap + entry.label) > budget) break;
    left += gap;
    const start = layout.contentX + visibleWidth(left);
    left += entry.label;
    layout.actionHits.push({
      start,
      end: start + visibleWidth(entry.label),
      key: entry.key,
    });
  }
  const rightX = layout.contentX + Math.max(0, width - visibleWidth(right));
  if (width >= 28 && !panel.composer && !panel.confirmStop && !panel.help)
    layout.actionHits.push({ start: rightX, end: rightX + 6, key: "?" });
  layout.actionHits.push({
    start: layout.contentX + width - visibleWidth(width < 28 ? right : ending),
    end: layout.contentX + width,
    key: "escape",
  });
  return panel.theme.fg("muted", between(left, right, width));
}

function renderList(panel: Supervisor, layout: Layout, height: number, compact = false): string[] {
  layout.listRowHeight = compact ? 2 : 3;
  const slots = Math.max(1, Math.floor(height / layout.listRowHeight));
  layout.listHeight = Math.min(
    height,
    slots * layout.listRowHeight,
    panel.tree.length * layout.listRowHeight,
  );
  const index = Math.max(
    0,
    panel.tree.findIndex(({ view }) => view.id === panel.selectedId),
  );
  panel.listStart = Math.max(
    0,
    Math.min(panel.listStart, index, Math.max(0, panel.tree.length - slots)),
  );
  if (index >= panel.listStart + slots) panel.listStart = index - slots + 1;
  const now = Date.now();
  const statusWidth = 11;
  const durationWidth = panel.tree.reduce(
    (width, { view }) => Math.max(width, visibleWidth(elapsed(view, now))),
    6,
  );
  const identityWidth = Math.max(0, layout.listWidth - statusWidth - durationWidth - 4);
  const lines: string[] = [];
  for (const { view, indent } of panel.tree.slice(panel.listStart, panel.listStart + slots)) {
    const selected = view.id === panel.selectedId;
    const badge = agentBadge(view);
    const branch = "  ".repeat(Math.min(indent, 4)) + (indent ? "└ " : "");
    const marker = selected
      ? panel.theme.fg(panel.previewFocused ? "muted" : "accent", "▌ ")
      : "  ";
    const task = taskTitle({ task: plain(view.task) });
    const title = fit(
      `${marker}${branch}${selected ? panel.theme.bold(task) : task}`,
      layout.listWidth,
    );
    const state = panel.theme.fg(badge.tone, `${badge.icon} ${badge.label}`);
    const identity = plain(compact ? `@${view.name} · ${view.displayName}` : view.displayName);
    const caption = fit(`${marker}${branch}${panel.theme.fg("muted", identity)}`, identityWidth);
    const duration = elapsed(view, now);
    const timing = panel.theme.fg(
      "dim",
      " ".repeat(Math.max(0, durationWidth - visibleWidth(duration))) + duration,
    );
    const alignedState = " ".repeat(Math.max(0, statusWidth - visibleWidth(state))) + state;
    const metadata = `${caption} · ${alignedState} ${timing}`;
    lines.push(
      selected ? panel.theme.bg("selectedBg", title) : title,
      selected ? panel.theme.bg("selectedBg", metadata) : metadata,
    );
    if (!compact) lines.push("");
  }
  if (!lines.length) lines.push(panel.theme.fg("dim", "No matching agents"));
  return lines;
}

function output(
  panel: Supervisor,
  layout: Layout,
  view: AgentView | undefined,
  width: number,
  height: number,
): string[] {
  if (!view)
    return [
      panel.theme.bold("No agents yet"),
      "",
      panel.theme.fg("muted", "Start a task from the conversation."),
      panel.theme.fg("dim", "c opens agent definitions."),
    ];
  const badge = agentBadge(view);
  const history =
    panel.mode === "preview"
      ? ""
      : `Attempt ${view.attemptNumber}${panel.historicalAttempt ? " · History" : ""} · `;
  const paused =
    panel.mode === "conversation"
      ? !panel.conversation.scroll.isFollowingEnd
      : panel.mode === "preview" && !panel.preview.scroll.isFollowingEnd;
  const header = [
    panel.theme.bold(taskTitle({ task: plain(view.task) })),
    between(
      `${panel.theme.fg("muted", history)}${panel.theme.fg(badge.tone, `${badge.icon} ${badge.label}`)} · ${panel.theme.fg("muted", plain(view.displayName))}`,
      panel.theme.fg("dim", `${elapsed(view)}${paused ? " · Paused" : ""}`),
      width,
    ),
    "",
  ];
  // Output is drawn at bodyY in the floating and compact layouts, below this header.
  layout.transcriptY = layout.bodyY + header.length;
  const remaining = Math.max(1, height - header.length);
  const content =
    panel.mode === "preview"
      ? panel.preview.render(view, width, remaining, panel.redraw)
      : panel.mode === "conversation"
        ? panel.conversation.render(
            view,
            width,
            remaining,
            panel.service.catalog.settings.viewerMarkdown,
          )
        : renderDetails(panel, view, width, remaining);
  return [...header, ...content];
}

export function renderPanel(panel: Supervisor, layout: Layout, width: number): string[] {
  if (panel.readingPane) return renderReadingPane(panel, layout, width);
  layout.contentX = 3;
  layout.headerY = 1;
  layout.navY = 3;
  layout.bodyY = 5;
  layout.inputY = -1;
  layout.wide = panel.mode === "preview" && !panel.help && width >= 104;
  const inner = Math.max(1, width - 6);
  layout.listWidth = layout.wide ? Math.min(39, Math.floor(inner * 0.34)) : inner;
  const rightWidth = layout.wide ? Math.max(1, inner - layout.listWidth - 3) : inner;
  const terminalHeight = Math.max(1, panel.tui.terminal.rows - (panel.fullscreen ? 0 : 4));
  const maximum = panel.fullscreen ? terminalHeight : Math.min(36, terminalHeight);
  const extra = panel.composer ? 2 : panel.confirmStop || panel.message || panel.busy ? 1 : 0;
  const available = maximum - 9 - extra;
  if (available < 7 || width < 36) return renderCompact(panel, layout, width, Math.max(1, maximum));
  const view = panel.selected();

  const edge = (text: string): string => panel.theme.fg("borderMuted", text);

  const line = (text = ""): string => `${edge("│")}  ${fit(text, inner)}  ${edge("│")}`;

  const rule = (left: string, right: string): string =>
    edge(left + "─".repeat(Math.max(0, width - 2)) + right);

  const summary = counts(panel.views);
  const active = summary.running + summary.waiting + summary.queued;
  const title =
    panel.theme.fg("accent", panel.theme.bold("Agents")) +
    panel.theme.fg(
      "dim",
      active
        ? `   ${active} active${summary.finished ? ` · ${summary.finished} finished` : ""}`
        : panel.views.length
          ? `   ${summary.finished} finished`
          : "",
    );
  const expand = panel.theme.fg("dim", panel.fullscreen ? "f Restore" : "f Fullscreen");
  layout.expandX = layout.contentX + inner - visibleWidth(expand);
  const stacked = panel.mode === "preview" && !panel.help && !layout.wide;
  let right = panel.help
    ? helpLines(panel.theme, panel.tui.mode === "fullscreen", inner)
    : stacked
      ? []
      : output(panel, layout, view, rightWidth, available);
  const natural =
    panel.mode === "preview" && !panel.help
      ? layout.wide
        ? Math.max(10, Math.min(12, panel.tree.length * 3), right.length)
        : Math.max(7, panel.tree.length * 2 + 4)
      : Math.max(10, right.length);
  layout.bodyHeight = panel.fullscreen ? available : Math.min(available, natural);
  let body: string[] = [];
  if (layout.wide) {
    const list = renderList(panel, layout, layout.bodyHeight);
    right = output(panel, layout, view, rightWidth, layout.bodyHeight);
    for (let index = 0; index < layout.bodyHeight; index++)
      body.push(
        `${fit(list[index] ?? "", layout.listWidth)} ${panel.theme.fg(panel.previewFocused ? "borderAccent" : "borderMuted", "│")} ${right[index] ?? ""}`,
      );
  } else if (panel.mode === "preview" && !panel.help) {
    const previewHeight = Math.min(3, Math.max(1, Math.floor(layout.bodyHeight / 3)));
    const listBudget = layout.bodyHeight - previewHeight - 1;
    const overflow = panel.tree.length > Math.floor(listBudget / 2);
    body = renderList(panel, layout, Math.max(2, listBudget - (overflow ? 1 : 0)), true);
    if (overflow) {
      const last = Math.min(panel.tree.length, panel.listStart + layout.listHeight / 2);
      body.push(
        panel.theme.fg(
          "dim",
          `${panel.listStart + 1}–${last} of ${panel.tree.length} agents · ↑↓ More`,
        ),
      );
    }
    body.push(edge("─".repeat(inner)));
    const preview = view
      ? panel.preview.render(view, inner, previewHeight, panel.redraw, true)
      : [panel.theme.fg("muted", "Start a task from the main conversation.")];
    body.push(...preview.slice(0, previewHeight));
  } else {
    layout.listHeight = 0;
    if (panel.help) {
      panel.helpContent = right;
      panel.helpScroll.updateLayout(right.length, layout.bodyHeight, panel.redraw);
      body = right.slice(
        panel.helpScroll.scrollTop,
        panel.helpScroll.scrollTop + layout.bodyHeight,
      );
    } else body = output(panel, layout, view, inner, layout.bodyHeight).slice(0, layout.bodyHeight);
  }
  while (body.length < layout.bodyHeight) body.push("");
  layout.navHits = [];
  layout.filterHits = [];
  const nav = panel.help
    ? panel.theme.fg("muted", "Help")
    : panel.mode === "preview"
      ? layout.wide
        ? `${filters(panel, layout, layout.listWidth)}   ${navigation(panel, layout, rightWidth)}`
        : filters(panel, layout, inner)
      : navigation(panel, layout, inner);
  const lines = [
    rule("╭", "╮"),
    line(between(title, expand, inner)),
    line(),
    line(nav),
    line(),
    ...body.map(line),
    line(),
  ];
  if (panel.composer) {
    const label =
      panel.composer.action === "steer"
        ? "Steer"
        : panel.composer.action === "resume"
          ? "Resume · saved policy"
          : !panel.parentAlive(panel.composer.target)
            ? "Restart · new top-level agent"
            : "Restart · current definition, fresh session";
    lines.push(line(panel.theme.fg("accent", label)));
    layout.inputY = lines.length;
    lines.push(line(panel.input.render(inner)[0] ?? ""));
  } else if (panel.confirmStop)
    lines.push(
      line(
        panel.theme.fg(
          "warning",
          `Stop “${taskTitle({ task: plain(panel.confirmStop.task) })}” and its children?  y / n`,
        ),
      ),
    );
  else if (panel.message) lines.push(line(panel.theme.fg("warning", plain(panel.message))));
  else if (panel.busy) lines.push(line(panel.theme.fg("dim", "Applying action…")));
  lines.push(rule("├", "┤"));
  layout.footerY = lines.length;
  lines.push(line(actions(panel, layout, view, inner)), rule("╰", "╯"));
  return lines.map((text) => truncateToWidth(text, width));
}

/**
 * Fill the pane with one header, a scrollable body, and pinned controls.
 * Padding every row prevents the parent transcript from showing through.
 */

function renderReadingPane(panel: Supervisor, layout: Layout, width: number): string[] {
  const height = Math.max(1, panel.tui.terminal.rows);
  if (height < 7 || width < 28) {
    const lines = renderCompact(panel, layout, width, height);
    while (lines.length < height) lines.push("");
    return lines.map((line) => fit(line, width));
  }
  layout.contentX = 2;
  layout.headerY = -1;
  layout.navY = 0;
  layout.bodyY = 3;
  layout.inputY = -1;
  layout.listHeight = 0;
  layout.wide = false;
  layout.filterHits = [];
  const inner = Math.max(1, width - 4);
  const extra = panel.composer ? 2 : panel.confirmStop || panel.message || panel.busy ? 1 : 0;
  layout.bodyHeight = Math.max(1, height - 5 - extra);
  const view = panel.selected();
  const badge = view ? agentBadge(view) : undefined;
  const back = panel.help
    ? "← Back"
    : panel.mode === "details" && panel.detailsFromConversation
      ? "← Conversation"
      : "← Agents";
  layout.navHits = [
    { start: layout.contentX, end: layout.contentX + visibleWidth(back), key: "escape" },
  ];
  const name = view
    ? panel.theme.bold(plain(view.name)) +
      panel.theme.fg(
        "dim",
        ` · Attempt ${view.attemptNumber}${panel.historicalAttempt ? " · History" : ""}`,
      )
    : "Conversation";
  const status = badge
    ? panel.theme.fg(badge.tone, `${badge.icon} ${badge.label}`) +
      (panel.mode === "conversation" && !panel.conversation.scroll.isFollowingEnd
        ? panel.theme.fg("dim", " · Paused")
        : "")
    : "";
  const line = (text = ""): string => `  ${fit(text, inner)}  `;
  const rule = panel.theme.fg("borderMuted", "─".repeat(width));
  const lines = [
    line(between(`${panel.theme.fg("muted", back)}   ${name}`, status, inner)),
    rule,
    line(),
  ];
  let body: string[];
  if (panel.help) {
    panel.helpContent = helpLines(panel.theme, panel.tui.mode === "fullscreen", inner);
    panel.helpScroll.updateLayout(panel.helpContent.length, layout.bodyHeight, panel.redraw);
    body = panel.helpContent.slice(
      panel.helpScroll.scrollTop,
      panel.helpScroll.scrollTop + layout.bodyHeight,
    );
  } else if (!view) body = ["No conversation selected."];
  else if (panel.mode === "details") body = renderDetails(panel, view, inner, layout.bodyHeight);
  else {
    layout.transcriptY = layout.bodyY;
    body = panel.conversation.render(
      view,
      inner,
      layout.bodyHeight,
      panel.service.catalog.settings.viewerMarkdown,
      true,
    );
  }
  for (let row = 0; row < layout.bodyHeight; row++) lines.push(line(body[row] ?? ""));
  if (panel.composer) {
    lines.push(
      line(
        panel.theme.fg(
          "accent",
          panel.composer.action === "resume"
            ? "Resume · saved policy"
            : panel.composer.action === "restart"
              ? "Restart · current definition"
              : "Steer",
        ),
      ),
    );
    layout.inputY = lines.length;
    lines.push(line(panel.input.render(inner)[0] ?? ""));
  } else if (panel.confirmStop)
    lines.push(line(panel.theme.fg("warning", "Stop this agent and its children? y / n")));
  else if (panel.message) lines.push(line(panel.theme.fg("warning", plain(panel.message))));
  else if (panel.busy) lines.push(line(panel.theme.fg("dim", "Applying action…")));
  lines.push(rule);
  layout.footerY = lines.length;
  lines.push(line(actions(panel, layout, view, inner)));
  return lines.map((text) => fit(text, width));
}

function renderCompact(panel: Supervisor, layout: Layout, width: number, height: number): string[] {
  layout.contentX = 0;
  layout.headerY = height <= 3 ? -1 : 0;
  layout.navY = -1;
  layout.expandX = Math.max(0, width - 12);
  layout.navHits = [];
  layout.filterHits = [];
  layout.actionHits = [];
  layout.listHeight = 0;
  layout.bodyY = 1;
  layout.inputY = -1;
  layout.bodyHeight = Math.max(1, height - 2);
  const view = panel.selected();
  let lines = height <= 3 ? [] : [panel.theme.fg("accent", panel.theme.bold("Agents"))];
  layout.bodyY = lines.length;
  if (panel.composer) {
    if (height <= 2) lines = [];
    layout.inputY = lines.length;
    lines.push(panel.input.render(width)[0] ?? "");
  } else if (panel.confirmStop) lines.push("Stop this agent and its children? y / n");
  else if (panel.help) {
    panel.helpContent = helpLines(panel.theme, panel.tui.mode === "fullscreen", width);
    panel.helpScroll.updateLayout(panel.helpContent.length, layout.bodyHeight, panel.redraw);
    lines.push(
      ...panel.helpContent.slice(
        panel.helpScroll.scrollTop,
        panel.helpScroll.scrollTop + layout.bodyHeight,
      ),
    );
  } else
    lines.push(
      ...output(panel, layout, view, width, layout.bodyHeight).slice(0, layout.bodyHeight),
    );
  lines = lines.slice(0, Math.max(1, height - 1));
  if (height > 1) {
    layout.footerY = lines.length;
    lines.push(actions(panel, layout, view, width));
  } else layout.footerY = -1;
  return lines.map((line) => truncateToWidth(line, width));
}
