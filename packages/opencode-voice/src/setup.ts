import { listInputDevices, type InputDevice, type VoiceSettings } from "@luxass/agent-voice";
import type { DialogSelectOption } from "@opencode/plugin/tui/context";
import type { Context } from "@opencode/plugin/tui/plugin";

import { promptProfile } from "./profile";

/**
 * Select an input without changing settings. An undefined result means cancellation.
 *
 * @param {Context["ui"]} ui - OpenCode dialogs.
 * @param {InputDevice} [current] - Currently saved input.
 * @returns The selected input, including an explicit system default, or undefined on cancellation.
 */
export async function promptInputDevice(
  ui: Context["ui"],
  current?: InputDevice,
): Promise<{ inputDevice: InputDevice | undefined } | undefined> {
  const options: DialogSelectOption<"keep" | "default" | "choose">[] = [
    { title: "System default", value: "default" },
    { title: "Choose input device", value: "choose" },
  ];
  if (current !== undefined) options.unshift({ title: `Keep ${current.name}`, value: "keep" });
  const selected = await ui.dialog.select({ title: "Voice input", options });
  if (selected === undefined) return undefined;
  if (selected === "keep") return { inputDevice: current };
  if (selected === "default") return { inputDevice: undefined };
  const inputDevice = await ui.dialog.select({
    title: "Voice input device",
    current,
    options: (await listInputDevices()).map((device) => ({
      title: device.name,
      description: device.id,
      value: device,
    })),
  });
  return inputDevice === undefined ? undefined : { inputDevice };
}

/**
 * Collect a setup draft. The caller checks and saves it after all dialogs complete.
 *
 * @param {Context} ctx - OpenCode dialogs and footer slots.
 * @param {VoiceSettings} [settings] - Previously saved settings.
 * @returns Complete settings, or undefined on cancellation.
 */
export async function promptSetup(
  ctx: Context,
  settings?: VoiceSettings,
): Promise<VoiceSettings | undefined> {
  const ui = ctx.ui;
  const profiles = settings?.profiles ?? {};
  const existing = Object.keys(profiles);
  type Choice = { type: "existing"; name: string } | { type: "new" };
  const selected: Choice | undefined =
    existing.length === 0
      ? { type: "new" }
      : await ui.dialog.select<Choice>({
          title: "Voice transcription",
          options: [
            ...existing.map((name): DialogSelectOption<Choice> => ({
              title: `Use ${name}`,
              value: { type: "existing", name },
            })),
            { title: "Create new profile", value: { type: "new" } },
          ],
        });
  if (selected === undefined) return undefined;
  let activeProfile: string;
  let nextProfiles = profiles;
  if (selected.type === "new") {
    const added = await promptProfile(ctx, existing);
    if (added === undefined) return undefined;
    activeProfile = added.name;
    nextProfiles = { ...profiles, [added.name]: added.profile };
  } else {
    activeProfile = selected.name;
  }
  const input = await promptInputDevice(ui, settings?.inputDevice);
  return input === undefined
    ? undefined
    : {
        ...settings,
        activeProfile,
        profiles: nextProfiles,
        inputDevice: input.inputDevice,
      };
}
