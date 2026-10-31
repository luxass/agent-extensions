import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isFocusable,
  matchesKey,
  truncateToWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

import type { AgentDefinition, Settings } from "./agents.ts";
import { animationClock, counts } from "./render.ts";
import { openSupervisor } from "./supervisor.ts";
import { thinkingSchema, type AgentService } from "./tools.ts";
import { isSettled, type AgentView } from "./transcript.ts";

/** UI is a subscriber, never a lifecycle owner or an SDK session observer. */
export function attachUi(pi: ExtensionAPI, service: AgentService): () => void {
  const ctx = service.context;
  if (ctx.mode !== "tui") return () => {};
  const widgetKey = "subagents-active";
  let disposed = false;
  let visible = false;
  let interacting = false;
  let closeOverlay: (() => void) | undefined;
  let views: readonly AgentView[] = service.list();
  let active: readonly AgentView[] = [];
  let requestRender: (() => void) | undefined;
  let unsubscribeClock: (() => void) | undefined;

  const redraw = (): void => {
    if (!disposed) requestRender?.();
  };

  const refresh = (): void => {
    if (disposed) return;
    views = service.list();
    const mode = service.catalog.settings.widgetMode;
    active =
      visible || mode === "off"
        ? []
        : views.filter((view) => !isSettled(view.state) && (mode === "all" || view.background));
    const animate = !visible && views.some((view) => !isSettled(view.state));
    if (animate && requestRender && !unsubscribeClock)
      unsubscribeClock = animationClock.subscribe(redraw);
    else if (!animate) {
      unsubscribeClock?.();
      unsubscribeClock = undefined;
    }
    redraw();
  };

  const open = async (selectedId?: string): Promise<void> => {
    if (disposed || interacting) return;
    interacting = true;
    try {
      if (selectedId) service.get(selectedId);
      await openSupervisor(
        ctx,
        service,
        (action) =>
          action === "definitions" ? configurations(ctx, service) : settings(ctx, service),
        selectedId,
        (isVisible, close) => {
          visible = isVisible;
          closeOverlay = close;
          refresh();
        },
      );
    } catch (error) {
      if (!disposed) ctx.ui.notify(String(error), "error");
    } finally {
      interacting = false;
    }
  };

  const roster = (): AutocompleteItem[] =>
    disposed
      ? []
      : [
          { value: "@main", label: "@main", description: "Send to the main conversation" },
          ...service.catalog
            .definitions()
            .filter((definition) => definition.enabled)
            .map((definition) => ({
              value: `@${definition.name}`,
              label: `@${definition.name}`,
              description: definition.description,
            })),
          ...views
            .filter((view) => view.owner.id === service.root.id && !view.owner.attemptId)
            .map((view) => ({
              value: `@${view.name}`,
              label: `@${view.name}`,
              description: `${view.state}: ${view.task}`,
            })),
        ];

  const mentions = (base: AutocompleteProvider): AutocompleteProvider => {
    const ownItems = new WeakSet<AutocompleteItem>();
    return {
      triggerCharacters: [...new Set([...(base.triggerCharacters ?? []), "@"])],

      async getSuggestions(lines, line, col, options) {
        if (!disposed && service.catalog.settings.agentMentions) {
          const prefix = /(?:^|\s)(@[\w.-]*)$/.exec((lines[line] ?? "").slice(0, col))?.[1];
          if (prefix) {
            const items = roster().filter((item) =>
              item.value.toLowerCase().startsWith(prefix.toLowerCase()),
            );
            if (items.length) {
              items.forEach((item) => ownItems.add(item));
              return { prefix, items };
            }
          }
        }
        return base.getSuggestions(lines, line, col, options);
      },

      applyCompletion(lines, line, col, item, prefix) {
        if (!disposed && ownItems.has(item)) {
          const result = [...lines];
          const text = lines[line] ?? "";
          result[line] = text.slice(0, col - prefix.length) + item.value + " " + text.slice(col);
          return {
            lines: result,
            cursorLine: line,
            cursorCol: col - prefix.length + item.value.length + 1,
          };
        }
        return base.applyCompletion(lines, line, col, item, prefix);
      },

      shouldTriggerFileCompletion: (lines, line, col) =>
        base.shouldTriggerFileCompletion?.(lines, line, col) ?? false,
    };
  };

  ctx.ui.addAutocompleteProvider(mentions);

  const previous = ctx.ui.getEditorComponent();
  const restoreInputs: (() => void)[] = [];

  const factory: NonNullable<ReturnType<typeof ctx.ui.getEditorComponent>> = (tui, theme, keys) => {
    const editor = previous ? previous(tui, theme, keys) : new CustomEditor(tui, theme, keys);
    const original = editor.handleInput;

    const wrapped = (data: string): void => {
      if (
        !disposed &&
        !visible &&
        isFocusable(editor) &&
        editor.focused &&
        matchesKey(data, "ctrl+b")
      ) {
        const foreground = views.find(
          (view) =>
            view.owner.id === service.root.id &&
            !view.owner.attemptId &&
            !view.background &&
            !isSettled(view.state) &&
            view.state !== "settling",
        );
        if (foreground && service.handoff(foreground.id, foreground.attemptId)) return;
      }
      original.call(editor, data);
    };

    editor.handleInput = wrapped;
    restoreInputs.push(() => {
      if (editor.handleInput === wrapped) editor.handleInput = original;
    });
    return editor;
  };

  const draft = ctx.ui.getEditorText();
  ctx.ui.setEditorComponent(factory);
  ctx.ui.setEditorText(draft);

  ctx.ui.setWidget(
    widgetKey,
    (tui: TUI): Component & { dispose(): void } => {
      const request = (): void => tui.requestRender();

      requestRender = request;
      refresh();
      return {
        render(width) {
          if (disposed || visible || !active.length) return [];
          const summary = counts(active);
          const parts = [
            summary.running ? `${summary.running} running` : "",
            summary.waiting ? `${summary.waiting} waiting` : "",
            summary.queued ? `${summary.queued} queued` : "",
          ].filter(Boolean);
          const frame = ["◌", "◦", "○", "◦"][Math.floor(Date.now() / 150) % 4];
          return [
            truncateToWidth(
              ctx.ui.theme.fg("dim", `${frame} Agents · ${parts.join(" · ")}`),
              width,
            ),
          ];
        },

        handleMouse(event) {
          if (event.type !== "click" || event.button !== "left" || !active.length) return undefined;
          void open(active[0]?.id);
          return { handled: true, render: true };
        },

        invalidate() {},

        dispose() {
          if (requestRender === request) {
            requestRender = undefined;
            unsubscribeClock?.();
            unsubscribeClock = undefined;
          }
        },
      };
    },
    { placement: "aboveEditor" },
  );

  const unsubscribe = service.subscribe(refresh);
  const offInput = pi.on("input", async (event, inputCtx) => {
    if (
      disposed ||
      inputCtx.mode !== "tui" ||
      event.source !== "interactive" ||
      !service.catalog.settings.agentMentions
    )
      return { action: "continue" };
    const match = /^@([\w.-]+)(?:\s+([\s\S]*))?$/.exec(event.text.trim());
    if (!match) return { action: "continue" };
    const target = match[1]!;
    const prompt = match[2]?.trim() ?? "";
    if (target === "main") return { action: "transform", text: prompt, images: event.images };
    const rootRuns = views.filter(
      (view) => view.owner.id === service.root.id && !view.owner.attemptId,
    );
    const known =
      rootRuns.some(
        (view) => view.id === target || view.name.toLowerCase() === target.toLowerCase(),
      ) ||
      service.catalog
        .definitions()
        .some(
          (definition) =>
            definition.enabled && definition.name.toLowerCase() === target.toLowerCase(),
        );
    if (!known) return { action: "continue" };

    const reject = (reason: string): { action: "handled" } => {
      inputCtx.ui.notify(reason, "warning");
      inputCtx.ui.setEditorText(event.text);
      return { action: "handled" };
    };

    if (!prompt) return reject("Add a task after the agent mention.");
    if (event.images?.length)
      return reject("Agent mentions accept text only. Use @main to send image attachments.");
    try {
      await service.mention(target, prompt);
      return { action: "handled" };
    } catch (error) {
      return reject(String(error));
    }
  });
  pi.registerCommand("agents", {
    description: "Open the live agent supervisor, conversations, definitions, and settings",

    handler: async (args) => {
      await open(args.trim() || undefined);
    },
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    closeOverlay?.();
    closeOverlay = undefined;
    unsubscribe();
    unsubscribeClock?.();
    unsubscribeClock = undefined;
    offInput();
    offShutdown();
    for (const restore of restoreInputs) restore();
    restoreInputs.length = 0;
    if (ctx.ui.getEditorComponent() === factory) {
      const text = ctx.ui.getEditorText();
      ctx.ui.setEditorComponent(previous);
      ctx.ui.setEditorText(text);
    }
    ctx.ui.setWidget(widgetKey, undefined);
    requestRender = undefined;
    views = [];
    active = [];
  };

  const offShutdown = pi.on("session_shutdown", dispose);
  refresh();
  return dispose;
}

async function editDefinition(
  ctx: ExtensionContext,
  service: AgentService,
  original?: AgentDefinition,
): Promise<void> {
  const name = original?.name ?? (await ctx.ui.input("Agent name", "my-agent"));
  if (!name) return;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name))
    throw new Error("Use letters, numbers, underscores, or hyphens in the agent name.");
  const description = await ctx.ui.editor("Description", original?.description ?? "");
  if (description === undefined) return;
  const prompt = await ctx.ui.editor("System prompt", original?.prompt ?? "");
  if (prompt === undefined) return;
  if (!description.trim() || !prompt.trim())
    throw new Error("Description and system prompt must not be empty.");
  const draft: AgentDefinition = original
    ? { ...original, description, prompt }
    : {
        name,
        description,
        prompt,
        source: "project",
        enabled: true,
        disallowedTools: [],
        allowedSubagents: [],
        skills: [],
      };
  // Clone the full definition: editing does not discard display_name/prompt_mode compatibility fields.
  if (draft.source === "builtin" || draft.source === "package") {
    draft.source = "project";
    delete draft.file;
    delete draft.packageName;
  }
  while (true) {
    const action = await ctx.ui.select(`Edit ${name}`, [
      "Save",
      "Display name",
      "Prompt mode",
      "Allowed tools",
      "Denied tools",
      "Allowed subagents",
      "Skills",
      "Model",
      "Thinking",
      "Memory",
      "Turn limit",
      "Isolation",
    ]);
    if (action === undefined) return;
    if (action === "Save") {
      await service.catalog.saveDefinition(draft);
      service.changed();
      ctx.ui.notify(`Saved ${name}`, "info");
      return;
    }
    if (action === "Prompt mode") {
      const value = await ctx.ui.select("System instructions", ["append", "replace"]);
      if (value === "append" || value === "replace") draft.promptMode = value;
    } else if (action === "Thinking") {
      const levels = thinkingSchema.anyOf.map((option) => option.const);
      const value = await ctx.ui.select("Thinking", ["default", ...levels]);
      if (value === "default") delete draft.thinking;
      else {
        const selected = levels.find((level) => level === value);
        if (selected !== undefined) draft.thinking = selected;
      }
    } else if (action === "Memory") {
      const value = await ctx.ui.select("Memory scope", ["off", "project", "local", "user"]);
      if (value === "off") delete draft.memory;
      else if (value === "project" || value === "local" || value === "user") draft.memory = value;
    } else if (action === "Isolation") {
      const value = await ctx.ui.select("Isolated context", ["default", "yes", "no"]);
      if (value === "default") delete draft.isolated;
      else if (value) draft.isolated = value === "yes";
    } else if (action === "Turn limit") {
      const value = await ctx.ui.editor(
        "Turn limit (blank = default; 0 = unlimited)",
        draft.maxTurns?.toString() ?? "",
      );
      if (value === undefined) continue;
      if (!value.trim()) delete draft.maxTurns;
      else if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value)))
        draft.maxTurns = Number(value);
      else ctx.ui.notify("Enter a nonnegative whole number.", "warning");
    } else if (action === "Display name" || action === "Model") {
      const key = action === "Model" ? "model" : "displayName";
      const value = await ctx.ui.editor(`${action} (blank = default)`, draft[key] ?? "");
      if (value !== undefined) {
        if (value.trim()) draft[key] = value.trim();
        else delete draft[key];
      }
    } else {
      const key =
        action === "Allowed tools"
          ? "tools"
          : action === "Denied tools"
            ? "disallowedTools"
            : action === "Allowed subagents"
              ? "allowedSubagents"
              : "skills";
      const value = await ctx.ui.editor(
        `${action} (comma-separated${key === "tools" ? "; blank = inherited" : ""})`,
        draft[key]?.join(", ") ?? "",
      );
      if (value !== undefined) {
        const items = value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        if (key === "tools" && !items.length) delete draft.tools;
        else draft[key] = items;
      }
    }
  }
}

