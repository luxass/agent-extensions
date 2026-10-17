# @luxass/pi-personal

Collects [Pi](https://pi.dev) extensions that are tuned to a single personal workflow rather than general enough to ship on their own.

## Install

```sh
pi install npm:@luxass/pi-personal
```

## What it does

The custom header pairs an ASCII terminal-robot mascot with the project, model, and current thinking level. A rounded frame, vertical padding, and a separate shortcut row give it room on wide terminals. Narrow panes use a compact layout and drop shortcut hints before truncating them. The thinking shortcut follows your Pi keybindings.

Run `/resources` to inspect detected context files, skill commands, extensions, and all registered tools. Each tool shows its description and active or inactive status. Active tools are declared to the model. Use the arrow keys, Page Up, Page Down, Home, and End to scroll. Press Esc, Enter, or `q` to close.

The resources command loads separately from the custom header within this package. Context, skill, and extension lists are inferred from files and registered commands/tools, not a complete inventory of loaded resources.

The dependency policy tells the model to reuse existing code, installed dependencies, and platform APIs first. It requires explicit user approval before adding, replacing, or upgrading dependencies. Routine installs of existing dependencies remain allowed through Socket Firewall. This is a model instruction, not an enforced approval gate.

The package also includes Crow provider support, compaction continuation, Git and package-manager interceptors, and a worker configuration guard. These defaults suit one workflow and are meant to be edited in place rather than configured through settings.
