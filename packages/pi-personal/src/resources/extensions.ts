import { homedir } from "node:os";
import { basename, relative, sep } from "node:path";

import type { SourceInfo, Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

function entryPath(source: SourceInfo): string {
  return source.baseDir === undefined ? source.path : relative(source.baseDir, source.path);
}

function shortPath(path: string): string {
  const home = homedir();
  return path.startsWith(home + sep) ? "~" + path.slice(home.length) : path;
}

function packageLabel(source: string): string {
  if (source.startsWith("npm:")) return source.slice(4);
  if (source.startsWith("git:")) return source.slice(4);
  return basename(source);
}

export function renderExtensions(
  sources: SourceInfo[],
  theme: Theme,
  width: number,
  expanded: boolean,
): string[] {
  const lines: string[] = [];
  const local: SourceInfo[] = [];
  const builtin: SourceInfo[] = [];
  const packages = new Map<string, { source: SourceInfo; entries: SourceInfo[] }>();

  for (const source of sources) {
    if (source.source === "builtin") {
      builtin.push(source);
    } else if (source.origin === "package") {
      const key = JSON.stringify([source.source, source.scope, source.baseDir]);
      const group = packages.get(key);
      if (group) group.entries.push(source);
      else packages.set(key, { source, entries: [source] });
    } else {
      local.push(source);
    }
  }

  const heading = (label: string) => {
    if (lines.length > 0) lines.push("");
    lines.push(theme.bold(theme.fg("muted", label)));
  };
  const row = (text: string, indent: number, color: "text" | "dim") => {
    const prefix = " ".repeat(indent);
    for (const line of wrapTextWithAnsi(text, Math.max(1, width - indent))) {
      lines.push(prefix + theme.fg(color, line));
    }
  };

  if (local.length > 0) {
    heading("Local");
    for (const source of local) {
      const label = entryPath(source);
      const sharedLabel = local.some((other) => other !== source && entryPath(other) === label);
      row("• " + (sharedLabel ? shortPath(source.path) + " · " + source.scope : label), 2, "text");
      if (expanded && !sharedLabel) row(shortPath(source.path) + " · " + source.scope, 4, "dim");
    }
  }
  if (packages.size > 0) {
    heading("Packages");
    const sorted = [...packages.values()].toSorted((a, b) =>
      packageLabel(a.source.source).localeCompare(packageLabel(b.source.source)),
    );
    for (const group of sorted) {
      const { source, entries } = group;
      const label = packageLabel(source.source);
      // Shorten only the display label. Group identity always uses full source metadata.
      const sharedLabel = sorted.some(
        (other) => other !== group && packageLabel(other.source.source) === label,
      );
      const display = sharedLabel ? shortPath(source.source) + " · " + source.scope : label;
      const count = entries.length > 1 ? " · " + entries.length + " extensions" : "";
      row((expanded ? "▾ " : "▸ ") + display + count, 2, "text");
      if (expanded && !sharedLabel) row(shortPath(source.source) + " · " + source.scope, 4, "dim");
      if (
        (expanded || sharedLabel) &&
        source.baseDir !== undefined &&
        source.baseDir !== source.source
      ) {
        row(shortPath(source.baseDir), 4, "dim");
      }
      if (expanded) {
        for (const entry of entries) row(entryPath(entry), 4, "dim");
      }
    }
  }
  if (builtin.length > 0) {
    heading("Built-in");
    for (const source of builtin) row("• " + source.path.replace(/^builtin:/, ""), 2, "text");
  }
  if (lines.length === 0) row("No visible extensions loaded.", 0, "dim");
  return lines;
}
