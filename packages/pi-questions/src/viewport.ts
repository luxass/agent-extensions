import { ScrollView, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

/** Bounds a ScrollView inside a custom editor component, including mouse routing. */
export class Viewport extends ScrollView {
  maxHeight = 1;
  totalLines = 0;
  followLine?: (lines: string[]) => number | undefined;
  private readonly requestRender: () => void;

  constructor(content: Component, requestRender: () => void) {
    super(content, { scrollbar: "hidden" });
    this.requestRender = requestRender;
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    this.totalLines = lines.length;
    const height = Math.max(1, Math.min(this.maxHeight, Math.max(1, lines.length)));
    this.updateLayout(lines.length, height, this.requestRender);
    const focusLine = this.followLine?.(lines);
    if (focusLine !== undefined && focusLine >= 0) {
      if (focusLine < this.scrollTop) this.scrollTo(focusLine);
      else if (focusLine >= this.scrollTop + height) this.scrollTo(focusLine - height + 1);
    }
    const visible = lines.slice(this.scrollTop, this.scrollTop + height);
    while (visible.length < height) visible.push("");
    return visible;
  }

  override handleMouse(event: TuiMouseEvent) {
    if (event.y < 0 || event.y >= this.viewportHeight) return undefined;
    // ScrollView renders its full child in custom components. Translate once,
    // then let the child containers route the event to their buttons or editor.
    return super.handleMouse({
      ...event,
      y: event.y + this.scrollTop,
      height: this.totalLines,
    });
  }
}
