# @luxass/pi-pin

Pin messages in a Pi session and open them later in a searchable popup. Viewing a pin does not send a model request or change the active conversation.

This is an unpublished experiment. The interaction is under review and is not ready for release.

## Install

After publication, install the package with:

```sh
pi install npm:@luxass/pi-pin
```

From this checkout, run `pi -e ./packages/pi-pin`. The extension uses the Pi packages already present in the workspace. It adds no third-party dependencies.

## Use

Run `/pin` to open the message picker. Type to search message text, labels, roles, or IDs. Use the arrow keys to select a message. Press Enter to preview it, then Ctrl+P to pin it. Ctrl+P also works directly in the picker.

Run `/pin last` or press Alt+Shift+P to pin the latest completed assistant reply with text in the current branch. Tool-only and thinking-only messages are skipped. No message ID is needed.

Use `/pin 1` for the latest conversation message, `/pin 2` for the previous one, or `/pin 3` for the third-most-recent message. Numbers count user messages and assistant replies with text in the current branch. Tool output, tool-only assistant messages, and other branches do not affect the count. Add a label with `/pin 3 Deployment steps`.

Run `/pins` to browse saved messages. Press Enter to open a message preview. Use the arrow keys, Page Up, Page Down, Home, and End to scroll. In fullscreen mode, the mouse wheel also scrolls the preview. Press Escape to return to the list, then Escape again to close.

Press Ctrl+P on a saved message to unpin it. Pinning or unpinning closes the popup. The footer shows the number of saved messages.

For direct access, use a full ID or a unique ID prefix from the picker. Numbers select recent messages. If an ID or prefix contains only digits, use `/pin id:<id>` instead:

```text
/pin a1b2c3d4
/pin a1b2c3d4 Deployment steps
/pin last Deployment steps
/pin 3 Deployment steps
/pin id:1234
/pins a1b2
/unpin a1b2
```

Pinning an existing pin with a label updates its label. The extension does not change labels set through `/tree`.

## Navigate to a message

In a preview, press Ctrl+G to navigate through Pi's session tree. Confirm the dialog before navigation. This changes the active conversation position, not just the scroll position. Later messages remain in `/tree`, where you can return to them. Navigation waits until the agent is idle and does not generate a branch summary.

Pi does not expose a transcript right-click hook or a scroll-to-message API for this extension. Use the picker, shortcut, or message ID instead. Right-click pinning is not included.

## Storage and limits

Pins are saved as metadata in the current session file, outside model context. They survive reloads, session resumes, compaction, and navigation between branches. Pins from all branches of that session appear in `/pins`. Separate sessions have separate pins. Ephemeral sessions lose their pins when Pi exits.

The picker includes stored messages, including tool results and shell output. It omits system messages and does not show assistant thinking. Images appear as text placeholders. The popup displays the original stored message, even if a context edit changes what the model receives.

Popups require interactive Pi. Direct pin and unpin commands do not require a popup.

## License

[MIT](LICENSE).
