import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  LoadExtensionsResult,
  SourceInfo,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  Key,
  matchesKey,
  ScrollView,
  truncateToWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type ResourceSnapshot = {
  context: string[];
  skills: string[];
  extensions: SourceInfo[];
  tools: { name: string; description: string; active: boolean }[];
};

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function collectResources(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  extensions: LoadExtensionsResult["extensions"],
): ResourceSnapshot {
  const commands = pi.getCommands();
  const tools = pi.getAllTools();
  const activeTools = new Set(pi.getActiveTools());

  const context: string[] = [];
  let directory = resolve(ctx.cwd);
  while (true) {
    for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(directory, filename);
      if (existsSync(path)) context.push(relative(ctx.cwd, path) || filename);
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return {
    tools: tools
      .map(({ name, description }) => ({ name, description, active: activeTools.has(name) }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
    context: context.toSorted(),
    skills: commands
      .filter((command) => command.source === "skill")
      .map((command) => command.name.replace(/^skill:/, ""))
      .toSorted(),
    extensions: extensions
      .filter((extension) => !extension.hidden)
      .map((extension) => extension.sourceInfo)
      .toSorted((a, b) => a.path.localeCompare(b.path)),
  };
}

const RESOURCE_TABS = ["Tools", "Context", "Skills", "Extensions"] as const;
type ResourceTab = (typeof RESOURCE_TABS)[number];

function tabCount(snapshot: ResourceSnapshot, tab: ResourceTab): number {
  if (tab === "Tools") return snapshot.tools.length;
  if (tab === "Context") return snapshot.context.length;
  if (tab === "Skills") return snapshot.skills.length;
  return snapshot.extensions.length;
}

function renderResourceBody(
  snapshot: ResourceSnapshot,
  tab: ResourceTab,
  theme: Theme,
  width: number,
): string[] {
  const lines: string[] = [];
  const wrap = (text: string, indent: number, color: "text" | "muted" | "dim") => {
    for (const entry of wrapTextWithAnsi(text, Math.max(1, width - indent))) {
      lines.push(" ".repeat(indent) + theme.fg(color, entry));
    }
  };
  if (tab === "Tools") {
    if (snapshot.tools.length === 0) wrap("No tools registered.", 0, "muted");
    for (const tool of snapshot.tools) {
      const status = tool.active ? theme.fg("success", "● active") : theme.fg("dim", "○ inactive");
      const title = theme.bold(theme.fg("text", tool.name));
      for (const entry of wrapTextWithAnsi(title + "  " + status, Math.max(1, width))) {
        lines.push(entry);
      }
      wrap(tool.description.trim(), 2, "muted");
      lines.push("");
    }
    return lines;
  }

  if (tab === "Extensions") {
    const groups = new Map<string, SourceInfo[]>();
    for (const source of snapshot.extensions) {
      const key = JSON.stringify([source.source, source.scope, source.origin, source.baseDir]);
      const entries = groups.get(key);
      if (entries) entries.push(source);
      else groups.set(key, [source]);
    }
    if (groups.size === 0) wrap("No visible extensions loaded.", 0, "muted");
    const sorted = [...groups.values()].toSorted((a, b) =>
      a[0]!.source.localeCompare(b[0]!.source),
    );
    for (const entries of sorted) {
      const source = entries[0]!;
      const heading =
        theme.bold(theme.fg("text", source.source)) + theme.fg("dim", " · " + source.scope);
      lines.push(...wrapTextWithAnsi(heading, Math.max(1, width)));
      if (source.origin === "top-level" && source.baseDir !== undefined) {
        wrap(source.baseDir, 2, "dim");
      }
      for (const entry of entries) {
        // baseDir is optional for synthetic and SDK sources. Their supplied path is the identifier.
        const path = entry.baseDir === undefined ? entry.path : relative(entry.baseDir, entry.path);
        wrap(path, 2, "muted");
      }
      lines.push("");
    }
    return lines;
  }

  const items = tab === "Context" ? snapshot.context : snapshot.skills;
  if (items.length === 0) {
    wrap("None detected.", 0, "muted");
    return lines;
  }
  if (tab === "Context") {
    for (const item of items) wrap(item, 0, "text");
    return lines;
  }

  // Read down each column, like a directory listing. Keep every name intact.
  const gap = 3;
  const longest = Math.max(...items.map(visibleWidth));
  const columns = Math.max(1, Math.min(3, Math.floor((width + gap) / (longest + gap))));
  if (columns === 1) {
    for (const item of items) wrap(item, 0, "text");
    return lines;
  }
  const cellWidth = Math.floor((width - gap * (columns - 1)) / columns);
  const rows = Math.ceil(items.length / columns);
  for (let row = 0; row < rows; row++) {
    const cells: string[] = [];
    for (let column = 0; column < columns; column++) {
      const item = items[column * rows + row];
      cells.push(fit(theme.fg("text", item ?? ""), cellWidth));
    }
    lines.push(cells.join(" ".repeat(gap)));
  }
  return lines;
}

export default function (pi: ExtensionAPI) {
  let readExtensions: (() => LoadExtensionsResult) | undefined;
  const prototype = DefaultResourceLoader.prototype;
  // oxlint-disable-next-line typescript/unbound-method -- The interceptor supplies the original receiver with call(this).
  const original = prototype.getExtensions;

  function restore() {
    if (prototype.getExtensions === intercept) prototype.getExtensions = original;
  }

  function intercept(this: DefaultResourceLoader): LoadExtensionsResult {
    const result = original.call(this);
    if (result.extensions.some((extension) => extension.commands.has("resources"))) {
      readExtensions = () => this.getExtensions();
      restore();
    }
    return result;
  }

  // Unsupported bridge: Pi reads this list after loading extensions to build its runtime.
  // Capture that loader once, then leave the shared prototype unchanged.
  prototype.getExtensions = intercept;
  pi.on("session_shutdown", () => restore());

  pi.registerCommand("resources", {
    description: "Browse resources and registered tools in a tabbed dialog",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      if (!readExtensions) {
        ctx.ui.notify(
          "Could not capture Pi’s resource loader. Reload Pi before using /resources.",
          "error",
        );
        return;
      }
      const resources = collectResources(pi, ctx, readExtensions().extensions);

      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => {
          let tab = 0;
          let page = 1;
          let mouseWidth = 0;
          let targets: { index: number; start: number; end: number }[] = [];
          const scroll = new ScrollView(
            {
              render: (width) => renderResourceBody(resources, RESOURCE_TABS[tab]!, theme, width),
              invalidate() {},
            },
            { scrollbar: "hidden" },
          );
          const switchTab = (index: number) => {
            tab = (index + RESOURCE_TABS.length) % RESOURCE_TABS.length;
            scroll.scrollToStart();
            tui.requestRender();
          };
          const navigation = (width: number): string[] => {
            targets = [];
            const available = width - (RESOURCE_TABS.length - 1);
            const size = Math.floor(available / RESOURCE_TABS.length);
            const remainder = available % RESOURCE_TABS.length;
            let column = 2;
            const cells = RESOURCE_TABS.map((label, index) => {
              const cellWidth = size + (index < remainder ? 1 : 0);
              const full = label + " " + tabCount(resources, label);
              const text = visibleWidth(full) <= cellWidth ? full : label;
              const fitted = truncateToWidth(text, cellWidth, "…");
              const padding = cellWidth - visibleWidth(fitted);
              const centered =
                " ".repeat(Math.floor(padding / 2)) + fitted + " ".repeat(Math.ceil(padding / 2));
              targets.push({ index, start: column, end: column + cellWidth });
              column += cellWidth + 1;
              const active = index === tab;
              return {
                title: active
                  ? theme.bold(theme.fg("accent", centered))
                  : theme.fg("muted", centered),
                rail: theme.fg(
                  active ? "accent" : "borderMuted",
                  (active ? "━" : "─").repeat(cellWidth),
                ),
              };
            });
            return [
              cells.map((cell) => cell.title).join(" "),
              cells.map((cell) => cell.rail).join(theme.fg("borderMuted", "─")),
            ];
          };
          return {
            render: (width: number) => {
              mouseWidth = width;
              targets = [];
              const height = Math.min(
                28,
                Math.floor(tui.terminal.rows * 0.8),
                tui.terminal.rows - 4,
              );
              if (width < 24 || height < 10) {
                return [fit("Resize to browse · Esc close", Math.max(0, width))];
              }
              const inner = width - 4;
              const border = (text: string) => theme.fg("borderAccent", text);
              const row = (text = "") => border("│ ") + fit(text, inner) + border(" │");
              const current = RESOURCE_TABS[tab]!;
              const active = resources.tools.filter((tool) => tool.active).length;
              const summary =
                current === "Tools"
                  ? active +
                    " active · " +
                    (resources.tools.length - active) +
                    " inactive · Active tools are declared to the model."
                  : current === "Context"
                    ? "Detected instruction files in this directory and its parents."
                    : current === "Skills"
                      ? "Run a skill with /skill:<name>."
                      : "Loaded extensions grouped by source. Includes event-only extensions; hidden entries are omitted.";
              const wrapped = wrapTextWithAnsi(summary, inner);
              const heading = wrapped
                .slice(0, 2)
                .map((text, index) =>
                  theme.fg(
                    "muted",
                    index === 1 && wrapped.length > 2
                      ? truncateToWidth(text, inner - 1, "") + "…"
                      : text,
                  ),
                );
              const nav = navigation(inner);
              const lines = scroll.render(inner);
              // Keep the tab bar and help visible while the body scrolls.
              page = Math.max(1, Math.min(height - 6 - heading.length, Math.max(4, lines.length)));
              scroll.updateLayout(lines.length, page, () => tui.requestRender());
              const visible = lines.slice(scroll.scrollTop, scroll.scrollTop + page);
              while (visible.length < page) visible.push("");
              const position =
                lines.length > page
                  ? "Rows " +
                    (scroll.scrollTop + 1) +
                    "–" +
                    Math.min(lines.length, scroll.scrollTop + page) +
                    " / " +
                    lines.length
                  : tabCount(resources, current) +
                    (current === "Tools" || current === "Extensions" ? " registered" : " detected");
              const footer = theme.fg(
                "dim",
                truncateToWidth(" " + current + " · " + position + " ", width - 4, "…"),
              );
              const help: [string, string][] = [
                ["Esc", "close"],
                ["←→/Tab", "tabs"],
                ["↑↓", "scroll"],
                ["1–4", "jump"],
                ["PgUp/Dn", "page"],
              ];
              let hints = "";
              for (const [key, label] of help) {
                const hint = theme.fg("accent", key) + theme.fg("dim", " " + label);
                const candidate = hints ? hints + theme.fg("borderMuted", " · ") + hint : hint;
                if (visibleWidth(candidate) <= inner) hints = candidate;
              }
              const title = theme.bold(theme.fg("accent", " Resources "));
              return [
                border("╭─") + title + border("─".repeat(width - 4 - visibleWidth(title)) + "─╮"),
                ...nav.map(row),
                ...heading.map(row),
                row(),
                ...visible.map(row),
                row(hints),
                border("╰─") +
                  footer +
                  border("─".repeat(Math.max(0, width - 4 - visibleWidth(footer))) + "─╯"),
              ];
            },
            handleMouse: (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
              if (event.width !== mouseWidth) return undefined;
              if (event.type === "wheel") {
                scroll.scrollBy(event.wheelDelta ?? 0);
                tui.requestRender();
                // Contain the event even at an edge so the transcript does not scroll.
                return { handled: true, focus: true };
              }
              if (
                event.button !== "left" ||
                event.shift ||
                event.alt ||
                event.ctrl ||
                (event.type !== "press" && event.type !== "click") ||
                (event.y !== 1 && event.y !== 2)
              )
                return undefined;
              const target = targets.find((item) => event.x >= item.start && event.x < item.end);
              if (!target) return undefined;
              if (event.type === "click") switchTab(target.index);
              return { handled: true, focus: true };
            },
            handleInput: (data: string) => {
              if (isKeyRelease(data)) return;
              if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") {
                done();
                return;
              }
              if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) switchTab(tab + 1);
              else if (matchesKey(data, Key.shift(Key.tab)) || matchesKey(data, Key.left))
                switchTab(tab - 1);
              else if (/^[1-4]$/.test(data)) switchTab(Number(data) - 1);
              else if (keybindings.matches(data, "tui.select.up")) scroll.scrollBy(-1);
              else if (keybindings.matches(data, "tui.select.down")) scroll.scrollBy(1);
              else if (keybindings.matches(data, "tui.select.pageUp")) scroll.scrollBy(-page);
              else if (keybindings.matches(data, "tui.select.pageDown")) scroll.scrollBy(page);
              else if (matchesKey(data, Key.home)) scroll.scrollToStart();
              else if (matchesKey(data, Key.end)) scroll.scrollToEnd();
              tui.requestRender();
            },
            invalidate() {
              scroll.invalidate();
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: 100,
            minWidth: 46,
            maxHeight: "80%",
            margin: 2,
          },
        },
      );
    },
  });
}
