import { homedir } from "node:os";
import { basename, join } from "node:path";

import {
  createRecorder,
  getActiveProfile,
  loadVoiceSettings,
  runDoctor,
  saveVoiceSettings,
  transcribe,
  type DoctorCheck,
  type DoctorCheckId,
  type Recorder,
  type VoiceSettings,
} from "@luxass/agent-voice";
import * as Plugin from "@opencode/plugin/tui/plugin";
import { createDynamic, type TextProps } from "@opentui/solid";

import { copyToClipboard } from "./clipboard";
import { resolveOptions } from "./config";
import { pickLocalModel, promptProfile } from "./profile";
import { promptInputDevice, promptSetup } from "./setup";

const SUBCOMMANDS = [
  { value: "record", description: "start/stop recording, transcribe on stop" },
  { value: "cancel", description: "discard the in-progress recording" },
  { value: "setup", description: "configure transcription and input, then check requirements" },
  { value: "device", description: "select input device" },
  { value: "profile", description: "select transcription profile" },
  { value: "profile add", description: "create a transcription profile" },
  { value: "profile model", description: "change the active profile's model" },
  { value: "doctor", description: "check recording and transcription setup" },
  { value: "status", description: "show profile and input" },
  { value: "help", description: "show voice commands" },
];

const DOCTOR_FIXES: Partial<Record<DoctorCheckId, string>> = {
  device: "run /voice device",
  model: "run /voice profile model",
};

function formatChecks(checks: DoctorCheck[]): string {
  return checks
    .map(({ id, ok, detail, fix }) =>
      ok ? `✓ ${id}: ${detail}` : `✗ ${id}: ${detail} → ${DOCTOR_FIXES[id] ?? fix}`,
    )
    .join("\n");
}

function statusText(settings: VoiceSettings, state = "idle"): string {
  const { name, transcription } = getActiveProfile(settings);
  const model =
    transcription.type === "api"
      ? transcription.model
      : basename(transcription.model ?? "auto model", ".gguf");
  return `voice ${state} · ${name} · ${model} · ${settings.inputDevice?.name ?? "system default"}`;
}

