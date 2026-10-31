import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { detailLines } from "./conversation.ts";
import { agentBadge, between, counts, elapsed, fit, helpLines } from "./render.ts";
import type { Filter, Supervisor, TreeRow } from "./supervisor.ts";
import { isSettled, taskTitle, type AgentView } from "./transcript.ts";

export function rebuildTree(panel: Supervisor): void {
  const ids = new Map(panel.views.map((view) => [view.id, view]));
  const included = new Set(
    panel.views
      .filter(
        (view) => panel.filter === "all" || (panel.filter === "finished") === isSettled(view.state),
      )
      .map((view) => view.id),
  );
  // A finishing selection stays visible even in Active. Ancestors explain child ownership.
  if (panel.selectedId && ids.has(panel.selectedId)) included.add(panel.selectedId);
  for (const id of included) {
    let view = ids.get(id);
    const seen = new Set<string>();
    while (view && !seen.has(view.id)) {
      seen.add(view.id);
      const parent = ids.get(view.owner.id);
      if (!parent) break;
      included.add(parent.id);
      view = parent;
    }
  }
  const children = new Map<string, AgentView[]>();
  for (const view of panel.views) {
    if (!included.has(view.id)) continue;
    const key = ids.has(view.owner.id) ? view.owner.id : "";
    const entries = children.get(key) ?? [];
    entries.push(view);
    children.set(key, entries);
  }
  const tree: TreeRow[] = [];
  const visited = new Set<string>();

  const visit = (view: AgentView, indent: number): void => {
    if (visited.has(view.id)) return;
    visited.add(view.id);
    tree.push({ view, indent });
    for (const child of children.get(view.id) ?? []) visit(child, indent + 1);
  };

  for (const entries of children.values())
    entries.sort(
      (a, b) =>
        Number(isSettled(a.state)) - Number(isSettled(b.state)) || b.createdAt - a.createdAt,
    );
  for (const root of children.get("") ?? []) visit(root, 0);
  for (const view of panel.views)
    if (included.has(view.id) && !visited.has(view.id)) visit(view, 0);
  panel.tree = tree;
  if (!tree.some(({ view }) => view.id === panel.selectedId))
    panel.selectedId = tree.find(({ view }) => !isSettled(view.state))?.view.id ?? tree[0]?.view.id;
}

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

function filters(panel: Supervisor, width: number): string {
  const finished = panel.views.filter((view) => isSettled(view.state)).length;
  const entries: { filter: Filter; label: string; count: number }[] = [
    { filter: "all", label: "All", count: panel.views.length },
    { filter: "active", label: "Active", count: panel.views.length - finished },
    { filter: "finished", label: "Finished", count: finished },
  ];
  let line = "";
  panel.filterHits = [];
  for (const [index, entry] of entries.entries()) {
    const start = visibleWidth(line) + panel.contentX;
    const label = `${entry.label} ${entry.count}`;
    line +=
      panel.filter === entry.filter
        ? panel.theme.fg("accent", panel.theme.bold(label))
        : panel.theme.fg("muted", label);
    panel.filterHits.push({
      start,
      end: visibleWidth(line) + panel.contentX,
      filter: entry.filter,
    });
    if (index < entries.length - 1) line += "   ";
  }
  return fit(line, width);
}

function navigation(panel: Supervisor, width: number): string {
  panel.navHits = [];
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
      panel.contentX +
      (panel.mode === "preview" && panel.wide ? panel.listWidth + 3 : 0) +
      visibleWidth(text);
    text += entry.selected
      ? panel.theme.fg("accent", panel.theme.bold(entry.label))
      : panel.theme.fg("muted", entry.label);
    if (!(panel.mode === "preview" && entry.selected))
      panel.navHits.push({ start, end: start + visibleWidth(entry.label), key: entry.key });
    text += "   ";
  }
  return fit(text, width);
}

/** One quiet footer. The complete keyboard map is behind ?. */

