import { basename } from "node:path";

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { keyText, VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

interface HeaderOptions {
  theme: Theme;
  width: number;
  project: string;
  model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id" | "reasoning"> | undefined;
  thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  thinkingKey: string;
  resources: boolean;
}

export function renderHeader({
  theme,
  width,
  project,
  model,
  thinking,
  thinkingKey,
  resources,
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
    ...(resources ? [accent("/resources")] : []),
  ];
  // Drop complete hints, not half a shortcut. Keep the final hint available longest.
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
  if (contentWidth >= visibleWidth(hints[hints.length - 1]!)) {
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
          resources: pi.getCommands().some((command) => command.name === "resources"),
        }),
      invalidate() {},
    }));
  });
}