async function configurations(ctx: ExtensionContext, service: AgentService): Promise<void> {
  while (true) {
    const definitions = service.catalog.definitions();
    const choices = [
      "Create definition",
      ...definitions.map(
        (definition) =>
          `${definition.enabled ? "on" : "off"} · ${definition.name} · ${definition.source} — ${definition.description}`,
      ),
    ];
    const selected = await ctx.ui.select("Agent definitions", choices);
    if (!selected) return;
    try {
      if (selected === choices[0]) {
        await editDefinition(ctx, service);
        continue;
      }
      const definition = definitions[choices.indexOf(selected) - 1];
      if (!definition) continue;
      const action = await ctx.ui.select(definition.displayName ?? definition.name, [
        ...(definition.enabled ? ["Run"] : []),
        "View prompt",
        ...(definition.source === "package" || definition.source === "builtin"
          ? ["Eject to project"]
          : ["Edit definition"]),
        definition.enabled ? "Disable" : "Enable",
      ]);
      if (action === "Run") {
        const prompt = await ctx.ui.editor(`Task for ${definition.name}`);
        if (prompt?.trim())
          await service.spawn({ prompt, subagent_type: definition.name, run_in_background: true });
      } else if (action === "View prompt")
        await ctx.ui.editor(
          `${definition.name} · saved prompt (view only)`,
          await service.catalog.prompt(definition),
        );
      else if (action === "Edit definition") await editDefinition(ctx, service, definition);
      else if (action === "Eject to project") {
        ctx.ui.notify(await service.catalog.eject(definition.name), "info");
        service.changed();
      } else if (action === "Enable" || action === "Disable") {
        await service.catalog.toggle(definition.name);
        service.changed();
      }
    } catch (error) {
      ctx.ui.notify(String(error), "error");
    }
  }
}

