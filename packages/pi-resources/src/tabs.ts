import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { renderDiagnostics } from "./diagnostics.ts";
import { renderExtensions } from "./extensions.ts";
import type { ResourceSnapshot } from "./resources.ts";
import { renderTools } from "./tools.ts";

export const RESOURCE_TABS = ["Tools", "Context", "Skills", "Extensions", "Diagnostics"] as const;
export type ResourceTab = (typeof RESOURCE_TABS)[number];

// Narrower label sets, tried in order when the full bar does not fit.
export const TAB_LABELS = [
  ["Tools", "Ctx", "Skills", "Ext", "Diag"],
  ["T", "C", "S", "E", "D"],
];

export const EXPANDABLE = new Set<ResourceTab>(["Tools", "Extensions"]);

const UNIT: Record<ResourceTab, string> = {
  Tools: "registered",
  Context: "loaded",
  Skills: "loaded",
  Extensions: "loaded",
  Diagnostics: "issues",
};

const SUMMARY: Record<"Context" | "Skills" | "Diagnostics", string> = {
  Context: "Loaded instruction files and system-prompt sources, in Pi’s loading order.",
  Skills: "Run a skill with /skill:<name>.",
  Diagnostics:
    "Loader errors, warnings, and name collisions across extensions, skills, prompts, and themes.",
};

export function fit(text: string, width: number): string {
  const clipped = truncateToWidth(text, width, "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function tabCount(resources: ResourceSnapshot, tab: ResourceTab): number {
  if (tab === "Tools") return resources.tools.length;
  if (tab === "Context") return resources.context.length;
  if (tab === "Skills") return resources.skills.length;
  if (tab === "Extensions") return resources.extensions.length;
  return resources.diagnostics.length;
}

export function tabUnit(tab: ResourceTab): string {
  return UNIT[tab];
}

export function tabSummary(
  resources: ResourceSnapshot,
  tab: ResourceTab,
  compact: boolean,
  expanded: boolean,
): string {
  if (tab === "Tools") {
    const active = resources.tools.filter((tool) => tool.active).length;
    const counts = `${active} active · ${resources.tools.length - active} inactive`;
    return compact
      ? counts
      : `${counts} · Registered exposure is shown. Per-request tool hiding is not.`;
  }
  if (tab === "Extensions") {
    return compact
      ? "Loaded extensions by source."
      : `Loaded extensions by source. Press e to ${expanded ? "hide" : "show"} full paths and package entries.`;
  }
  return SUMMARY[tab];
}

export function renderTabBody(
  resources: ResourceSnapshot,
  tab: ResourceTab,
  theme: Theme,
  width: number,
  expanded: boolean,
): string[] {
  if (tab === "Tools") return renderTools(resources.tools, theme, width, expanded);
  if (tab === "Extensions") return renderExtensions(resources.extensions, theme, width, expanded);
  if (tab === "Diagnostics") return renderDiagnostics(resources.diagnostics, theme, width);

  const lines: string[] = [];
  const items = tab === "Context" ? resources.context : resources.skills;
  if (items.length === 0) return [theme.fg("muted", "None loaded.")];

  for (const entry of items) {
    for (const line of wrapTextWithAnsi(entry, Math.max(1, width))) {
      lines.push(theme.fg("text", line));
    }
  }
  if (tab !== "Skills" || items.length === 1) return lines;

  // Read down each column, like a directory listing. Keep every name intact.
  const gap = 3;
  const longest = Math.max(...items.map(visibleWidth));
  const columns = Math.max(1, Math.min(3, Math.floor((width + gap) / (longest + gap))));
  if (columns === 1) return lines;

  lines.length = 0;
  const cellWidth = Math.floor((width - gap * (columns - 1)) / columns);
  const rows = Math.ceil(items.length / columns);
  for (let row = 0; row < rows; row++) {
    const cells: string[] = [];
    for (let column = 0; column < columns; column++) {
      cells.push(fit(theme.fg("text", items[column * rows + row] ?? ""), cellWidth));
    }
    lines.push(cells.join(" ".repeat(gap)));
  }
  return lines;
}
