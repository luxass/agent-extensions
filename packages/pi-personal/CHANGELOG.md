# @luxass/pi-personal

## 0.1.1

### Patch Changes

- [`2fe569d`](https://github.com/luxass/pi-extensions/commit/2fe569dc848612f47c52d3ddc19482c30b2a01f1) Thanks [@luxass](https://github.com/luxass)! - Redesign the custom header with an ASCII terminal-robot mascot, more spacing, clearer project and model details, and the current thinking level. Respect configured thinking shortcuts and keep session information visible in narrow panes while dropping complete shortcut hints.

  Use terminal-aware wrapping in `/resources` and label inferred resources as detected rather than claiming a complete inventory of loaded resources.

## 0.1.0

### Minor Changes

- [`d7c5bb1`](https://github.com/luxass/pi-extensions/commit/d7c5bb1ff1da86111f608729f3d4b97095208e6f) Thanks [@luxass](https://github.com/luxass)! - Add `@luxass/pi-personal` and migrate the personal Pi extensions from the dotfiles repository into the package:

  - Continue the active task after compaction.
  - Prevent interactive Git editors and block `--no-verify` hook bypasses.
  - Require Socket Firewall for package-manager installs.
  - Guard Wrangler's generated `worker-configuration.d.ts` against manual changes.
  - Show a custom session header and a `/resources` view.
  - Add the Crow CLIProxyAPI provider with login, model discovery, streaming, retry, and proactive compaction support.

  Expose each extension separately in the Pi package manifest so users can select which ones to load.
