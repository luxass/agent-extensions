# Manual verification

This script is for the maintainer's real Pi review. Runtime verification is partial. Static checks cannot prove layout, focus, cancellation, or delivery behavior. Do not use covers or synthetic previews as acceptance evidence.

Run root `pnpm lint`, `pnpm fmt:check`, and `pnpm typecheck` after local changes. Run `git diff --check` too. Only the cases in the next section are recorded as verified.

## Verified in Pi

- Started ten background child agents in parallel through codemode and observed their completion messages.
- Created and saved a project agent definition through the supervisor UI.
- Reloaded Pi, then edited and saved definitions under `~/.pi/agent/agents`, `~/.agents/agents`, `.pi/agents`, and `.agents/agents`.
- Confirmed each save notification and checked the changed file at its original path. Removed the demo definitions afterward.

The remaining cases below still need verification.

## Preparation

Use Pi 1.4.0 or newer with Node.js 24 and a configured model. Use a disposable checkout for tasks that change files. Load only this implementation of `Agent`. Keep your normal global definitions and credentials unchanged.

From this repository's root, start Pi:

```sh
pi -e ./packages/pi-subagents
```

If this package is already loaded in the current Pi session, use `/reload` instead. Stop if Pi reports duplicate tools or extension errors. Record the Pi version, model, theme, terminal dimensions, expected behavior, actual behavior, and screenshot for each case.

## First visual pass

1. At idle, make sure that no fleet strip, status line, or navigation help occupies the main conversation.
2. Send this prompt:

   ```text
   Start two general-purpose agents in parallel, both in the background.
   Name the first cp1-short and describe it as "Short timing probe".
   Its task: run bash with "sleep 8", then reply exactly SHORT_DONE.
   Name the second cp1-long and describe it as "Long timing probe".
   Its task: run bash with "sleep 20", then reply exactly LONG_DONE.
   Do not wait for them and do not change files.
   ```

3. Open `/agents` before they finish. Keep it open through both completions.
4. Make sure that the list, counts, preview, and state update without reopening the panel. The selected agent must not jump.
5. Select each agent with the arrows. Press Tab to focus the preview. Press Enter for Conversation, `d` for Details, and Escape to return.
6. Make sure that task names lead the list. UUIDs, cache counters, and full file paths must appear only in Details.
7. In a narrow pane, make sure that the list uses two lines per agent. Make sure that status labels and elapsed times each align on their right edge. The selected output must use at most three lines and must not repeat its task heading or status. With ten agents in a pane about 50 rows high, all ten must appear. For a larger fleet or shorter pane, make sure that the range indicator identifies the visible agents and arrows reach the rest. Press Tab to focus the compact preview and check scrolling.
8. Close the panel. Each collapsed inline result must use at most two lines. A call heading must not repeat above its result.
9. Make sure that each background attempt produces one completion. The active status line must disappear after both settle.
10. Capture wide, narrow, short, fullscreen, light-theme, and dark-theme views. Press `f` to toggle fullscreen. Resize while the panel remains open.

Pass requires real screenshots and consistent live state. If the layout or behavior fails, record the failure before continuing.

## First maintainer review

The first screenshots show a centered supervisor and a running counting agent. Conversation contains partial bash output. Preview incorrectly shows an empty placeholder, status exposes the full loop, and tool calls use a generic JSON block.

The follow-up changes show tool output in Preview before a final answer exists. Shell status uses a short label. Conversation uses unboxed tool output, while Details keeps the full arguments.

After reload, repeat the counting task. Make sure that each new number appears on its own line in Preview. Open Conversation and make sure that the tool output has no JSON argument block or large background fill. Scroll up, make sure that the header says “Scroll paused”, and press End to follow again. Open Details to read the full shell command. These fixes still need a real Pi recheck.

## Conversation speakers

After reload, start a new general-purpose agent with `max_turns: 2`. Ask it to reply exactly `ROLE_CHECK` without tools or file changes. Open `/agents <full-agent-id>`, then press Enter.

Make sure that each message has the correct speaker label:

- `You` identifies the delegated request and user steering messages.
- `Agent` identifies each model reply, with an accent-colored heading. The full-pane header shows the agent name.
- `Extension` identifies generated follow-up instructions, with muted text.