function actions(panel: Supervisor, view: AgentView | undefined, width: number): string {
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
  panel.actionHits = [];
  if (readerHints) {
    const previous = panel.contentX + left.indexOf("[");
    panel.actionHits.push(
      { start: previous, end: previous + 1, key: "[", row: 0 },
      { start: previous + 2, end: previous + 3, key: "]", row: 0 },
    );
    if (paused)
      panel.actionHits.push({
        start: panel.contentX,
        end: panel.contentX + 10,
        key: "end",
        row: 0,
      });
  }
  for (const entry of entries) {
    const gap = left ? "   " : "";
    if (visibleWidth(left + gap + entry.label) > budget) break;
    left += gap;
    const start = panel.contentX + visibleWidth(left);
    left += entry.label;
    panel.actionHits.push({
      start,
      end: start + visibleWidth(entry.label),
      key: entry.key,
      row: 0,
    });
  }
  const rightX = panel.contentX + Math.max(0, width - visibleWidth(right));
  if (width >= 28 && !panel.composer && !panel.confirmStop && !panel.help)
    panel.actionHits.push({ start: rightX, end: rightX + 6, key: "?", row: 0 });
  panel.actionHits.push({
    start: panel.contentX + width - visibleWidth(width < 28 ? right : ending),
    end: panel.contentX + width,
    key: "escape",
    row: 0,
  });
  return panel.theme.fg("muted", between(left, right, width));
}

