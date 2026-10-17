import type { Theme, ToolExposure } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { ResourceSnapshot } from "./snapshot.ts";

const EXPOSURE_HELP: Record<ToolExposure, string> = {
  direct: "Declared to the model and callable from other tools while active.",
  "model-only": "Declared to the model while active. Never callable from other tools.",
  codemode: "Callable from other tools even when inactive. Not normally declared to the model.",
  deferred: "Callable from other tools even when inactive. Tool search can find and activate it.",
  hidden: "Registered but unreachable.",
};

export function renderTools(
  tools: ResourceSnapshot["tools"],
  theme: Theme,
  width: number,
  expanded: boolean,
): string[] {
  if (tools.length === 0) return [theme.fg("muted", "No tools registered.")];

  const lines: string[] = [];
  const row = (text: string, color: "muted" | "dim") => {
    for (const line of wrapTextWithAnsi(text, Math.max(1, width - 2))) {
      lines.push("  " + theme.fg(color, line));
    }
  };
  for (const tool of tools) {
    const status = tool.active ? theme.fg("success", "● active") : theme.fg("dim", "○ inactive");
    const title =
      theme.fg("accent", expanded ? "▾ " : "▸ ") + theme.bold(theme.fg("text", tool.name));
    const exposure = theme.fg("accent", "[" + tool.exposure + "]");
    const metadata = status + "  " + exposure;
    const heading = title + "  " + metadata;
    if (visibleWidth(heading) <= width) lines.push(heading);
    else {
      lines.push(...wrapTextWithAnsi(title, Math.max(1, width)));
      row(metadata, "dim");
    }
    if (expanded) {
      row(tool.description.trim(), "muted");
      row(EXPOSURE_HELP[tool.exposure], "dim");
      lines.push("");
    }
  }
  return lines;
}
