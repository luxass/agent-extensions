# @luxass/pi-subagents

Run focused child agents in Pi. Use a live supervisor to follow their work, read answers, and steer or stop them.

## Install

```sh
pi install npm:@luxass/pi-subagents
```

Requires Pi 1.4.0 or newer and Node.js 24. Load only one extension that registers `Agent`.

For local use, run this command from the repository root:

```sh
pi -e ./packages/pi-subagents
```

## Use

Ask Pi to delegate a task. Top-level agents run in the background by default. A foreground call waits for its result. With a foreground agent active, press Ctrl+B in the main editor to continue in the background. Otherwise, Ctrl+B keeps its normal editor behavior.

Run `/agents` to open the live supervisor. The centered panel shows a parent-child list and the selected answer. Narrow terminals prioritize the agent list with two-line entries and a preview of at most three lines. The preview starts at the beginning of a final answer and follows the latest live output. It does not repeat the selected task or status. The panel updates as work proceeds and keeps the selected agent when its state changes.

| Control             | Action                                                         |
| ------------------- | -------------------------------------------------------------- |
| Up / Down           | Select an agent, or scroll the focused preview.                |
| Tab                 | Move focus between the list and preview.                       |
| Enter               | Open the conversation in full-pane reading view.               |
| `d`                 | Open details, permissions, usage, and file paths.              |
| `s`                 | Compose instructions for the running attempt.                  |
| `r`                 | Resume a settled attempt with its saved policy.                |
| `R`                 | Restart with the current definition and a fresh session.       |
| `x`, then `y`       | Stop the selected attempt and its unfinished descendants.      |
| `f`                 | Toggle full-pane reading or fullscreen outside text input.     |
| `n`                 | Expand or collapse routine extension notices in Conversation.  |
| `1` / `2` / `3`     | Filter all, active, or finished agents.                        |
| Page Up / Page Down | Scroll without following new output.                           |
| End                 | Follow new output again.                                       |
| `[` / `]`           | Select an earlier or later attempt in Conversation or Details. |
| `c` / `,`           | Open definition management or settings.                        |
| `?`                 | Show the full keyboard map.                                    |
| Escape              | Cancel input, return to the list, or close the panel.          |

Conversation opens in full-pane reading view automatically. It uses one header, highlights agent replies, and keeps scroll controls at the bottom. Press `d` for Details and Escape to return. Press `f` to switch to the floating conversation. Escape from the reading view returns to the normal agent list.

Routine extension instructions start collapsed. Press `n` to expand or collapse them. When Pi supplies mouse input, click an individual notice to toggle it. Errors and notices without a recorded category remain visible. Existing saved messages keep their recorded source information.

The collapsed inline result has at most two lines. Expand it with Pi's tool-result control to read more. Detailed counters and identifiers stay in Details. Outside the supervisor, one quiet status line appears during active work. There is no idle fleet strip.

The model-facing tools are `Agent`, `get_subagent_result`, and `steer_subagent`. Collection consumes that attempt's pending notification. Its receipt survives reloads, including collection through codemode. While Pi is busy, completions wait until its current model response and tool calls finish. An agent keeps its stable ID across resumes. Each execution has a separate attempt ID, cancellation control, transcript, and usage record. Foreground calls own their returned result. Background and handed-off calls send a completion message. `join: "group"` batches background completions until the joined work finishes or the 30-second delivery window expires.

Mentions accept text only. `@handle task` steers or resumes an existing agent. `@Explore task` starts that type when no matching handle exists. `@main text` sends text to the main conversation. In `clone` mode, a restricted copy of the main conversation prepares a self-contained task. `direct` mode sends the supplied task without that preparation. The preparation uses the same attempt's cancellation and capacity. Its model usage counts toward that attempt.

## Definitions and configuration

The built-in types are `general-purpose`, `Explore`, and `Plan`. They work without custom files. Create definitions in `.pi/agents/<name>.md`, or use `c` in the supervisor. Trusted project definitions override user and package definitions. Definition management supports create, edit, enable, disable, and eject. Eject copies a built-in or package definition without changing its source file.

```yaml
---
name: reviewer
description: Inspect a focused change without editing files.
display_name: Reviewer
tools:
  - read
  - grep
  - find
  - ls
  - Agent
  - get_subagent_result
  - steer_subagent
allowed_subagents:
  - Explore
memory: local
---
Read the relevant code. Report concrete issues with file paths and evidence.
```

List fields (`tools`, `disallowedTools`, `allowed_subagents`, and `skills`) require YAML lists. Block lists, as above, and flow lists such as `tools: [read, grep]` are accepted. Scalar and comma-separated values are no longer accepted, even for one item. Change `allowed_subagents: Explore` to `allowed_subagents: [Explore]`. Invalid files produce a migration message and remain unchanged.

