# @luxass/herdr-agent-shared

Share Herdr blocked sidebar labels between agent extensions. This library has no runtime dependencies or Pi or OpenCode imports. It is not a standalone extension.

## Install

Add the library as a runtime dependency of the extension that uses it:

```sh
pnpm add @luxass/herdr-agent-shared
```

Do not add it to Pi's extension list or OpenCode's plugin list. It ships TypeScript source for hosts with TypeScript loaders and requires Node.js 24 or later, or a compatible Bun runtime.

## Use

Create one reporter per extension runtime. Use a unique source for each consumer.

```ts
import { HerdrBlockedReporter } from "@luxass/herdr-agent-shared";

const blocked = new HerdrBlockedReporter({
  source: "my-extension:blocked",
  agent: "pi",
  appliesToSource: "herdr:pi",
});

const release = blocked.block("Waiting for answers");
try {
  await showQuestion();
} finally {
  await release();
}
```

`block()` sends display-only metadata. It does not change the agent's actual state. In Pi, keep the paired `herdr:blocked` events that tell Herdr's Pi integration when the agent needs input. An OpenCode consumer must keep its own host lifecycle reporting. Use the matching Herdr agent ID and lifecycle source in each host.

When the host shuts down or reloads the extension runtime, call `await blocked.clear()`. For Pi, register that cleanup with `pi.on("session_shutdown", () => blocked.clear())`. Create the reporter without starting sockets or timers. Reporting starts only when a reason changes.

The newest active reason appears in the sidebar. Releasing it restores the newest remaining reason. Release functions are safe to call more than once. `clear()` releases all reasons owned by that reporter. Separate metadata sources prevent one consumer's cleanup from clearing another consumer's labels. Create only one reporter for each source in a runtime.

The library uses only the injected `HERDR_ENV`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID`. It sends nothing outside a Herdr pane. Hosts must also restrict calls to their root interactive session because child processes can inherit those variables. The optional `env` field accepts an environment object instead of `process.env`.

Each reporter sends metadata in order. Socket requests have a 500 ms first attempt and a 1500 ms retry. Releases and `clear()` wait for queued delivery attempts. Connection errors and invalid responses do not interrupt the host workflow. Labels can remain stale if the process crashes or Herdr cannot receive cleanup.

Labels have terminal control sequences removed, whitespace normalized, and a limit of 200 characters. Empty labels become `Waiting for input`. These rules do not redact secrets. Use fixed, public-safe reasons rather than copying user questions, command output, or private context.

## Sidebar configuration

Herdr must include `state_text` in the expanded agent sidebar layout:

```toml
[ui.sidebar.agents]
rows = [["state_icon", "workspace", "tab"], ["agent", "state_text"]]
```

Herdr displays the reported blocked label only while the agent is blocked. See Herdr's [configuration guide](https://herdr.dev/docs/configuration/) and [metadata API](https://herdr.dev/docs/socket-api/).