Make sure that routine extension instructions start as one-line notices. Press `n` to expand and collapse them. When Pi supplies mouse input, click an individual notice to toggle only that message. Errors and notices without a recorded category must remain visible.

Conversation must open in full-pane reading without an extra key press. Make sure that one header replaces the floating border, counts, and repeated task headings. Agent replies must have an accent bar. User prompts must use quieter text. The header and footer must stay visible while messages scroll.

Open Details with `d`, then press Escape to return to the same conversation. Press `f` to restore the floating conversation. Press Escape from full-pane reading to return to the normal agent list. Press Enter to make sure that Conversation opens full-pane again. Repeat after resizing to wide, narrow, and short panes. No text from the parent conversation must show through the reading view.

Repeat with `viewerMarkdown` set to `off`, `assistant`, and `all`. Make sure that streaming, tool output, wrapping, and scroll position still work. Restore the original configuration afterward.

Reload again and inspect the saved attempt. Its speaker labels must remain unchanged. Older saved messages lack source data and retain their original labels. Do not infer their authorship from matching text. This pass changes conversation presentation, not the known extra-turn behavior at the turn limit.

## Streaming, scrolling, and focus

Send this prompt:

```text
Start a background general-purpose agent named cp1-stream, described as
"Streaming preview probe". Ask it to explain this repository's package
layout in about 100 numbered lines. It must read files but not change them.
```

Open `/agents cp1-stream` while it works. Make sure that the preview shows the answer as it streams. Open Conversation. Scroll up with Page Up, then wait for more output. The scroll position must stay fixed. Press End to follow the end again. Switch to another agent and back. There must be no blank system section or duplicate messages.

While the panel is open, press `s`. Type text that contains `f`, `x`, `r`, and arrow keys. Only the composer must receive them. Press Escape to cancel. Close the panel with an unfinished main-editor draft. Make sure that the draft and cursor position remain intact. With no foreground agent active, Ctrl+B must keep its normal editor behavior.

## Foreground, handoff, stop, and collection

Use this prompt for a foreground run:

```text
Start general-purpose in the foreground, named cp1-foreground, with the
short description "Foreground probe". Ask it to run bash "sleep 20" and
then reply FOREGROUND_DONE. Do not change files.
```

Press Ctrl+B in the main editor while it runs. Make sure that the foreground wait returns, the same attempt continues, and one background completion arrives. The agent must not restart.

Repeat with `cp1-stop`. Open `/agents cp1-stop`, press `x`, then `y`. Make sure that stopping preserves partial output and waits for cleanup. Repeat stop through the controls available to the caller. It must not create a new attempt or duplicate completion.

Ask Pi to fetch an existing background result with `get_subagent_result`, first with `wait: true` before completion, then again after completion. Collection before delivery must suppress the pending completion. Repeated reads must not report the same usage twice. Interrupting a result wait must leave the background agent running. Interrupting a foreground call before handoff must stop its child.

## Capacity and nesting

In the supervisor, press `,`. Temporarily set background capacity to 1, foreground capacity to 0, nested capacity per depth to 1, and maximum depth to 3. Record the old values so you can restore them.

Start two background agents that each run `sleep 20`. Make sure that one runs and the other stays queued. Start foreground work while the background slot is full. It must use the separate foreground pool. Stop the queued attempt and make sure that it reaches the same settled cancellation path as a running attempt.

In a disposable project, use `c` to create these definitions. Do not overwrite existing files:

```yaml
---
name: cp1-parent
description: Check owned nested delegation without editing files.
tools:
  - read
  - grep
  - find
  - ls
  - Agent
  - get_subagent_result
  - steer_subagent
allowed_subagents:
  - cp1-branch
---
Use Agent to ask cp1-branch to delegate one read-only lookup to Explore.
Omit run_in_background so each nested call waits for its result.
Return the result to your parent. Do not change files.
```

```yaml
---
name: cp1-branch
description: Check a deeper read-only child.
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
---
Ask Explore to locate package.json and report its package name.
Wait for its result. Do not change files.
```

Run `cp1-parent` in the foreground while the top-level background slot is full. Make sure that its depth-2 child and depth-3 grandchild make progress. The supervisor must show their ownership tree. Nested calls must wait by default.

