# @luxass/pi-questions

## 0.1.2

### Patch Changes

- [#25](https://github.com/luxass/agent-extensions/pull/25) [`ec79f39`](https://github.com/luxass/agent-extensions/commit/ec79f39c1084c1b6ae290a3fe45f0018ab67026c) Thanks [@luxass](https://github.com/luxass)! - Show `Waiting for answers` in Herdr's agent sidebar while a questionnaire is open. Use the shared label reporter and clear labels when questions close or Pi shuts down.
- Updated dependencies [[`52e4a5c`](https://github.com/luxass/agent-extensions/commit/52e4a5cc5926a123c89267909b070fd73fff6452)]:
  - @luxass/herdr-agent-shared@0.1.0

## 0.1.1

### Patch Changes

- [`17f301b`](https://github.com/luxass/agent-extensions/commit/17f301bce7c31f2b1799856d8d63bd84b0112e1d) Thanks [@luxass](https://github.com/luxass)! - Notify Herdr's Pi integration while a questionnaire waits for answers. Clear the questionnaire's blocked state on submission, cancellation, abort, or error.

## 0.1.0

### Minor Changes

- [#16](https://github.com/luxass/agent-extensions/pull/16) [`6e4ac76`](https://github.com/luxass/agent-extensions/commit/6e4ac7607930ae7ceb6fa8fa123cef957b3ec385) Thanks [@luxass](https://github.com/luxass)! - Initial release of `@luxass/pi-questions`, an interactive questionnaire for Pi. The `ask_questions` tool supports tabbed questions, single and multiple choices, custom answers, notes, and Markdown previews.