Nested delegation is off unless the definition grants it. `allowed_subagents` accepts type names and `*` patterns. The tool allowlist must also permit the delegation tools. Nested calls wait in the foreground by default. Explicit background children must finish before their owning attempt ends. Parent completion, failure, or stop cancels unfinished descendants.

Definitions support model and thinking selection, allowed and denied tools, preloaded skills, memory scopes, turn limits, and extension isolation. `display_name` changes the visible label, not the lookup name. `prompt_mode: replace` replaces the base prompt. The default appends the definition's instructions. Unknown fields and unsupported worktree settings produce errors rather than silent fallback.

Resume preserves the saved definition, preloaded skills, project instruction files, and system-prompt sources. Memory remains mutable reference data. Current ownership, project trust, disabled types, tool availability, and model scope still apply. A removed or disabled type cannot resume. Restart with the current definition is a separate action. A missing SDK session file does not erase the saved answer. Background delivery receipts persist with the attempt. On restoration, Pi history determines whether a completion still needs delivery.

Memory uses `.pi/agent-memory/`, `.pi/agent-memory-local/`, or `<agentDir>/agent-memory/`. Agents without write/edit permission receive read-only memory instructions. Tool restrictions are not an operating-system security boundary. Trusted extensions and shell tools can access the host process.

Settings load from `<agentDir>/subagents.json` and trusted `.pi/subagents.json`. Project values take precedence. Use `,` in the supervisor to change them. Invalid files produce warnings and remain unchanged.

| Setting                       | Default        | Meaning                                                                   |
| ----------------------------- | -------------- | ------------------------------------------------------------------------- |
| `maxConcurrent`               | `10`           | Top-level background admission limit.                                     |
| `maxConcurrentForeground`     | `0`            | Separate foreground limit. Zero means unlimited.                          |
| `maxConcurrentNestedPerDepth` | `10`           | Shared foreground/background limit at each nested depth.                  |
| `maxDepth`                    | `2`            | Main Pi is depth 0, a top-level agent is depth 1. Zero blocks all agents. |
| `maxTurns`                    | `0`            | Default turn limit. Zero means unlimited.                                 |
| `widgetMode`                  | `"background"` | Active status line: `all`, `background`, or `off`.                        |
| `viewerMarkdown`              | `"assistant"`  | Conversation Markdown: `off`, `assistant`, or `all`.                      |
| `mentionMode`                 | `"clone"`      | Conversation-based task preparation or direct dispatch.                   |

Turn limits use the same rule in configuration, tool calls, and saved records: whole numbers from `0` through `Number.MAX_SAFE_INTEGER`. Zero means unlimited. Limits above 10,000 remain valid after reload.

Explicit existing limits remain in force. The corrected depth convention can reduce nesting for an existing `maxDepth` value. Nested width is bounded per depth, not across the fleet. With `maxDepth: 2`, at most ten nested agents run at depth 2 by default. With a larger depth limit, each additional nested depth has its own pool. Waiting parents do not hold their children's permits. Handoff does not restart work. It can temporarily exceed background capacity, which blocks new background admissions until the overage ends.

New records live under `<agentDir>/subagents/<main-session-id>/v1/`. Attempt metadata and projected conversations use separate files. Original SDK sessions remain available in Details. A saved execution that did not settle is not treated as active in this instance. Resume stays blocked when cleanup cannot be established. This is the first supported storage format. Earlier experimental files are not loaded or migrated, and remain untouched on disk. Corrupt files are not overwritten during restoration.

## Package agents

Installed Pi packages can declare agent definitions in their manifest:

```json
{
  "pi": {
    "subagents": {
      "agents": ["./agents"]
    }
  }
}
```

Discovery reads only configured, installed packages. Declared paths and files must stay inside the package directory. Paths support directories and glob patterns. Prefix a path with `!` or `-` to exclude it.

Definitions take precedence in this order: trusted project `.pi`, trusted project `.agents`, the Pi agent directory, user `~/.agents`, packages, then built-ins. Names ignore letter case. Project definitions require project trust.

Package definitions are read-only. Eject copies a definition into a local file without changing the installed package. Existing files are not overwritten.

Use `packageAgents` in `subagents.json` to allow all packages, disable package agents, or allow specific package names. The supervisor exposes this control in its configuration menu.

## Supported scope

Workflows, scheduling, and RPC are not supported. Schedule requests fail without creating a job. Existing saved data for these features remains untouched.

Children share the checkout. Concurrent edits can conflict. Worktrees, calendar cron, and Herdr integration are not implemented.

Pi 1.4 does not expose an extension API for recording background usage directly. Automatically delivered results do not add child usage to main-session totals until you collect them. Use `get_subagent_result` to record that usage. Repeated collection does not count the same usage again. The supervisor still shows per-agent usage.

Parallel background delegation through codemode and definition saves in all four global/project folders were checked in Pi. See the [manual verification guide](https://github.com/luxass/agent-extensions/blob/main/packages/pi-subagents/docs/manual-verification.md) for the remaining runtime checks.
