import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { keyText, VERSION } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const HEADER_MAX_WIDTH = 88;
const LOGO_MIN_WIDTH = 64;
const PI_MASCOT = [
  "      o    ",
  "      |    ",
  "  .---+---.",
  "  | o   o |",
  "  |  \\_/  |",
  "  '-------'",
  "    /   \\  ",
];

type ResourceSnapshot = {
  context: string[];
  skills: string[];
  extensions: string[];
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
  for (const tool of pi.getAllTools()) {
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
    context: context.toSorted(),
    skills: pi
      .getCommands()
      .filter((command) => command.source === "skill")
      .map((command) => command.name.replace(/^skill:/, ""))
      .toSorted(),
    extensions: [...extensionPaths].map(resourceName).filter(Boolean).toSorted(),
  };
}

interface HeaderOptions {
  theme: Theme;
  width: number;
  project: string;
  model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id" | "reasoning"> | undefined;
  thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  thinkingKey: string;
}

export function renderHeader({
  theme,
  width,
  project,
  model,
  thinking,
  thinkingKey,
}: HeaderOptions): string[] {
  if (width < 1) return [""];

  const accent = (text: string) => theme.fg("accent", text);
  const muted = (text: string) => theme.fg("muted", text);
  const dim = (text: string) => theme.fg("dim", text);
  const expanded = width >= LOGO_MIN_WIDTH;
  const border = (text: string) => theme.fg(expanded ? "borderMuted" : "borderAccent", text);
  const version = dim(`v${VERSION}`);
  const title = `${accent("π")} ${theme.bold("Pi")} ${version}`;
  const indent = width >= 44 ? "  " : "";
  const panelWidth = Math.min(expanded ? HEADER_MAX_WIDTH : 72, width - indent.length);
  const boxed = width >= 24;
  const contentWidth = boxed ? panelWidth - 4 : width;
  const separator = dim(" · ");
  const workspace = theme.bold(theme.fg("text", project));
  const modelLabel = model
    ? `${width >= 44 ? dim(`${model.provider}/`) : ""}${theme.fg("text", model.id)}`
    : muted("model pending");
  const thinkingLabel = model?.reasoning ? `${muted("thinking ")}${accent(thinking)}` : "";
  const metadata = [modelLabel, thinkingLabel].filter(Boolean).join(separator);
  const line = (text = "") => `${indent}${border("│")} ${fit(text, contentWidth)} ${border("│")}`;

  const hints = [
    `${accent("/")} ${muted("commands")}`,
    `${accent("!")} ${muted("shell")}`,
    ...(model?.reasoning && thinkingKey
      ? [`${accent(thinkingKey === "shift+tab" ? "⇧Tab" : thinkingKey)} ${muted("thinking")}`]
      : []),
    accent("/resources"),
  ];
  // Drop complete hints, not half a shortcut. Keep /resources available longest.
  const hintWidth = expanded ? contentWidth - 4 : contentWidth;
  while (hints.length > 1 && visibleWidth(hints.join("   ")) > hintWidth) {
    hints.splice(hints.length - 2, 1);
  }

  if (expanded) {
    const logoWidth = Math.max(...PI_MASCOT.map(visibleWidth));
    const detailsWidth = contentWidth - logoWidth - 5;
    const name = theme.bold(theme.fg("text", "Pi"));
    const details = [
      `${name}${" ".repeat(Math.max(1, detailsWidth - visibleWidth(name) - visibleWidth(version)))}${version}`,
      "",
      workspace,
      modelLabel,
      thinkingLabel,
      "",
    ];

    return [
      "",
      `${indent}${border(`╭${"─".repeat(panelWidth - 2)}╮`)}`,
      line(),
      ...PI_MASCOT.map((logo, index) =>
        line(
          `  ${fit(theme.bold(accent(logo)), logoWidth)}   ${fit(details[index] ?? "", detailsWidth)}`,
        ),
      ),
      line(),
      line(`  ${hints.join("   ")}`),
      line(),
      `${indent}${border(`╰${"─".repeat(panelWidth - 2)}╯`)}`,
      "",
    ];
  }

  const session = `${workspace}${separator}${metadata}`;
  const lines: string[] = [];
  if (visibleWidth(session) <= contentWidth) {
    lines.push(session);
  } else {
    lines.push(workspace);
    if (visibleWidth(metadata) <= contentWidth) lines.push(metadata);
    else lines.push(modelLabel, ...(thinkingLabel ? [thinkingLabel] : []));
  }
  if (contentWidth >= visibleWidth("/resources")) {
    if (boxed) lines.push("");
    lines.push(hints.join("   "));
  }

  if (!boxed) return ["", ...[title, ...lines].map((line) => fit(line, width)), ""];

  const label = truncateToWidth(title, panelWidth - 5, "…");
  return [
    "",
    `${indent}${border("╭─ ")}${label}${border(` ${"─".repeat(panelWidth - 5 - visibleWidth(label))}╮`)}`,
    ...lines.map(line),
    `${indent}${border(`╰${"─".repeat(panelWidth - 2)}╯`)}`,
    "",
  ];
}

function renderResources(snapshot: ResourceSnapshot, theme: Theme, width: number): string[] {
  if (width < 6) return [fit("Resources", width)];

  const panelWidth = Math.min(86, width);
  const contentWidth = panelWidth - 2;
  const border = (text: string) => theme.fg("borderAccent", text);
  const heading = (text: string) => theme.fg("mdHeading", theme.bold(text));
  const muted = (text: string) => theme.fg("muted", text);
  const dim = (text: string) => theme.fg("dim", text);
  const accent = (text: string) => theme.fg("accent", text);
  const line = (text = "") => `${border("│")}${fit(text, contentWidth)}${border("│")}`;
  const lines = [
    border(`╭${"─".repeat(panelWidth - 2)}╮`),
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

  lines.push(line(dim("Press Esc, Enter, or q to close")));
  lines.push(border(`╰${"─".repeat(panelWidth - 2)}╯`));
  return lines;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui, theme) => ({
      render: (width: number) =>
        renderHeader({
          theme,
          width,
          project: basename(ctx.cwd) || "workspace",
          model: ctx.model,
          thinking: pi.getThinkingLevel(),
          thinkingKey: keyText("app.thinking.cycle"),
        }),
      invalidate() {},
    }));
  });

  pi.registerCommand("resources", {
    description: "Show detected context, skill commands, and extensions",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      const resources = await collectResources(pi, ctx);

      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => ({
          render: (width: number) => renderResources(resources, theme, width),
          handleInput: (data: string) => {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") {
              done();
            }
            tui.requestRender();
          },
          invalidate() {},
        }),
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
