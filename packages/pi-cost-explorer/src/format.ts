import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function money(value: number): string {
  if (value === 0) return "$0";
  const abs = Math.abs(value);
  if (abs < 0.0001) return "<$0.0001";
  if (abs < 0.01) return `$${value.toFixed(4)}`;
  if (abs < 1) return `$${value.toFixed(3)}`;
  if (abs < 1000) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export function tokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${trimZero((value / 1000).toFixed(1))}k`;
  return `${trimZero((value / 1_000_000).toFixed(2))}M`;
}

function trimZero(text: string): string {
  return text.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function percent(fraction: number | undefined): string {
  if (fraction === undefined || !Number.isFinite(fraction)) return "–";
  const value = fraction * 100;
  if (value > 0 && value < 10) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

export function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function clock(timestamp: number): string {
  if (!timestamp) return "--:--";
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** A horizontal bar with eighth-cell precision. */
export function bar(fraction: number, width: number): string {
  if (width <= 0) return "";
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const eighths = Math.round(clamped * width * 8);
  const full = Math.floor(eighths / 8);
  const partial = EIGHTHS[eighths % 8] ?? "";
  return "█".repeat(full) + partial;
}

const SPARKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Groups values into at most `width` buckets and draws their sums. */
export function sparkline(values: readonly number[], width: number): string {
  if (values.length === 0 || width <= 0) return "";
  const buckets = Math.min(width, values.length);
  const sums = Array.from({ length: buckets }, () => 0);
  values.forEach((value, index) => {
    const bucket = Math.min(buckets - 1, Math.floor((index * buckets) / values.length));
    sums[bucket]! += value;
  });
  const peak = Math.max(...sums);
  if (peak <= 0) return SPARKS[0]!.repeat(buckets);
  return sums
    .map((sum) => SPARKS[Math.min(SPARKS.length - 1, Math.floor((sum / peak) * SPARKS.length))]!)
    .join("");
}

/** Truncates or pads text to exactly `width` visible columns. */
export function fit(text: string, width: number, align: "left" | "right" = "left"): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width, "…");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  return align === "right" ? padding + clipped : clipped + padding;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export interface Column<Row> {
  header: string;
  /** Omit for the one flexible column that takes the remaining width. */
  width?: number;
  align?: "left" | "right";
  /** Optional columns are removed, last first, until the table fits. */
  optional?: boolean;
  cell: (row: Row) => string;
}

const GAP = "  ";

/** Lays out rows as aligned columns that fit `width`. */
export function table<Row>(
  columns: readonly Column<Row>[],
  rows: readonly Row[],
  width: number,
): { header: string; lines: string[] } {
  const shown = [...columns];
  const fixedWidth = (flexWidth: number) =>
    shown.reduce((sum, column) => sum + (column.width ?? flexWidth) + GAP.length, -GAP.length);

  while (fixedWidth(12) > width) {
    const index = shown.findLastIndex((column) => column.optional);
    if (index === -1) break;
    shown.splice(index, 1);
  }

  const flexWidth = Math.max(1, width - fixedWidth(0));
  const line = (text: (column: Column<Row>) => string) =>
    fit(
      shown.map((column) => fit(text(column), column.width ?? flexWidth, column.align)).join(GAP),
      width,
    );

  return {
    header: line((column) => column.header),
    lines: rows.map((row) => line((column) => column.cell(row))),
  };
}