export default Plugin.define({
  id: "opencode-voice.cli",
  setup(ctx) {
    const ui = ctx.ui;
    const options = resolveOptions(ctx.options);
    const configDir =
      process.env.OPENCODE_CONFIG_DIR ??
      join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
    const path =
      process.env.AGENT_VOICE_SETTINGS ??
      options.settingsPath ??
      join(configDir, "voice-settings.json");
    let configuration = loadVoiceSettings(path);
    let recorder: Recorder | undefined;
    let recording: { settings: VoiceSettings; recorder: Recorder } | undefined;
    let busy = false;
    const [status, setStatus] = ctx.storage.memory("status", { initial: { text: "" } });

    ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const props = {
          height: 1,
          minWidth: 0,
          flexShrink: 1,
          wrapMode: "none",
          truncate: true,
          get children() {
            return status.text;
          },
        } satisfies TextProps;
        return createDynamic(
          () => (input.mode === "normal" && status.text ? "text" : undefined),
          props,
        );
      },
    });

    function notify(message: string, variant: "info" | "warning" | "error" = "info"): void {
      ui.toast.show({ message, variant });
    }

    function setupMessage(): string {
      return [
        "Voice needs setup. Run /voice setup.",
        ...configuration.errors.map(({ path: location, message }) => `${location}: ${message}`),
      ].join("\n");
    }

    function save(settings: VoiceSettings): void {
      saveVoiceSettings(path, settings);
      configuration = { settings, errors: [] };
    }

    function showStatus(state = recording ? "● recording" : "idle"): void {
      setStatus((draft) => {
        // Profile, model, and input details belong in /voice status, not the shared footer.
        draft.text = state === "idle" || state === "ready" ? "" : `voice: ${state}`;
      });
    }

    async function setup(): Promise<void> {
      if (recording) {
        notify("Stop recording before running setup", "warning");
        return;
      }

      const draft = await promptSetup(ctx, configuration.settings);
      if (draft === undefined) return;
      const checks = await runDoctor(draft);
      save(draft);
      const ready = checks.every(({ ok }) => ok);
      showStatus(ready ? "ready" : "setup");
      notify(
        ready
          ? "Voice is ready. Press Ctrl+Shift+V or run /voice to record."
          : `Voice profile saved. Finish these requirements before recording:\n${formatChecks(checks.filter(({ ok }) => !ok))}`,
        ready ? "info" : "warning",
      );
    }

    async function offerSetup(message: string): Promise<void> {
      notify(message, configuration.errors.length > 0 ? "warning" : "info");
      if (
        await ui.dialog.confirm({ title: "Voice needs setup", message: "Open voice setup now?" })
      ) {
        await setup();
      }
    }

    async function toggle(): Promise<void> {
      if (busy) return;
      busy = true;
      try {
        if (recording) {
          const active = recording;
          recording = undefined;
          showStatus("transcribing…");
          try {
            const audio = await active.recorder.stop();
            const text = await transcribe(audio, getActiveProfile(active.settings).transcription);
            await copyToClipboard(text);
            notify("Transcription copied; paste it into the composer");
          } finally {
            showStatus();
          }
          return;
        }

        const { settings } = configuration;
        if (!settings) {
          await offerSetup(setupMessage());
          return;
        }
        const checks = await runDoctor(settings);
        if (checks.some(({ ok }) => !ok)) {
          await offerSetup(formatChecks(checks.filter(({ ok }) => !ok)));
          return;
        }

        const active = {
          settings: structuredClone(settings),
          recorder: (recorder ??= await createRecorder()),
        };
        recording = active;
        showStatus("starting…");
        try {
          await active.recorder.start({
            input: active.settings.inputDevice,
            onError: (error) => {
              recording = undefined;
              showStatus();
              notify(`Recording failed: ${error.message}`, "error");
            },
          });
        } catch (error) {
          recording = undefined;
          showStatus();
          throw error;
        }
        if (!active.recorder.isRecording) return;
        showStatus();
        notify(
          `Recording from ${active.settings.inputDevice?.name ?? "system default"}… run again to transcribe`,
        );
      } catch (error) {
        notify(`Voice error: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        busy = false;
      }
    }

    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "voice.record",
          title: "Voice: record/transcribe to clipboard",
          group: "Voice",
          bind: "ctrl+shift+v",
          palette: true,
          run: toggle,
        },
        {
          id: "voice",
          title: "Voice: record or configure",
          description: "Record speech · setup: /voice setup",
          group: "Voice",
          slash: { name: "voice", arguments: true },
          run: async (args = "") => {
            const command = args.trim().replaceAll(/\s+/gu, " ");
            try {
              switch (command) {
                case "":
                case "record": {
                  await toggle();
                  return;
                }
                case "cancel": {
                  if (!recording) return;
                  const active = recording;
                  recording = undefined;
                  await active.recorder.cancel();
                  showStatus();
                  notify("Recording discarded");
                  return;
                }
                case "setup": {
                  await setup();
                  return;
                }
                case "help": {
                  await ui.dialog.alert({
                    title: "Voice commands",
                    message: [
                      "/voice or Ctrl+Shift+V: start or stop recording",
                      "",
                      ...SUBCOMMANDS.map(
                        ({ value, description }) => `/voice ${value}: ${description}`,
                      ),
                    ].join("\n"),
                  });
                  return;
                }
              }

              if (!SUBCOMMANDS.some(({ value }) => value === command)) {
                notify("Unknown voice command. Run /voice help.", "warning");
                return;
              }

              const { settings } = configuration;
              if (!settings) {
                notify(setupMessage(), configuration.errors.length > 0 ? "warning" : "info");
                return;
              }
              switch (command) {
                case "device": {
                  if (recording) {
                    notify("Stop recording before changing the input", "warning");
                    return;
                  }
                  const selected = await promptInputDevice(ui, settings.inputDevice);
                  if (selected === undefined) return;
                  const draft = { ...settings, inputDevice: selected.inputDevice };
                  save(draft);
                  showStatus();
                  notify(`Voice input: ${selected.inputDevice?.name ?? "system default"}`);
                  return;
                }
                case "profile": {
                  const selected = await ui.dialog.select({
                    title: "Voice transcription profile",
                    current: settings.activeProfile,
                    options: Object.keys(settings.profiles).map((name) => ({
                      title: name,
                      value: name,
                    })),
                  });
                  if (selected === undefined) return;
                  const draft = { ...settings, activeProfile: selected };
                  save(draft);
                  showStatus();
                  notify(`Voice profile: ${selected}`);
                  return;
                }
                case "profile add": {
                  const added = await promptProfile(ctx, Object.keys(settings.profiles));
                  if (added === undefined) return;
                  const draft = {
                    ...settings,
                    activeProfile: added.name,
                    profiles: { ...settings.profiles, [added.name]: added.profile },
                  };
                  save(draft);
                  showStatus();
                  notify(`Voice profile: ${added.name}`);
                  return;
                }
                case "profile model": {
                  const { name, transcription } = getActiveProfile(settings);
                  const model =
                    transcription.type === "api"
                      ? (
                          await ui.dialog.prompt({
                            title: `Model for ${name}`,
                            value: transcription.model,
                          })
                        )?.trim()
                      : await pickLocalModel(ctx);
                  if (!model) return;
                  const draft = {
                    ...settings,
                    profiles: { ...settings.profiles, [name]: { ...transcription, model } },
                  };
                  save(draft);
                  showStatus();
                  notify(`Voice profile ${name}: ${model}`);
                  return;
                }
                case "doctor": {
                  const checks = await runDoctor(settings);
                  notify(formatChecks(checks), checks.every(({ ok }) => ok) ? "info" : "warning");
                  return;
                }
                case "status": {
                  notify(
                    statusText(recording?.settings ?? settings, recording ? "● recording" : "idle"),
                  );
                  return;
                }
                default: {
                  notify("Unknown voice command. Run /voice help.", "warning");
                }
              }
            } catch (error) {
              notify(
                `Voice error: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
            }
          },
        },
      ],
      bindings: ["voice.record"],
    }));

    const { settings, errors } = configuration;
    if (settings) {
      showStatus();
    } else {
      showStatus("setup");
    }
    if (errors.length > 0) notify(setupMessage(), "warning");

    return async () => {
      recording = undefined;
      await recorder?.cancel();
    };
  },
});