const settingKeys = [
  "maxConcurrent",
  "maxConcurrentForeground",
  "maxConcurrentNestedPerDepth",
  "maxDepth",
  "maxTurns",
  "widgetMode",
  "agentMentions",
  "mentionMode",
  "viewerMarkdown",
  "scopeModels",
  "fallbackSubagent",
  "packageAgents",
] as const satisfies readonly (keyof Settings)[];

const labels: Record<(typeof settingKeys)[number], string> = {
  maxConcurrent: "Top-level background capacity",
  maxConcurrentForeground: "Top-level foreground capacity (0 = unlimited)",
  maxConcurrentNestedPerDepth: "Nested capacity per depth",
  maxDepth: "Maximum depth (main = 0)",
  maxTurns: "Default turn limit",
  widgetMode: "Active status line",
  agentMentions: "Agent mentions",
  mentionMode: "Mention context",
  viewerMarkdown: "Conversation Markdown",
  scopeModels: "Scope models",
  fallbackSubagent: "Fallback agent",
  packageAgents: "Package agent policy",
};

async function settings(ctx: ExtensionContext, service: AgentService): Promise<void> {
  while (true) {
    const current = service.catalog.settings;
    const choices = settingKeys.map((key) => `${labels[key]}: ${JSON.stringify(current[key])}`);
    const selected = await ctx.ui.select("Agent settings", choices);
    if (!selected) return;
    const key = settingKeys[choices.indexOf(selected)];
    if (!key) continue;
    try {
      if (key === "widgetMode") {
        const value = await ctx.ui.select("Active status line", ["all", "background", "off"]);
        if (value === "all" || value === "background" || value === "off")
          await service.catalog.saveSettings({ widgetMode: value });
      } else if (key === "viewerMarkdown") {
        const value = await ctx.ui.select("Conversation Markdown", ["off", "assistant", "all"]);
        if (value === "off" || value === "assistant" || value === "all")
          await service.catalog.saveSettings({ viewerMarkdown: value });
      } else if (key === "mentionMode") {
        const value = await ctx.ui.select("Mention context", ["clone", "direct"]);
        if (value === "clone" || value === "direct")
          await service.catalog.saveSettings({ mentionMode: value });
      } else if (key === "fallbackSubagent") {
        const value = await ctx.ui.select("Fallback agent", ["general-purpose", "none"]);
        if (value === "general-purpose" || value === "none")
          await service.catalog.saveSettings({ fallbackSubagent: value });
      } else if (key === "packageAgents") {
        const value = await ctx.ui.select("Package agents", [
          "All",
          "None",
          "Allow selected packages",
        ]);
        if (!value) continue;
        if (value === "Allow selected packages") {
          const text = await ctx.ui.editor(
            "Package names (comma-separated)",
            Array.isArray(current.packageAgents) ? current.packageAgents.join(", ") : "",
          );
          if (text !== undefined)
            await service.catalog.saveSettings({
              packageAgents: text
                .split(",")
                .map((item) => item.trim())
                .filter(Boolean),
            });
        } else await service.catalog.saveSettings({ packageAgents: value === "All" });
      } else if (key === "agentMentions" || key === "scopeModels") {
        const value = await ctx.ui.select(labels[key], ["on", "off"]);
        if (value) await service.catalog.saveSettings({ [key]: value === "on" });
      } else {
        const text = await ctx.ui.editor(labels[key], String(current[key]));
        if (text === undefined) continue;
        const minimum = key === "maxConcurrent" || key === "maxConcurrentNestedPerDepth" ? 1 : 0;
        const number = Number(text);
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < minimum)
          throw new Error(`Enter a whole number of at least ${minimum}.`);
        await service.catalog.saveSettings({ [key]: number });
      }
      service.changed();
    } catch (error) {
      ctx.ui.notify(String(error), "error");
    }
  }
}
