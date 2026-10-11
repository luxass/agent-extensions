# @luxass/opencode-voice

## 0.1.2

### Patch Changes

- [`6f759e7`](https://github.com/luxass/agent-extensions/commit/6f759e7e14a5c1f905a61fe30c2360298dc2277b) Thanks [@luxass](https://github.com/luxass)! - Update `@luxass/agent-voice` to 0.5.1. Allow local transcription on Bun 1.4.0 and later instead of rejecting all Bun versions. Update the OpenCode Voice documentation with the supported Bun version.

## 0.1.1

### Patch Changes

- [`0ed3cb4`](https://github.com/luxass/agent-extensions/commit/0ed3cb4256cc1293875b15b49e7970acac2c0d2b) Thanks [@luxass](https://github.com/luxass)! - Keep the Voice footer compact and on one line so it does not crowd OpenCode controls. Hide it when idle or in shell mode, and keep profile, model, and input details in `/voice status`.

  Use a short slash-command description instead of putting every subcommand in the autocomplete row. Add `/voice help` to show the full command list, including before setup.

## 0.1.0

### Minor Changes

- [`79fa52a`](https://github.com/luxass/agent-extensions/commit/79fa52a1e2c90e4981cefe65c72cd163c30f69b9) Thanks [@luxass](https://github.com/luxass)! - Add the OpenCode Voice plugin with microphone recording, API transcription, and clipboard delivery. Include profile and input-device setup, recording controls, status display, and diagnostics. Local transcription is currently unsupported under OpenCode's Bun runtime.
