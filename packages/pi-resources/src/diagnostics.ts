import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

import type { LoaderDiagnostic } from "./resources.ts";

export function renderDiagnostics(
  diagnostics: LoaderDiagnostic[],
  theme: Theme,
  width: number,
): string[] {
  if (diagnostics.length === 0) return [theme.fg("muted", "No loader errors or warnings.")];

  const lines: string[] = [];
  const row = (text: string, color: "text" | "dim" | "warning" | "error", indent = 0) => {
    for (const line of wrapTextWithAnsi(text, Math.max(1, width - indent))) {
      lines.push(" ".repeat(indent) + theme.fg(color, line));
    }
  };
  for (const [index, diagnostic] of diagnostics.entries()) {
    // One blank line between entries, never after the last.
    if (index > 0) lines.push("");
    row(
      diagnostic.resource + " · " + diagnostic.type,
      diagnostic.type === "error" ? "error" : "warning",
    );
    row(diagnostic.message, "text", 2);
    if (diagnostic.path !== undefined) row(diagnostic.path, "dim", 2);
    if (diagnostic.collision !== undefined) {
      row("Name: " + diagnostic.collision.name, "dim", 2);
      row("Used: " + diagnostic.collision.winnerPath, "dim", 2);
      row("Ignored: " + diagnostic.collision.loserPath, "dim", 2);
    }
  }
  return lines;
}