function renderList(panel: Supervisor, height: number, compact = false): string[] {
  panel.listRowHeight = compact ? 2 : 3;
  const slots = Math.max(1, Math.floor(height / panel.listRowHeight));
  panel.listHeight = Math.min(
    height,
    slots * panel.listRowHeight,
    panel.tree.length * panel.listRowHeight,
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
  const identityWidth = Math.max(0, panel.listWidth - statusWidth - durationWidth - 4);
  const lines: string[] = [];
  for (const { view, indent } of panel.tree.slice(panel.listStart, panel.listStart + slots)) {
    const selected = view.id === panel.selectedId;
    const badge = agentBadge(view);
    const branch = "  ".repeat(Math.min(indent, 4)) + (indent ? "└ " : "");
    const marker = selected
      ? panel.theme.fg(panel.previewFocused ? "muted" : "accent", "▌ ")
      : "  ";
    const title = fit(
      `${marker}${branch}${selected ? panel.theme.bold(taskTitle(view)) : taskTitle(view)}`,
      panel.listWidth,
    );
    const state = panel.theme.fg(badge.tone, `${badge.icon} ${badge.label}`);
    const identity = compact ? `@${view.name} · ${view.displayName}` : view.displayName;
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
    panel.theme.bold(taskTitle(view)),
    between(
      `${panel.theme.fg("muted", history)}${panel.theme.fg(badge.tone, `${badge.icon} ${badge.label}`)} · ${panel.theme.fg("muted", view.displayName)}`,
      panel.theme.fg("dim", `${elapsed(view)}${paused ? " · Paused" : ""}`),
      width,
    ),
    "",
  ];
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

export function renderPanel(panel: Supervisor, width: number): string[] {
  if (panel.readingPane) return renderReadingPane(panel, width);
  panel.contentX = 3;
  panel.headerY = 1;
  panel.navY = 3;
  panel.bodyY = 5;
  panel.inputY = -1;
  panel.wide = panel.mode === "preview" && !panel.help && width >= 104;
  const inner = Math.max(1, width - 6);
  panel.listWidth = panel.wide ? Math.min(39, Math.floor(inner * 0.34)) : inner;
  const rightWidth = panel.wide ? Math.max(1, inner - panel.listWidth - 3) : inner;
  const terminalHeight = Math.max(1, panel.tui.terminal.rows - (panel.fullscreen ? 0 : 4));
  const maximum = panel.fullscreen ? terminalHeight : Math.min(36, terminalHeight);
  const extra = panel.composer ? 2 : panel.confirmStop || panel.message || panel.busy ? 1 : 0;
  const available = maximum - 9 - extra;
  if (available < 7 || width < 36) return renderCompact(panel, width, Math.max(1, maximum));
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
  panel.expandX = panel.contentX + inner - visibleWidth(expand);
  const stacked = panel.mode === "preview" && !panel.help && !panel.wide;
  let right = panel.help
    ? helpLines(panel.theme, panel.tui.mode === "fullscreen", inner)
    : stacked
      ? []
      : output(panel, view, rightWidth, available);
  const natural =
    panel.mode === "preview" && !panel.help
      ? panel.wide
        ? Math.max(10, Math.min(12, panel.tree.length * 3), right.length)
        : Math.max(7, panel.tree.length * 2 + 4)
      : Math.max(10, right.length);
  panel.bodyHeight = panel.fullscreen ? available : Math.min(available, natural);
  let body: string[] = [];
  if (panel.wide) {
    const list = renderList(panel, panel.bodyHeight);
    right = output(panel, view, rightWidth, panel.bodyHeight);
    for (let index = 0; index < panel.bodyHeight; index++)
      body.push(
        `${fit(list[index] ?? "", panel.listWidth)} ${panel.theme.fg(panel.previewFocused ? "borderAccent" : "borderMuted", "│")} ${right[index] ?? ""}`,
      );
  } else if (panel.mode === "preview" && !panel.help) {
    const previewHeight = Math.min(3, Math.max(1, Math.floor(panel.bodyHeight / 3)));
    const listBudget = panel.bodyHeight - previewHeight - 1;
    const overflow = panel.tree.length > Math.floor(listBudget / 2);
    body = renderList(panel, Math.max(2, listBudget - (overflow ? 1 : 0)), true);
    if (overflow) {
      const last = Math.min(panel.tree.length, panel.listStart + panel.listHeight / 2);
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
    panel.listHeight = 0;
    if (panel.help) {
      panel.helpContent = right;
      panel.helpScroll.updateLayout(right.length, panel.bodyHeight, panel.redraw);
      body = right.slice(panel.helpScroll.scrollTop, panel.helpScroll.scrollTop + panel.bodyHeight);
    } else body = output(panel, view, inner, panel.bodyHeight).slice(0, panel.bodyHeight);
  }
  while (body.length < panel.bodyHeight) body.push("");
  panel.navHits = [];
  panel.filterHits = [];
  const nav = panel.help
    ? panel.theme.fg("muted", "Help")
    : panel.mode === "preview"
      ? panel.wide
        ? `${filters(panel, panel.listWidth)}   ${navigation(panel, rightWidth)}`
        : filters(panel, inner)
      : navigation(panel, inner);
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
    panel.inputY = lines.length;
    lines.push(line(panel.input.render(inner)[0] ?? ""));
  } else if (panel.confirmStop)
    lines.push(
      line(
        panel.theme.fg(
          "warning",
          `Stop “${taskTitle(panel.confirmStop)}” and its children?  y / n`,
        ),
      ),
    );
  else if (panel.message) lines.push(line(panel.theme.fg("warning", panel.message)));
  else if (panel.busy) lines.push(line(panel.theme.fg("dim", "Applying action…")));
  lines.push(rule("├", "┤"));
  panel.footerY = lines.length;
  lines.push(line(actions(panel, view, inner)), rule("╰", "╯"));
  return lines.map((text) => truncateToWidth(text, width));
}

/**
 * Fill the pane with one header, a scrollable body, and pinned controls.
 * Padding every row prevents the parent transcript from showing through.
 */

function renderReadingPane(panel: Supervisor, width: number): string[] {
  const height = Math.max(1, panel.tui.terminal.rows);
  if (height < 7 || width < 28) {
    const lines = renderCompact(panel, width, height);
    while (lines.length < height) lines.push("");
    return lines.map((line) => fit(line, width));
  }
  panel.contentX = 2;
  panel.headerY = -1;
  panel.navY = 0;
  panel.bodyY = 3;
  panel.inputY = -1;
  panel.listHeight = 0;
  panel.wide = false;
  panel.filterHits = [];
  const inner = Math.max(1, width - 4);
  const extra = panel.composer ? 2 : panel.confirmStop || panel.message || panel.busy ? 1 : 0;
  panel.bodyHeight = Math.max(1, height - 5 - extra);
  const view = panel.selected();
  const badge = view ? agentBadge(view) : undefined;
  const back = panel.help
    ? "← Back"
    : panel.mode === "details" && panel.detailsFromConversation
      ? "← Conversation"
      : "← Agents";
  panel.navHits = [
    { start: panel.contentX, end: panel.contentX + visibleWidth(back), key: "escape" },
  ];
  const name = view
    ? panel.theme.bold(view.name) +
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
    panel.helpScroll.updateLayout(panel.helpContent.length, panel.bodyHeight, panel.redraw);
    body = panel.helpContent.slice(
      panel.helpScroll.scrollTop,
      panel.helpScroll.scrollTop + panel.bodyHeight,
    );
  } else if (!view) body = ["No conversation selected."];
  else if (panel.mode === "details") body = renderDetails(panel, view, inner, panel.bodyHeight);
  else
    body = panel.conversation.render(
      view,
      inner,
      panel.bodyHeight,
      panel.service.catalog.settings.viewerMarkdown,
      true,
    );
  for (let row = 0; row < panel.bodyHeight; row++) lines.push(line(body[row] ?? ""));
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
    panel.inputY = lines.length;
    lines.push(line(panel.input.render(inner)[0] ?? ""));
  } else if (panel.confirmStop)
    lines.push(line(panel.theme.fg("warning", "Stop this agent and its children? y / n")));
  else if (panel.message) lines.push(line(panel.theme.fg("warning", panel.message)));
  else if (panel.busy) lines.push(line(panel.theme.fg("dim", "Applying action…")));
  lines.push(rule);
  panel.footerY = lines.length;
  lines.push(line(actions(panel, view, inner)));
  return lines.map((text) => fit(text, width));
}

