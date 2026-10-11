# @luxass/pi-btw

Ask [Pi](https://github.com/badlogic/pi-mono) a side question in a popover without derailing the main conversation.

## Install

```sh
pi install npm:@luxass/pi-btw
```

## Use

Run `/btw` to open the side thread, or `/btw <text>` to open it and ask right away. If a thread already exists, `/btw` asks whether to continue it or start fresh.

In the popover, **Enter** asks, **Esc** stops a running answer or closes the popover, and **↑↓** / **PgUp PgDn** scroll. In fullscreen mode, you can also scroll with the mouse wheel or trackpad, click the scrollbar on the right edge, or drag its thumb. Wheel speed follows Pi's `fullscreenWheelScrollLines` setting. Regular mode keeps terminal-owned mouse scrolling, so use the keyboard inside the popover.

Scrolling up holds your place while an answer streams. Scroll back to the bottom to follow new output again. Closing a non-empty thread asks whether to keep it or inject a summary into the main chat.

The side thread sees the main conversation up to the moment you ask, using your current model and thinking level. By default, its tools are read-only (`read`, `grep`, `find`, `ls`), so it can look things up but not change files. You can configure its tool access separately from the main chat. Because the side request starts with the same prefix as the main chat, providers with prompt caching can reuse the main conversation's cache.

Injecting asks the model for a summary, sends it as a user message, and clears the side thread. If the main agent is busy, the summary is queued as a follow-up.

The side thread is stored in the session log, follows branch navigation, and never enters the main agent's context unless you inject it.

When the popover opens, the side thread copies extension-registered providers from the main session, including their streaming and authentication handlers. Stored credentials still come from Pi's `auth.json`. Provider extensions are not reloaded, so their tools and lifecycle hooks are not enabled in the side thread.

## Tool access

Set `btw.tools` in `~/.pi/agent/settings.json`, or in a trusted project's `.pi/settings.json`. Pi merges these settings, with the project's tool list replacing the user-level list.

This example adds shell access to the default read-only tools:

```json
{
  "btw": {
    "tools": ["read", "grep", "find", "ls", "bash"]
  }
}
```

The list replaces BTW's defaults. Omit `btw.tools` to use `read`, `grep`, `find`, and `ls`; set it to `[]` to disable all tools. Supported names are `read`, `grep`, `find`, `ls`, `bash`, `powershell`, `edit`, and `write`. Extension and MCP tools are not supported. Invalid tool lists produce an error instead of silently changing tool access.

Enabling `bash`, `powershell`, `edit`, or `write` lets the side thread run commands or modify files. The main session's permission hooks and custom tool overrides are not inherited. The tool list is not an operating-system sandbox.

Close BTW, run `/reload` after editing settings, and reopen it to apply the new list. Changing BTW's tools does not change the main chat's tools.
