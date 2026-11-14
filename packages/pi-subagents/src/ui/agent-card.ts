import {
  getMarkdownTheme,
  type MessageRenderer,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";

import { isSubagentFinished, type SubagentRecord } from "../manager.ts";
import type { SubagentResultDetails } from "../results.ts";
import {
  cleanSubagentText,
  firstSubagentLine,
  showsBackgroundHint,
  subagentCounters,
  subagentStatusLabel,
  subagentStatusMark,
} from "./agent-status.ts";

/** One line naming the agent: `Agent explorer · auth-review`. */
export function subagentTitle(
  theme: Theme,
  agentType: string | undefined,
  name: string | undefined,
): string {
  const parts = [agentType, name].filter(Boolean).join(theme.fg("muted", " · "));
  return `${theme.fg("toolTitle", theme.bold("Agent"))}${parts ? ` ${parts}` : ""}`;
}

/**
 * Live progress, then the outcome and one answer line, expandable to the full answer (S8).
 * It reads the record on every render, so it stays current while the agent works.
 */
export class AgentCardBody implements Component {
  private markdown: { text: string; component: Markdown } | undefined;

  constructor(
    private readonly record: () => SubagentRecord | undefined,
    private readonly theme: Theme,
    private readonly expanded: boolean,
    private readonly expandHint: string,
  ) {}

  render(width: number): string[] {
    const record = this.record();
    if (!record) return [];
    const { theme } = this;
    const fit = (line: string) => truncateToWidth(line, width, "…");
    const mark = subagentStatusMark(record, theme);
    if (!isSubagentFinished(record.status)) {
      const lines = [
        fit(
          `${mark} ${cleanSubagentText(record.activity)} ${theme.fg("dim", `· ${subagentCounters(record)}`)}`,
        ),
      ];
      if (showsBackgroundHint(record))
        lines.push(fit(theme.fg("dim", "  (ctrl+b to run in background)")));
      return lines;
    }
    const lines = [
      fit(
        `${mark} ${subagentStatusLabel(record)} ${theme.fg("dim", `· ${subagentCounters(record)}`)}`,
      ),
    ];
    const answer = cleanSubagentText(record.result || record.error || "");
    if (!answer.trim()) return lines;
    if (!this.expanded) {
      const more = answer.trim().includes("\n")
        ? ` ${theme.fg("dim", `(${this.expandHint})`)}`
        : "";
      lines.push(
        fit(
          `  ${theme.fg(record.error && !record.result ? "error" : "text", firstSubagentLine(answer))}${more}`,
        ),
      );
      return lines;
    }
    if (this.markdown?.text !== answer) {
      this.markdown = { text: answer, component: new Markdown(answer, 2, 0, getMarkdownTheme()) };
    }
    return [...lines, ...this.markdown.component.render(width)];
  }

  invalidate(): void {
    this.markdown = undefined;
  }
}

/** Renders delivered background results as the same card, inside a message block (S5, S8). */
export const renderSubagentResultMessage: MessageRenderer<SubagentResultDetails> = (
  message,
  options,
  theme,
) => {
  const records = message.details?.records ?? [];
  if (!records.length) return undefined;
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  const hint = options.keyHint("app.tools.expand", "to expand");
  records.forEach((record, index) => {
    if (index > 0) box.addChild(new Spacer(1));
    box.addChild(new Text(subagentTitle(theme, record.agentType, record.name), 0, 0));
    box.addChild(new AgentCardBody(() => record, theme, options.expanded, hint));
  });
  return box;
};

/** Empty component for a slot that has nothing to show. */
export function emptyComponent(): Component {
  return new Container();
}
