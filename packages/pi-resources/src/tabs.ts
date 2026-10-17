import type { ResourceSnapshot } from "./resources.ts";

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
