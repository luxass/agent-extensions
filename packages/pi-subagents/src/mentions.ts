import type { AutocompleteProviderFactory } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import type { SubagentDefinition } from "./agents.ts";

const LEADING_TYPE_MENTION = /^@([a-z0-9]+(?:-[a-z0-9]+)*)[ \t]+(\S[\s\S]*)$/;
const TYPING_LEADING_MENTION = /^@([a-z0-9-]*)$/;

/** Custom message type of the hidden instruction that follows a type mention. */
export const SUBAGENT_MENTION_MESSAGE = "subagents-mention";

/**
 * For `@explorer review authentication`, returns a hidden instruction for the main model.
 * Returns undefined when the prompt is not a leading mention of an available type (S2).
 */
export function subagentMentionInstruction(
  prompt: string,
  types: readonly SubagentDefinition[],
): string | undefined {
  const type = LEADING_TYPE_MENTION.exec(prompt)?.[1];
  if (!type || !types.some((definition) => definition.name === type)) return undefined;
  return `The user asked for a new "${type}" agent. Call Agent with subagent_type "${type}", a new task name, and a prompt you prepare from their message. Start a new agent even if other ${type} agents exist.`;
}

/** Adds agent types to `@` completion at the start of the prompt, keeping Pi's file suggestions (S2). */
export function subagentMentionAutocomplete(
  types: () => readonly SubagentDefinition[],
): AutocompleteProviderFactory {
  return (current) => {
    const ours = new WeakSet<AutocompleteItem>();
    return {
      triggerCharacters: current.triggerCharacters,
      shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        const typed =
          cursorLine === 0
            ? TYPING_LEADING_MENTION.exec((lines[0] ?? "").slice(0, cursorCol))
            : null;
        const query = typed?.[1];
        if (query === undefined) return base;
        const matches = types().filter((definition) => definition.name.startsWith(query));
        if (!matches.length) return base;
        const prefix = `@${query}`;
        const names = new Set(matches.map((definition) => definition.name));
        const typeItems = matches.map((definition) => {
          const item: AutocompleteItem = {
            value: `@${definition.name} `,
            label: `@${definition.name}`,
            description: `ask Pi to start ${definition.name} · ${definition.description}`,
          };
          ours.add(item);
          return item;
        });
        // A file with a type's name stays reachable through an explicit path.
        const fileItems =
          base?.prefix === prefix
            ? base.items.map((item) => {
                const path = item.value.replace(/^@/, "").replace(/\/$/, "");
                if (!names.has(path)) return item;
                return {
                  value: `@./${item.value.replace(/^@/, "")}`,
                  label: item.label,
                  description: item.description,
                };
              })
            : [];
        return { prefix, items: [...typeItems, ...fileItems] };
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        if (!ours.has(item))
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        const line = lines[cursorLine] ?? "";
        const start = cursorCol - prefix.length;
        const next = [...lines];
        next[cursorLine] = line.slice(0, start) + item.value + line.slice(cursorCol);
        return { lines: next, cursorLine, cursorCol: start + item.value.length };
      },
    };
  };
}
