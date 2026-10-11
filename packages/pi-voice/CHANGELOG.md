# @luxass/pi-voice

## 0.3.1

### Patch Changes

- [`d360d67`](https://github.com/luxass/agent-extensions/commit/d360d677c4614dea806303bae5e5d91e577a2b98) Thanks [@luxass](https://github.com/luxass)! - Add PNG cover URLs to the Pi package gallery metadata.

- [`ca0ca13`](https://github.com/luxass/agent-extensions/commit/ca0ca138db5cf0838d1ed548993f8320fe61da42) Thanks [@luxass](https://github.com/luxass)! - Update dependencies

## 0.3.0

### Minor Changes

- [`b8276f5`](https://github.com/luxass/agent-extensions/commit/b8276f57538205b81e98521e6560080885d33a92) Thanks [@luxass](https://github.com/luxass)! - Use `@luxass/agent-voice@0.5.0` for native microphone capture and in-memory transcription. Await recording startup and microphone cleanup, and keep setup available before loading the recording binding.

  Select GGUF Whisper or Parakeet models from the model picker. The default model directory is `~/.cache/agent-voice`. Require Node.js 24 or newer.

- [`1e3dad6`](https://github.com/luxass/agent-extensions/commit/1e3dad6a43fa9a0392b0c913b9ff225a7eeaafce) Thanks [@luxass](https://github.com/luxass)! - Add `/voice setup` to choose a transcription profile and microphone, and check recording requirements before starting capture. Offer setup when configuration is missing or unusable. Completing setup does not start recording.

  Load settings once at extension startup and update them in memory after saving. Display settings diagnostics without preventing the extension from loading. Validate known settings while allowing extra keys without warnings.

### Patch Changes

- [`cb0f5f1`](https://github.com/luxass/agent-extensions/commit/cb0f5f1b6e8bae2c8c86119b3a2cfcb23f371702) Thanks [@luxass](https://github.com/luxass)! - Declare the MIT license and include the license text in each published package.

- [`beac420`](https://github.com/luxass/agent-extensions/commit/beac420041c6718261e49a522d157bb58e8216c0) Thanks [@luxass](https://github.com/luxass)! - Clarify package descriptions and add Pi extension and feature-specific keywords for package discovery.

## 0.2.0

### Minor Changes

- [`7254dbb`](https://github.com/luxass/agent-extensions/commit/7254dbb70440bea8a66c06c19fdecb4df65300c6) Thanks [@luxass](https://github.com/luxass)! - Local profiles can download a Whisper model straight from their model picker, in `/voice profile add` and `/voice profile model`. Add `/voice doctor` to check recording and transcription setup. Models are now looked up only in `~/.cache/whisper` (or `$AGENT_VOICE_MODEL_DIR`); models in `~/.local/share/whisper-cpp` are no longer auto-detected.

- [`c0065b9`](https://github.com/luxass/agent-extensions/commit/c0065b9af6507544528a0ac25c98ba248dd83328) Thanks [@luxass](https://github.com/luxass)! - Replace the `/voice-*` commands with one `/voice` command and subcommands: `/voice` (record), `/voice cancel`, `/voice device`, `/voice profile`, `/voice profile add`, `/voice profile model`, `/voice doctor` and `/voice status`. Subcommands autocomplete after `/voice `. The old `/voice-record`, `/voice-cancel`, `/voice-device`, `/voice-profile`, `/voice-doctor` and `/voice-status` commands are removed.

## 0.1.0

### Minor Changes

- [`5e5f736`](https://github.com/luxass/agent-extensions/commit/5e5f736ba8c9379985735148e4f349745fb3b1f2) Thanks [@luxass](https://github.com/luxass)! - Release voice recording and transcription with device selection and configurable profiles.
