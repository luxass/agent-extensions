# @luxass/opencode-voice

Record speech and copy the transcription to the clipboard for pasting into [OpenCode](https://opencode.ai)'s composer.

## Install

Add the package to `~/.config/opencode/cli.json`:

```json
{
  "plugins": [{ "package": "@luxass/opencode-voice" }]
}
```

Requires microphone access. Linux also needs `libasound.so.2` and `wl-copy` on Wayland or `xclip` on X11 for clipboard delivery. Run `/voice setup` to choose a local or API transcription profile and an input device. Local transcription uses GGUF models; the model picker can download Whisper or Parakeet models. Local transcription under Bun requires Bun 1.4.0 or later. On older Bun versions, upgrade Bun or choose an API profile to record and transcribe.

The recording shortcut defaults to **Ctrl+Shift+V**. To use a different binding, pass a `keybind` option:

```json
{
  "plugins": [
    {
      "package": "@luxass/opencode-voice",
      "options": { "keybind": "ctrl+alt+v" }
    }
  ]
}
```

Use any OpenCode keybinding. Set `keybind` to `false` to disable the shortcut and use `/voice` only; this is useful when the terminal reserves the default for paste. The setting is read when the TUI starts, so restart OpenCode after changing it.

## Use

Press the configured shortcut (**Ctrl+Shift+V** by default) or run `/voice` to start recording. Requirements are checked before the microphone starts. If something is missing, Voice explains it and offers to open setup. Completing setup does not start recording; press the shortcut or run `/voice` again when you are ready. Press it again to stop, transcribe, and copy the result to the clipboard. Paste it into the composer yourself. The plugin does not send your message for you.

The footer shows a short setup or recording status on one line. Voice hides it when idle and in shell mode. Run `/voice status` for profile, model, and input details.

| Command                | Purpose                                              |
| ---------------------- | ---------------------------------------------------- |
| `/voice`               | Start or stop recording and transcribe on stop.      |
| `/voice cancel`        | Discard the current recording.                       |
| `/voice setup`         | Choose a profile and input, then check requirements. |
| `/voice device`        | Choose an input device or the system default.        |
| `/voice profile add`   | Create a local or API transcription profile.         |
| `/voice profile`       | Switch between saved profiles.                       |
| `/voice profile model` | Change the active profile's model.                   |
| `/voice status`        | Show the current profile and input device.           |
| `/voice help`          | Show the full command list.                          |
| `/voice doctor`        | Check recording and transcription setup.             |

A local profile without an explicit model uses the first GGUF model in `~/.cache/agent-voice`. Set `AGENT_VOICE_MODEL_DIR` to keep models elsewhere. For API transcription, `/voice profile add` asks for the endpoint, model, request format, and **name of an environment variable** holding the API key. Keep the key in your environment, not in the settings file.

Settings are loaded once at plugin startup from OpenCode's configuration directory, using `voice-settings.json`. Set `AGENT_VOICE_SETTINGS`, or the plugin's `settingsPath` option, to use a different file. TypeBox validates known fields, while extra keys are accepted without warnings. If the file is missing, Voice shows a setup hint. If it cannot be loaded or validated, Voice shows the errors and keeps `/voice setup` available. Loading never rewrites the file. Setup saves a complete configuration and updates it in memory; manual file edits require reloading the plugin or restarting OpenCode. A recording keeps the profile it started with.
