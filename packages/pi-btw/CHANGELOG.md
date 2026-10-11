# @luxass/pi-btw

## 0.2.0

### Minor Changes

- [`cb798bc`](https://github.com/luxass/pi-extensions/commit/cb798bc86c2af78f32bdb92ef0c9d0d0bcb1a68c) Thanks [@luxass](https://github.com/luxass)! - Add `btw.tools` settings to configure the side conversation's built-in tool access independently of the main chat. Keep the read-only defaults when unset, allow an empty list to disable all tools, and reject invalid tool names. Use Pi's merged user and trusted project settings, and update the side prompt to describe the tools actually enabled.

### Patch Changes

- [`ab869a7`](https://github.com/luxass/pi-extensions/commit/ab869a78e06340357c4f13f6cc3f862421d5f05a) Thanks [@luxass](https://github.com/luxass)! - Add mouse wheel and trackpad scrolling, plus a clickable and draggable scrollbar, to fullscreen BTW popovers. Keep the viewport steady while answers stream, and preserve popup borders and the scroll position counter at narrow widths.

  Fix side conversations with extension-registered providers such as Crow by copying their authentication and streaming handlers without loading their tools or lifecycle hooks.

## 0.1.2

### Patch Changes

- [`d360d67`](https://github.com/luxass/pi-extensions/commit/d360d677c4614dea806303bae5e5d91e577a2b98) Thanks [@luxass](https://github.com/luxass)! - Add PNG cover URLs to the Pi package gallery metadata.

- [`ca0ca13`](https://github.com/luxass/pi-extensions/commit/ca0ca138db5cf0838d1ed548993f8320fe61da42) Thanks [@luxass](https://github.com/luxass)! - Update dependencies

## 0.1.1

### Patch Changes

- [`cb0f5f1`](https://github.com/luxass/pi-extensions/commit/cb0f5f1b6e8bae2c8c86119b3a2cfcb23f371702) Thanks [@luxass](https://github.com/luxass)! - Declare the MIT license and include the license text in each published package.

- [`beac420`](https://github.com/luxass/pi-extensions/commit/beac420041c6718261e49a522d157bb58e8216c0) Thanks [@luxass](https://github.com/luxass)! - Clarify package descriptions and add Pi extension and feature-specific keywords for package discovery.

## 0.1.0

### Minor Changes

- [`9cca545`](https://github.com/luxass/pi-extensions/commit/9cca5451138d8c266d2607ad413ec47cf5306a24) Thanks [@luxass](https://github.com/luxass)! - Add `/btw` for side questions in a popover. The side thread sees the main conversation, uses read-only tools, and can inject a summary into the main chat when closed.
