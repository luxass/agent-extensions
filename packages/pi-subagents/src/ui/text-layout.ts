import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** One line of exactly `width` columns: line breaks become spaces, and the text is cut or padded. */
export function fitLine(text: string, width: number): string {
  const value = truncateToWidth(text.replace(/[\r\n\t]+/g, " "), Math.max(0, width));
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

/**
 * Cuts unstyled text to `width` columns and ends a cut text with "…". Unlike `truncateToWidth`
 * it adds no color reset, so the result can be colored and sit on a background.
 */
export function cutPlainText(text: string, width: number): string {
  const line = text.replace(/[\r\n\t]+/g, " ");
  if (visibleWidth(line) <= width) return line;
  if (width <= 0) return "";
  let cut = "";
  for (const character of line) {
    if (visibleWidth(cut + character) > width - 1) break;
    cut += character;
  }
  return `${cut}…`;
}

/** `left` and `right` at the two ends of a line. `left` is cut when both do not fit. */
export function lineEnds(left: string, right: string, width: number): string {
  const room = Math.max(0, width - visibleWidth(right) - 2);
  return `${fitLine(left, room)}  ${right}`;
}
