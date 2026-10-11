import { Type } from "typebox";
import * as Value from "typebox/value";

export const voiceOptionsSchema = Type.Object({
  settingsPath: Type.Optional(Type.String()),
});

export type VoiceOptions = Type.Static<typeof voiceOptionsSchema>;

/**
 * Validate plugin options while preserving extra keys.
 *
 * @param {unknown} options - OpenCode's plugin options.
 * @returns The optional settings-file path.
 * @throws If a known option has an invalid value.
 */
export function resolveOptions(options: unknown): VoiceOptions {
  if (!Value.Check(voiceOptionsSchema, options)) {
    const errors = Value.Errors(voiceOptionsSchema, options)
      .map(({ instancePath, message }) => `${instancePath}: ${message}`)
      .join("\n");
    throw new Error(`Invalid voice options:\n${errors}`);
  }
  return options;
}
