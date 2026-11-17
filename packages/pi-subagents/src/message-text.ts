/** One part of a message's content. Only text parts have `text`. */
interface SubagentMessagePart {
  type: string;
  text?: string;
}

/**
 * The text of a message's content: its text parts joined by line breaks. Other parts, such as
 * images, thinking, and tool calls, are left out.
 */
export function subagentMessageText(content: string | readonly SubagentMessagePart[]): string {
  if (typeof content === "string") return content;
  return content
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");
}
