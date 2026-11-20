import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** A model an agent can run on: one of Pi's available models. */
export type SubagentModel = NonNullable<ExtensionContext["model"]>;

function modelName(model: SubagentModel): string {
  return `${model.provider}/${model.id}`;
}

/** Letters and digits only, so `Opus 5.5` and `claude-opus-5-5` agree on their shared part. */
function plainModelText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Up to five available models that share a word with the request, best first. */
function closestModels(available: readonly SubagentModel[], requested: string): string[] {
  const words = requested.toLowerCase().match(/[a-z]{2,}/g) ?? [];
  return available
    .map((model) => {
      const name = plainModelText(modelName(model));
      return { model, score: words.filter((word) => name.includes(word)).length };
    })
    .filter((candidate) => candidate.score > 0)
    .toSorted((first, second) => second.score - first.score)
    .slice(0, 5)
    .map((candidate) => modelName(candidate.model));
}

/**
 * Finds the one available model a `model` value names. `provider/id` is used as written.
 * Any other name ignores case, spaces, dots, and hyphens, so `opus 5.5` finds `claude-opus-5-5`.
 *
 * The closest kind of match decides: the whole name, then the end of the id, then any part of it.
 * When that leaves models on several providers, the first provider in `preferredProviders` that
 * has exactly one of them is used. Anything still unclear is rejected with the models it could be.
 */
export function findSubagentModel(
  available: readonly SubagentModel[],
  requested: string,
  preferredProviders: readonly string[],
): SubagentModel {
  const written = available.find((model) => modelName(model) === requested);
  if (written) return written;

  const wanted = plainModelText(requested);
  const kindsOfMatch: ((model: SubagentModel) => boolean)[] = [
    (model) => plainModelText(model.id) === wanted || plainModelText(modelName(model)) === wanted,
    (model) => plainModelText(model.id).endsWith(wanted),
    (model) => plainModelText(modelName(model)).includes(wanted),
  ];
  const matches = wanted
    ? (kindsOfMatch
        .map((matchesModel) => available.filter(matchesModel))
        .find((found) => found.length) ?? [])
    : [];

  const [only] = matches;
  if (matches.length === 1 && only) return only;
  if (!matches.length) {
    const closest = closestModels(available, requested);
    const hint = closest.length ? ` Closest available models: ${closest.join(", ")}.` : "";
    throw new Error(`No available model matches "${requested}".${hint}`);
  }

  for (const provider of preferredProviders) {
    const fromProvider = matches.filter((model) => model.provider === provider);
    const [preferred] = fromProvider;
    if (fromProvider.length === 1 && preferred) return preferred;
    // Several models on the preferred provider are still unclear.
    if (fromProvider.length > 1) break;
  }
  const names = matches.slice(0, 8).map(modelName).join(", ");
  throw new Error(
    `Model "${requested}" matches ${matches.length} models: ${names}. Use provider/id, or list the provider to prefer in the subagents.preferredProviders setting.`,
  );
}
