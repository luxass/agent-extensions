# @luxass/pi-personal

Collects [Pi](https://pi.dev) extensions that are tuned to a single personal workflow rather than general enough to ship on their own.

## Install

```sh
pi install npm:@luxass/pi-personal
```

## What it does

The custom header pairs an ASCII terminal-robot mascot with the project, model, and current thinking level. A rounded frame, vertical padding, and a separate shortcut row give it room on wide terminals. Narrow panes use a compact layout and drop shortcut hints before truncating them. The thinking shortcut follows your Pi keybindings.

The `/resources` dialog now lives in [`@luxass/pi-resources`](../pi-resources/README.md). Install that package separately to keep the command. The header shows its shortcut only when the command is available.

The dependency policy tells the model to reuse existing code, installed dependencies, and platform APIs first. It requires explicit user approval before adding, replacing, or upgrading dependencies. Routine installs of existing dependencies remain allowed through Socket Firewall. This is a model instruction, not an enforced approval gate.

The Git interceptor preserves your commit signing settings for commits and rebases. It blocks common signing bypasses, including `--no-gpg-sign`, false values for `commit.gpgsign`, removal of that setting, and indexed Git configuration environment overrides. It also tells the model to stop and ask for help if signing fails. It does not enable signing where you disabled it. These shell checks are safeguards for common commands, not a complete security boundary.

The package also includes Crow provider support, compaction continuation, Git and package-manager interceptors, and a worker configuration guard. These defaults suit one workflow and are meant to be edited in place rather than configured through settings.
