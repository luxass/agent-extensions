# @luxass/pi-personal

Collects [Pi](https://pi.dev) extensions that are tuned to a single personal workflow rather than general enough to ship on their own.

## Install

```sh
pi install npm:@luxass/pi-personal
```

## What it does

The custom header pairs an ASCII terminal-robot mascot with the project, model, and current thinking level. A rounded frame, vertical padding, and a separate shortcut row give it room on wide terminals. Narrow panes use a compact layout and drop shortcut hints before truncating them. The thinking shortcut follows your Pi keybindings.

Run `/resources` to browse the Tools, Context, Skills, Extensions, and Diagnostics tabs. The dialog opens on Tools. Each tool shows its description, active or inactive status, and registered exposure. Exposure controls how Pi can reach a tool. Inactive codemode and deferred tools remain callable from other tools. The dialog does not show per-request changes that hide tool declarations.

Skills use compact columns when space allows. Names remain complete, and narrow terminals use a single column. The Extensions tab groups entries into Local, Packages, and Built-in sections using Pi’s source metadata. Extension labels are compact by default. Labels that match retain distinguishing source information. Packages show one row each, with an extension count when they contain several entries. Press `e` in the Extensions tab to show or hide source details and package entry paths. Home-directory paths use `~`. The Diagnostics tab lists loader errors, warnings, and name collisions for extensions, skills, prompts, and themes.

Use Left, Right, Tab, or Shift+Tab to switch tabs. Keys `1`–`5` jump directly to a tab. In fullscreen mode, you can also click tabs and scroll inside the dialog with a mouse wheel or trackpad. Use Up, Down, Page Up, Page Down, Home, and End to scroll in either terminal mode. Use your configured confirm or cancel keys to close, or press `q`. The default confirm and cancel keys are Enter and Esc. The dialog’s close and scroll hints show readable labels for the primary configured keys. All configured alternatives remain available.

The resources command loads separately from the custom header within this package. Context files and skills come directly from Pi’s resource loader. Context includes loaded instruction files and system-prompt sources in Pi’s loading order. The Extensions tab reads Pi’s loaded extension list, including event-only extensions. It omits hidden entries, like Pi’s startup display.

This uses an unsupported hook that temporarily intercepts `DefaultResourceLoader.getExtensions()` to capture the active loader. The hook restores the original method after capture or when the extension runtime shuts down. Pi updates can break this hook. If capture fails, `/resources` reports an error instead of showing an inferred extension list.

The dependency policy tells the model to reuse existing code, installed dependencies, and platform APIs first. It requires explicit user approval before adding, replacing, or upgrading dependencies. Routine installs of existing dependencies remain allowed through Socket Firewall. This is a model instruction, not an enforced approval gate.

The package also includes Crow provider support, compaction continuation, Git and package-manager interceptors, and a worker configuration guard. These defaults suit one workflow and are meant to be edited in place rather than configured through settings.
