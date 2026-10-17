const KEY_LABELS: Record<string, string> = {
  escape: "Esc",
  enter: "Enter",
  tab: "Tab",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageUp: "PgUp",
  pageDown: "PgDn",
  home: "Home",
  end: "End",
  ctrl: "Ctrl",
  shift: "Shift",
  alt: process.platform === "darwin" ? "Option" : "Alt",
};

export function keyLabels(keys: readonly string[]): string {
  return [...new Set(keys)]
    .map((key) =>
      key
        .split("+")
        .map((part) => KEY_LABELS[part] ?? part)
        .join("+"),
    )
    .join("/");
}
