# @luxass/pi-subagents

Delegate tasks to named [Pi](https://pi.dev) agents. Each agent works in its own conversation, and its result comes back to the main conversation by itself.

## Install

```sh
pi install npm:@luxass/pi-subagents
```

To try it from this repository, run `pi -e ./packages/pi-subagents`.

## Use

Ask Pi to delegate a task, or start a prompt with an agent type, such as `@explorer review authentication`. The main model starts the agent and gives it a unique task name, such as `auth-review`. Agents run in the background by default. Their results appear in the chat when they finish.

Two agent types are built in. `general-purpose` has Pi's default tools: `read`, `bash`, `edit`, and `write`. `explorer` is told not to change files and has `read`, `grep`, `find`, `ls`, and `bash`. Its instructions are not a sandbox, because `bash` can still change files.

To give an agent a correction, or to continue a finished agent, ask the main model. You cannot send messages to an agent directly.

| Control   | Action                                                                       |
| --------- | ---------------------------------------------------------------------------- |
| `/agents` | Show every agent of the session beside the selected agent's conversation.    |
| Ctrl+B    | While a foreground agent runs, move all foreground agents to the background. |

In `/agents`, Up and Down select an agent, and Enter opens the conversation alone. Tab switches between the list and the conversation. Page Up, Page Down, Home, and End scroll the conversation from either one. Press `x` twice to stop the selected agent. Press `f` to switch between a floating and a fullscreen view. Esc goes back one step and then closes the view. Pi's tool expansion key opens and closes all tool calls. With the conversation focused, `t` and `T` move to the next and previous tool call, and Enter opens or closes that one. In Pi's fullscreen terminal mode, you can also scroll with the mouse wheel and click agents and tool calls.

## Agent types

Add an agent type as a Markdown file. Files in later folders replace types with the same name from earlier ones:

1. `~/.pi/agent/agents/`
2. `~/.agents/agents/`
3. `.agents/agents/` in the project
4. `.pi/agents/` in the project

Project folders load only when you trust the project. The file body is added after Pi's system prompt.

```markdown
---
description: Review code changes for bugs.
tools: [read, grep, find, ls, bash]
model: anthropic/claude-sonnet-4-5
thinking: high
max_turns: 30
skills: [review-checklist]
---

Review the changes you are asked about and report concrete problems with file paths.
```

Only `description` is required. `name` defaults to the file name. `model` is `provider/id`, or a part of it that matches exactly one available model. `skills` adds the full text of those skills to the prompt. Values in the file win over the same values in an `Agent` call. A file with any other field is skipped with a warning.

Extension tools, such as `codemode`, load their extension only in that agent. A `mcp__server__*` pattern loads Pi's MCP support and codemode, and connects every server in `mcp.json`. Agents cannot start, steer, or stop other agents, and they have no UI, so a tool that asks you a question fails inside an agent.

## Settings

Set these under `subagents` in Pi's `settings.json`. Project settings apply only in trusted projects.

| Setting               | Default        | Meaning                                                                                                                           |
| --------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `maxConcurrent`       | `8`            | Background agents that run at once. More wait in a queue.                                                                         |
| `maxTurns`            | `0`            | Turn limit when the file and the call set none. `0` means no limit.                                                               |
| `backgroundByDefault` | `true`         | Whether `Agent` calls run in the background unless they say otherwise.                                                            |
| `disabledAgents`      | `[]`           | Agent types that cannot start or continue.                                                                                        |
| `widget`              | `"background"` | Agents shown above the editor: `"background"`, `"all"`, or `"off"`.                                                               |
| `delivery.mode`       | `"grouped"`    | `"grouped"` reports agents of one request together, after at most 60 seconds. `"immediate"` reports each result when it is ready. |

Agent conversations are saved under `~/.pi/agent/subagents/<session id>/`. After `/reload` or a resumed session, finished agents can still be read and continued. Agents that were running or queued show as interrupted and can also be continued. An agent that never started begins with the new prompt only.

## Events

Other extensions can observe agents on `pi.events`: `subagents:ready`, `subagents:created`, `subagents:started`, `subagents:activity`, `subagents:steered`, `subagents:usage`, `subagents:completed`, `subagents:failed`, and `subagents:disposed`. Import the payload types from `@luxass/pi-subagents/api`. The events cannot start, steer, or stop agents.
