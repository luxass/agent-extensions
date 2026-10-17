# @luxass/pi-resources

Browse the resources that [Pi](https://pi.dev) loaded, registered tools, and loader diagnostics in a tabbed dialog.

## Install

```sh
pi install npm:@luxass/pi-resources
```

This command previously shipped in `@luxass/pi-personal`. Install this package separately after updating `pi-personal`.

To try the extension from this checkout:

```sh
pi -e ./packages/pi-resources
```

## Use

Run `/resources` in Pi’s terminal interface. The dialog opens on Tools and has five tabs:

- Tools shows compact names, active status, and registered exposure. Press `e` to show descriptions and exposure explanations for all tools. Exposure controls how Pi can reach a tool. Inactive codemode and deferred tools remain callable from other tools. Per-request changes that hide tool declarations are not shown.
- Context lists loaded instruction files and system-prompt sources in Pi’s loading order.
- Skills lists loaded skill names. Names stay complete, with columns when space allows.
- Extensions groups loaded entries into Local, Packages, and Built-in sections. It includes event-only extensions and omits hidden entries, like Pi’s startup display.
- Diagnostics lists loader errors, warnings, and name collisions for extensions, skills, prompts, and themes.

Press `e` in Tools or Extensions to expand or collapse details. Each tab keeps its own expansion state while the dialog stays open. In Extensions, details include full paths and package entries. Packages share one row, with a count for multiple entries. Matching labels retain source details that distinguish them. Home-directory paths use `~`.

| Controls                                | Action                                              |
| --------------------------------------- | --------------------------------------------------- |
| Left, Right, Tab, Shift+Tab             | Switch tabs.                                        |
| `e`                                     | Expand or collapse Tools or Extensions.             |
| `1`–`5`                                 | Jump to a tab.                                      |
| Up, Down, Page Up, Page Down, Home, End | Scroll.                                             |
| Confirm, cancel, or `q`                 | Close. Confirm and cancel default to Enter and Esc. |
| Click a tab or use the mouse wheel      | Switch tabs or scroll in fullscreen mode.           |

On small screens, the tab bar uses shorter labels without counts. The title shows the selected tab’s full name and count. Short summaries leave more room for content.

The close and scroll controls follow your Pi keybindings. Their hints show the primary configured keys. Other configured alternatives also work.

The extension reads Pi’s active resource loader, not a directory scan or an inferred list. Each command invocation reads the current loaded state. An unsupported hook temporarily intercepts `DefaultResourceLoader.getExtensions()` to capture that loader. It restores the original method after capture or on session shutdown. Capture must start when the extension loads, before Pi builds its extension runtime.

Pi updates can break this hook. If capture fails, `/resources` reports an error instead of guessing which resources loaded.
