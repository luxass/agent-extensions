import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

export const PIN_ENTRY = "pi-pin";

export interface PinChange {
  targetId: string;
  pinned: boolean;
  label?: string;
}

export interface PinMessage {
  id: string;
  role: string;
  text: string;
  timestamp: string;
  label?: string;
  pinned: boolean;
}

function messageText({ message }: SessionMessageEntry): string | undefined {
  if (message.role === "system") return undefined;
  if (message.role === "bashExecution") return `$ ${message.command}\n\n${message.output}`;
  if (message.role === "branchSummary" || message.role === "compactionSummary")
    return message.summary;
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "image") return `[Image: ${block.mimeType}]`;
      if (block.type === "toolCall") return `[Tool call: ${block.name}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function pinChange(data: unknown): PinChange | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if (!("targetId" in data) || typeof data.targetId !== "string") return undefined;
  if (!("pinned" in data) || typeof data.pinned !== "boolean") return undefined;
  if ("label" in data && data.label !== undefined && typeof data.label !== "string")
    return undefined;
  return {
    targetId: data.targetId,
    pinned: data.pinned,
    label: "label" in data ? (data.label as string | undefined) : undefined,
  };
}

// Pins belong to the whole session, not the current branch. Replay in append order
// so an unpin remains effective even after navigating to an older message.
export function getMessages(entries: readonly SessionEntry[]): PinMessage[] {
  const pins = new Map<string, PinChange>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PIN_ENTRY) continue;
    const change = pinChange(entry.data);
    if (change) pins.set(change.targetId, change);
  }

  const messages: PinMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const text = messageText(entry);
    if (text === undefined || !text.trim()) continue;
    const pin = pins.get(entry.id);
    messages.push({
      id: entry.id,
      role: entry.message.role === "toolResult" ? entry.message.toolName : entry.message.role,
      text,
      timestamp: entry.timestamp,
      label: pin?.pinned ? pin.label : undefined,
      pinned: pin?.pinned ?? false,
    });
  }
  return messages.toReversed();
}

export function resolveMessage(messages: readonly PinMessage[], id: string): PinMessage {
  const exact = messages.find((message) => message.id === id);
  if (exact) return exact;
  const matches = messages.filter((message) => message.id.startsWith(id));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Message ID "${id}" is ambiguous. Use a longer ID.`);
  throw new Error(`Message "${id}" was not found. Run /pin to choose a message.`);
}

export function messageTitle(message: PinMessage): string {
  return message.label || message.text.replace(/\s+/g, " ").trim();
}
