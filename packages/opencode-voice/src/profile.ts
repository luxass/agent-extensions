import { downloadModel, listLocalModels, type TranscriptionProfile } from "@luxass/agent-voice";
import type { Context } from "@opencode/plugin/tui/plugin";
import { createDynamic } from "@opentui/solid";

function download(ctx: Context, name: string): Promise<string> {
  let shown = -1;
  const [status, setStatus] = ctx.storage.memory("download", { initial: { text: "" } });
  setStatus((draft) => {
    draft.text = "";
  });
  const remove = ctx.ui.slot({
    append: "prompt.footer.status",
    render: () =>
      createDynamic(() => "text", {
        get children() {
          return status.text;
        },
      }),
  });
  return downloadModel(name, {
    // Without a Content-Length, treat what arrived as the whole file.
    onProgress: (received, total = received) => {
      const percent = Math.floor((received / total) * 100);
      if (percent === shown) return;
      shown = percent;
      setStatus((draft) => {
        draft.text = `downloading ${name}… ${percent}%`;
      });
    },
  }).finally(remove);
}

/**
 * Pick an installed GGUF model or download one from the catalog.
 *
 * @param {Context} ctx - OpenCode dialogs and footer slots.
 * @returns The selected model path, or undefined on cancellation.
 */
export async function pickLocalModel(ctx: Context): Promise<string | undefined> {
  const selected = await ctx.ui.dialog.select({
    title: "Local GGUF model",
    options: listLocalModels().map((model) => ({
      title: model.installed ? model.name : `Download ${model.name} (${model.approxMB} MB)`,
      value: model,
    })),
  });
  if (selected === undefined) return undefined;
  return selected.installed ? selected.path : download(ctx, selected.name);
}

async function promptLocal(ctx: Context): Promise<TranscriptionProfile | undefined> {
  const model = await pickLocalModel(ctx);
  if (model === undefined) return undefined;
  const language = await ctx.ui.dialog.prompt({
    title: "Language code (blank for auto)",
    value: "en",
  });
  if (language === undefined) return undefined;
  return { type: "local", model, language: language.trim() || undefined };
}

async function promptApi(ui: Context["ui"]): Promise<TranscriptionProfile | undefined> {
  const endpoint = (
    await ui.dialog.prompt({ title: "API endpoint", value: "https://api.openai.com/v1" })
  )?.trim();
  if (!endpoint) return undefined;
  const model = (await ui.dialog.prompt({ title: "Model", value: "whisper-1" }))?.trim();
  if (!model) return undefined;
  const apiKeyEnv = await ui.dialog.prompt({
    title: "API key environment variable (blank for none)",
    value: "OPENAI_API_KEY",
  });
  if (apiKeyEnv === undefined) return undefined;
  const format = await ui.dialog.select<
    NonNullable<Extract<TranscriptionProfile, { type: "api" }>["format"]>
  >({
    title: "Request format",
    options: [
      { title: "multipart", value: "multipart" },
      { title: "openrouter", value: "openrouter" },
    ],
  });
  if (format === undefined) return undefined;
  return {
    type: "api",
    endpoint,
    model,
    format,
    apiKeyEnv: apiKeyEnv.trim() || undefined,
  };
}

/**
 * Ask for a profile name and transcription settings. Cancellation returns undefined.
 *
 * @param {Context} ctx - OpenCode dialogs and footer slots.
 * @param {readonly string[]} existing - Profile names already in settings.
 * @returns A named profile, or undefined on cancellation.
 */
export async function promptProfile(
  ctx: Context,
  existing: readonly string[],
): Promise<{ name: string; profile: TranscriptionProfile } | undefined> {
  const ui = ctx.ui;
  const name = (
    await ui.dialog.prompt({ title: "Profile name", placeholder: "e.g. local, groq" })
  )?.trim();
  if (!name) return undefined;
  if (
    existing.includes(name) &&
    !(await ui.dialog.confirm({ title: "Replace profile", message: `Replace "${name}"?` }))
  )
    return undefined;
  const selected = await ui.dialog.select<TranscriptionProfile["type"]>({
    title: "Transcription",
    options: [
      { title: "local", value: "local" },
      { title: "api", value: "api" },
    ],
  });
  if (selected === undefined) return undefined;
  const profile = selected === "local" ? await promptLocal(ctx) : await promptApi(ui);
  return profile && { name, profile };
}
