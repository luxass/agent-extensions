# @luxass/opencode-voice

## 0.2.0

### Minor Changes

- [#31](https://github.com/luxass/agent-extensions/pull/31) [`ae07cda`](https://github.com/luxass/agent-extensions/commit/ae07cdaadbd87fac59fcfc194b132d3880018d97) Thanks [@goldenmonkeyrnd](https://github.com/goldenmonkeyrnd)! - Add a `keybind` plugin option for the recording shortcut, and allow disabling it with `false`.

### Patch Changes

- [#32](https://github.com/luxass/agent-extensions/pull/32) [`69da11f`](https://github.com/luxass/agent-extensions/commit/69da11fb207a4d94683e4128cc09a89fac467035) Thanks [@goldenmonkeyrnd](https://github.com/goldenmonkeyrnd)! - Support OpenCode 2.1.1 by updating the OpenCode plugin and OpenTUI catalog versions, and adapting Crow to the current credential and provider settings schema.

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
