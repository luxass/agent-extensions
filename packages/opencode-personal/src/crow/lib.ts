import { Model, Provider } from "@opencode/plugin";
import { Schema } from "effect";

export const PROVIDER_ID = Provider.ID.make("crow");
export const DEFAULT_BASE_URL = "http://127.0.0.1:8317";
export const BASE_URL_FIELD = "crowBaseURL";

// CPA wire fields. The rest of the plugin uses Model.Info.
const CPAResponse = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.optionalKey(Schema.String),
      id: Schema.optionalKey(Schema.String),
      display_name: Schema.optionalKey(Schema.String),
      visibility: Schema.optionalKey(Schema.String),
      context_window: Schema.optionalKey(Schema.Number),
      max_context_window: Schema.optionalKey(Schema.Number),
      max_tokens: Schema.optionalKey(Schema.Number),
      input_modalities: Schema.optionalKey(Schema.Array(Schema.String)),
      default_reasoning_level: Schema.optionalKey(Schema.String),
      supported_reasoning_levels: Schema.optionalKey(
        Schema.Array(Schema.Struct({ effort: Schema.String })),
      ),
    }),
  ),
});

const decodeCPAResponse = Schema.decodeUnknownSync(CPAResponse);

export function resolveBaseURL(input: string): string {
  const url = new URL(input);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return `${url.origin}${path}/v1`;
}

export async function fetchModels(
  baseURL: string,
  apiKey: string,
  signal: AbortSignal,
  known: readonly Model.Info[],
): Promise<Model.Info[]> {
  const response = await fetch(`${baseURL}/models?client_version=opencode`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  if (!response.ok) throw new Error(`CPA model discovery failed (HTTP ${response.status})`);

  const { models } = decodeCPAResponse(await response.json());
  return models.flatMap((model): Model.Info[] => {
    const id = (model.slug ?? model.id ?? "").trim();
    if (!id || model.visibility === "hide") return [];

    const template =
      known.find((entry) => entry.modelID === id && entry.providerID === Provider.ID.openai) ??
      known.find((entry) => entry.modelID === id);
    const efforts = (model.supported_reasoning_levels ?? []).map(({ effort }) => effort);
    const effort =
      model.default_reasoning_level ?? (efforts.includes("medium") ? "medium" : efforts[0]);

    return [
      Object.assign(Model.Info.default(PROVIDER_ID, Model.ID.make(id)), {
        name: model.display_name ?? id,
        limit: {
          context: model.context_window ?? model.max_context_window ?? 128_000,
          output: model.max_tokens ?? 16_384,
        },
        capabilities: {
          tools: true,
          input: model.input_modalities ?? ["text"],
          output: ["text"],
        },
        cost: template?.cost ?? [],
        settings: effort ? { reasoningEffort: effort } : undefined,
        variants: efforts.map((level) => ({
          id: Model.VariantID.make(level === "none" ? "off" : level),
          settings: { reasoningEffort: level },
        })),
      }),
    ];
  });
}