Repeat with two parents. Ask one to collect or steer a child owned by the other. The operation must fail. Reduce the maximum depth and ask for the same chain. Deeper delegation must fail clearly. Stop a parent during a nested wait. Its descendants must stop, all waits must settle, and no later attempt must inherit an old cancellation.

Ask a parent to start an explicit background child and finish immediately. Make sure that unfinished children stop with that parent. They must not become independent top-level work. Restore the original capacity settings after this section.

## Saved policy and history

Create `cp1-policy` in a disposable project:

```yaml
---
name: cp1-policy
description: Check saved instructions and permissions.
display_name: Policy probe
prompt_mode: append
tools:
  - read
  - grep
  - find
  - ls
---
Always begin your final answer with SAVED_POLICY_A.
Read only. Do not change files.
```

Start it with a short read-only task. After it settles, change its prompt marker to `CURRENT_POLICY_B`. Resume the finished agent with `r`. It must retain `SAVED_POLICY_A` and the original permissions. Use `R` to restart with the current definition. That fresh session must use `CURRENT_POLICY_B`.

Make sure that the stable agent ID stays the same across supported resumes. Attempt IDs must change. Use `[` and `]` in Conversation or Details to read earlier attempts. Their inline cards and conversations must not change to the newest attempt.

Reload Pi, reopen the saved history, and resume again. In a disposable profile, interrupt delivery after the attempt saves its terminal record. Reopen that same main session. Its pending background completion must recover once, without repeating a completion or terminal collection already recorded by Pi. Then disable or remove the type. Resume must fail without substituting general-purpose. Restore the file only if you created it for this script. Do not alter normal user definitions.

Repeat with a preloaded skill and an applicable project instruction file. Edit them after the first attempt settles. Resume must retain the original instruction content. Mutable memory must load its current reference data instead.

Make sure that only v1 records appear in saved history. Earlier experimental files must remain unchanged and must not be loaded or migrated. In a disposable profile, remove a saved SDK session file. Its saved answer must remain visible, but Resume must fail safely. Leave malformed records unchanged.

## Retained configuration and failure paths

All of these cases remain pending until observed in Pi:

- [ ] Load definitions with YAML list fields, including `display_name` and `prompt_mode` aliases, without false warnings for absent optional skill directories.
- [ ] Try scalar and comma-separated values for each list field. Make sure that the error explains the YAML list format and leaves the file unchanged. Replace them with block or flow lists and reload.
- [ ] Reject unknown fields, repeated aliases, invalid field types, and unsupported worktrees. Keep nested delegation off when `allowed_subagents` is absent. Save and reload a definition through the editor without changing its permissions.
- [ ] Create, edit, disable, enable, and eject definitions. Make sure that package and unrelated files remain unchanged.
- [ ] Exercise trusted project, user, and package precedence. Refuse untrusted project configuration.
- [ ] Select a registered custom provider and model. Exercise inherited context after branch changes and compaction.
- [ ] Enforce allowed and denied tools, current model scope, extension isolation, `--no-extensions`, and `--no-mcp`.
- [ ] Exercise user, project, and local memory. Read-only agents must receive no write/edit permission and no permission to change memory through another tool.
- [ ] Use `@main`, `@handle`, and type mentions. Compare clone preparation with direct mode. Make sure that preparation stops on cancellation and counts its usage once.
- [ ] Force startup failure and a small turn budget. Preserve partial output and show unfinished work rather than claiming task success.
- [ ] Request immediate resume while cleanup runs. Refuse it until settlement. Repeat stop without overlapping attempts.
- [ ] Reload, switch sessions, and shut down during preparation, startup, nested waits, and active work. Make sure that no old UI listener or late child survives.
- [ ] Run an immediate headless task. Background work must settle without terminal-only calls. Save its output and errors.
- [ ] Inspect idle behavior. There must be no idle polling or per-card timer.

## Unsupported features

Workflows, gates, replay, scheduling, and RPC are not supported. Their tools, menus, and ready notifications must not claim availability. A schedule request must fail without creating a job. Existing saved jobs and advanced files must remain unchanged.

Worktrees, calendar cron, and Herdr integration remain out of scope. Children share the checkout. Trusted extensions and shell tools are not an operating-system sandbox.

Record screenshots and failures from the cases above. Static checks do not establish runtime acceptance.