function renderCompact(panel: Supervisor, width: number, height: number): string[] {
  panel.contentX = 0;
  panel.headerY = height <= 3 ? -1 : 0;
  panel.navY = -1;
  panel.expandX = Math.max(0, width - 12);
  panel.navHits = [];
  panel.filterHits = [];
  panel.actionHits = [];
  panel.listHeight = 0;
  panel.bodyY = 1;
  panel.inputY = -1;
  panel.bodyHeight = Math.max(1, height - 2);
  const view = panel.selected();
  let lines = height <= 3 ? [] : [panel.theme.fg("accent", panel.theme.bold("Agents"))];
  panel.bodyY = lines.length;
  if (panel.composer) {
    if (height <= 2) lines = [];
    panel.inputY = lines.length;
    lines.push(panel.input.render(width)[0] ?? "");
  } else if (panel.confirmStop) lines.push("Stop this agent and its children? y / n");
  else if (panel.help) {
    panel.helpContent = helpLines(panel.theme, panel.tui.mode === "fullscreen", width);
    panel.helpScroll.updateLayout(panel.helpContent.length, panel.bodyHeight, panel.redraw);
    lines.push(
      ...panel.helpContent.slice(
        panel.helpScroll.scrollTop,
        panel.helpScroll.scrollTop + panel.bodyHeight,
      ),
    );
  } else lines.push(...output(panel, view, width, panel.bodyHeight).slice(0, panel.bodyHeight));
  lines = lines.slice(0, Math.max(1, height - 1));
  if (height > 1) {
    panel.footerY = lines.length;
    lines.push(actions(panel, view, width));
  } else panel.footerY = -1;
  return lines.map((line) => truncateToWidth(line, width));
}
