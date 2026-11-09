import { compile, lit, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";

export const DEFAULT_KEYBIND = "ctrl+shift+v";

export const voiceOptionsSchema = obj(
  {
    settingsPath: opt(str()),
    keybind: opt(union([lit(false), str({ minLength: 1 })])),
  },
  { open: true },
);

export type VoiceOptions = Static<typeof voiceOptionsSchema>;

const voiceOptionsValidator = compile(voiceOptionsSchema);

/**
 * Validate plugin options while preserving extra keys.
 *
 * @param {unknown} options - OpenCode's plugin options.
 * @returns The validated plugin options.
 * @throws If a known option has an invalid value.
 */
export function resolveOptions(options: unknown): VoiceOptions {
  if (!voiceOptionsValidator.check(options)) {
    const errors = voiceOptionsValidator
      .errors(options)
      .map(({ path, message }) => `${path}: ${message}`)
      .join("\n");
    throw new Error(`Invalid voice options:\n${errors}`);
  }
  return options;
}
