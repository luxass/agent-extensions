# @luxass/pi-personal

## 0.2.0

### Minor Changes

- [#21](https://github.com/luxass/agent-extensions/pull/21) [`cb27bc7`](https://github.com/luxass/agent-extensions/commit/cb27bc7ab41545d5f96a0394510d637f8ff21f11) Thanks [@luxass](https://github.com/luxass)! - Move `/resources` from `@luxass/pi-personal` into the standalone `@luxass/pi-resources` package. Install the new package to keep the command. Preserve the active resource-loader hook and all five tabs while simplifying loader state and tab summaries. The personal header shows the shortcut only when the command is available.

  Use compact tab labels and shorter summaries on small screens. Tools starts collapsed, with `e` to show descriptions and exposure explanations.

## 0.1.3

### Patch Changes

- [#14](https://github.com/luxass/agent-extensions/pull/14) [`5afe207`](https://github.com/luxass/agent-extensions/commit/5afe207807f34b244f726264d870bfd01e8f697c) Thanks [@luxass](https://github.com/luxass)! - Add a model instruction that requires explicit user approval before adding, replacing, or upgrading dependencies. Keep routine installs of existing dependencies allowed through Socket Firewall.

- [#20](https://github.com/luxass/agent-extensions/pull/20) [`38196c2`](https://github.com/luxass/agent-extensions/commit/38196c2c143cb80f17a94b5643f33cb2ac86d9f2) Thanks [@luxass](https://github.com/luxass)! - Extract `/resources` from the custom header into its own extension within the personal package. Show all registered tools with descriptions and active status in a scrollable view.

- [#20](https://github.com/luxass/agent-extensions/pull/20) [`aaa4351`](https://github.com/luxass/agent-extensions/commit/aaa435126b4a463156299d9cbee0451fc49df548) Thanks [@luxass](https://github.com/luxass)! - Redesign `/resources` with Tools, Context, Skills, Extensions, and Diagnostics tabs. Open on Tools and support keyboard navigation, clickable tabs, mouse-wheel scrolling in fullscreen mode, and scroll position indicators. Show skills in compact columns and group extensions into Local, Packages, and Built-in sections using Pi’s source metadata. Show compact extension labels and collapsed packages by default. Add an `e` toggle for full source details and package entry paths, while keeping matching labels distinguishable. Replace the sibling-file scan and command/tool inference with a temporary resource-loader hook that reads loaded context files, skills, and extensions, including event-only extensions. Remove the manual context-file directory scan. Show registered tool exposure, preserve package source identity, format configured keys as readable hints, honor configured confirm/cancel keys, and display loader errors and warnings. Limit the dialog size on large terminals.

## 0.1.2

### Patch Changes

- [`1f3d711`](https://github.com/luxass/agent-extensions/commit/1f3d71168916d0d6a65800b6e79c223b796da8b6) Thanks [@luxass](https://github.com/luxass)! - Prepare the repository for plugins from multiple coding agents. Use host-prefixed package directories and update repository metadata and gallery URLs to agent-extensions. Package names, installation commands, and runtime behavior remain unchanged.

## 0.1.1

### Patch Changes

- [`2fe569d`](https://github.com/luxass/agent-extensions/commit/2fe569dc848612f47c52d3ddc19482c30b2a01f1) Thanks [@luxass](https://github.com/luxass)! - Redesign the custom header with an ASCII terminal-robot mascot, more spacing, clearer project and model details, and the current thinking level. Respect configured thinking shortcuts and keep session information visible in narrow panes while dropping complete shortcut hints.

  Use terminal-aware wrapping in `/resources` and label inferred resources as detected rather than claiming a complete inventory of loaded resources.

## 0.1.0

### Minor Changes

- [`d7c5bb1`](https://github.com/luxass/agent-extensions/commit/d7c5bb1ff1da86111f608729f3d4b97095208e6f) Thanks [@luxass](https://github.com/luxass)! - Add `@luxass/pi-personal` and migrate the personal Pi extensions from the dotfiles repository into the package:

  - Continue the active task after compaction.
  - Prevent interactive Git editors and block `--no-verify` hook bypasses.
  - Require Socket Firewall for package-manager installs.
  - Guard Wrangler's generated `worker-configuration.d.ts` against manual changes.
  - Show a custom session header and a `/resources` view.
  - Add the Crow CLIProxyAPI provider with login, model discovery, streaming, retry, and proactive compaction support.

  Expose each extension separately in the Pi package manifest so users can select which ones to load.
