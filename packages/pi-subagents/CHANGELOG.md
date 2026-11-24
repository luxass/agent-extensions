# @luxass/pi-subagents

## 0.2.0

### Minor Changes

- [#52](https://github.com/luxass/agent-extensions/pull/52) [`c52af47`](https://github.com/luxass/agent-extensions/commit/c52af47f7a36c0679ebb44f298b40c9cbdcd4d4f) Thanks [@luxass](https://github.com/luxass)! - Report each running subagent to Rex by task name instead of sending a single count. Clear each status when that subagent finishes or stops.

### Patch Changes

- [#51](https://github.com/luxass/agent-extensions/pull/51) [`d3a8c47`](https://github.com/luxass/agent-extensions/commit/d3a8c4761530fdb6379b14053cce82556f11b8c9) Thanks [@luxass](https://github.com/luxass)! - Deliver background results only to branches that started the run and have not received it. Switching branches with `/tree` no longer sends results to an unrelated conversation.

## 0.1.1

### Patch Changes

- [#48](https://github.com/luxass/agent-extensions/pull/48) [`3abf34f`](https://github.com/luxass/agent-extensions/commit/3abf34f70fe9e3ff3c0f27f989f48aee01065821) Thanks [@luxass](https://github.com/luxass)! - Install `pi-schema` as a runtime dependency so Pi can load Subagents from npm.

## 0.1.0

### Minor Changes

- [#39](https://github.com/luxass/agent-extensions/pull/39) [`e73b143`](https://github.com/luxass/agent-extensions/commit/e73b143632462219af2f47341447c747dfa4db59) Thanks [@luxass](https://github.com/luxass)! - Add `@luxass/pi-subagents`: delegate tasks to named agents, receive their results in the chat, and follow their conversations in `/agents`.

- [#45](https://github.com/luxass/agent-extensions/pull/45) [`de27fd5`](https://github.com/luxass/agent-extensions/commit/de27fd51449bf8521fff0802f9e467d81d5fc5d2) Thanks [@luxass](https://github.com/luxass)! - Report running subagents to Rex even after Pi's main turn ends. Clear the report when the last running subagent finishes or is stopped.

### Patch Changes

- [#47](https://github.com/luxass/agent-extensions/pull/47) [`bcec048`](https://github.com/luxass/agent-extensions/commit/bcec04828d6bf1853bc8f4ae68bef573749d3146) Thanks [@luxass](https://github.com/luxass)! - Support Pi 1.6's read-only render output while keeping compatibility with Pi 1.5.
