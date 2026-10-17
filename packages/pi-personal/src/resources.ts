import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  ScrollView,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type ResourceSnapshot = {
  context: string[];
  skills: string[];
  extensions: string[];
  tools: { name: string; description: string; active: boolean }[];
};

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function resourceName(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  const file = parts.at(-1) ?? path;
  if (file === "index.ts" || file === "index.js") return parts.at(-2) ?? file;
  return file.replace(/\.[cm]?[jt]sx?$/i, "");
}

async function collectResources(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<ResourceSnapshot> {
  const tools = pi.getAllTools();
  const activeTools = new Set(pi.getActiveTools());
  const extensionPaths = new Set<string>();
  try {
    const extensionDir = dirname(fileURLToPath(import.meta.url));
    for (const entry of await readdir(extensionDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.[cm]?[jt]sx?$/i.test(entry.name)) {
        extensionPaths.add(join(extensionDir, entry.name));
      }
    }
  } catch {
    // The extension directory may not be readable.
  }

  for (const command of pi.getCommands()) {
    if (command.source === "extension") extensionPaths.add(command.sourceInfo.path);
  }
  for (const tool of tools) {
    if (tool.sourceInfo.source !== "builtin" && tool.sourceInfo.source !== "sdk") {
      extensionPaths.add(tool.sourceInfo.path);
    }
  }

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
    skills: pi
      .getCommands()
      .filter((command) => command.source === "skill")
      .map((command) => command.name.replace(/^skill:/, ""))
      .toSorted(),
    extensions: [...extensionPaths].map(resourceName).filter(Boolean).toSorted(),
  };
}

function renderResources(snapshot: ResourceSnapshot, theme: Theme, width: number): string[] {
  const contentWidth = Math.max(1, width);
  const heading = (text: string) => theme.fg("mdHeading", theme.bold(text));
  const muted = (text: string) => theme.fg("muted", text);
  const dim = (text: string) => theme.fg("dim", text);
  const accent = (text: string) => theme.fg("accent", text);
  const line = (text = "") => fit(text, contentWidth);
  const lines = [
    line(`${accent("π")} ${heading("Resources")}`),
    line(dim("Detected context, skill commands, and extensions")),
    line(),
  ];

  const sections: Array<[string, string[], string]> = [
    ["Context", snapshot.context, "✓"],
    ["Skills", snapshot.skills, "•"],
    ["Extensions", snapshot.extensions, "•"],
  ];
  for (const [label, items, marker] of sections) {
    lines.push(line(heading(`${label} · ${items.length}`)));
    const entries = wrapTextWithAnsi(
      items.length > 0 ? items.join(", ") : "none detected",
      Math.max(1, contentWidth - 4),
    );
    for (const [index, entry] of entries.entries()) {
      const prefix = index === 0 ? `  ${marker} ` : "    ";
      lines.push(line(`${index === 0 ? accent(prefix) : dim(prefix)}${muted(entry)}`));
    }
    lines.push(line());
  }

  const activeCount = snapshot.tools.filter((tool) => tool.active).length;
  lines.push(line(heading(`Tools · ${snapshot.tools.length} · ${activeCount} active`)));
  for (const tool of snapshot.tools) {
    const status = tool.active ? "active" : "inactive";
    const name = `${accent(tool.name)} ${dim(`[${status}]`)}`;
    for (const entry of wrapTextWithAnsi(name, Math.max(1, contentWidth - 2))) {
      lines.push(line(`  ${entry}`));
    }
    for (const entry of wrapTextWithAnsi(
      tool.description.trim() || "No description provided.",
      Math.max(1, contentWidth - 4),
    )) {
      lines.push(line(`    ${muted(entry)}`));
    }
    lines.push(line());
  }
  if (snapshot.tools.length === 0) lines.push(line(muted("  none registered")));
  return lines;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("resources", {
    description: "Show detected resources and all registered tools with active status",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      const resources = await collectResources(pi, ctx);

      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) => {
          const scroll = new ScrollView(
            {
              render: (width) => renderResources(resources, theme, width),
              invalidate() {},
            },
            { scrollbar: "hidden" },
          );
          let page = 1;
          return {
            render: (width: number) => {
              if (width < 6) return [fit("Resources", width)];
              const panelWidth = Math.min(86, width);
              const contentWidth = panelWidth - 2;
              const border = (text: string) => theme.fg("borderAccent", text);
              const line = (text: string) => border("│") + fit(text, contentWidth) + border("│");
              const lines = scroll.render(contentWidth);
              // Match the overlay's 80% height cap and its two-row margins.
              const height = Math.max(
                4,
                Math.min(Math.floor(tui.terminal.rows * 0.8), tui.terminal.rows - 4),
              );
              page = Math.max(1, height - 3);
              scroll.updateLayout(lines.length, page, () => tui.requestRender());
              const visible = lines.slice(scroll.scrollTop, scroll.scrollTop + page);
              const hint = "↑↓/PgUp/PgDn scroll · Esc/Enter/q close";
              return [
                border("╭" + "─".repeat(contentWidth) + "╮"),
                ...visible.map(line),
                line(theme.fg("dim", hint)),
                border("╰" + "─".repeat(contentWidth) + "╯"),
              ];
            },
            handleInput: (data: string) => {
              if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") {
                done();
                return;
              }
              if (keybindings.matches(data, "tui.select.up")) scroll.scrollBy(-1);
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
            width: "70%",
            minWidth: 46,
            maxHeight: "80%",
            margin: 2,
          },
        },
      );
    },
  });
}
