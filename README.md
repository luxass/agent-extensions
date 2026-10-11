# Agent extensions

Plugins for coding agents, published as separate npm packages. This repository currently contains [Pi](https://pi.dev) extensions. OpenCode plugins can be added alongside them.

| Package                | What it does                                                                            | Documentation                                |
| ---------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| `@luxass/pi-btw`       | Ask side questions in a popover, then optionally send a summary to the main chat.       | [btw](packages/pi-btw/README.md)             |
| `@luxass/pi-personal`  | Load defaults and extensions tuned to a single personal workflow.                       | [personal](packages/pi-personal/README.md)   |
| `@luxass/pi-voice`     | Record speech, transcribe it locally or through an API, and paste it into the composer. | [Voice](packages/pi-voice/README.md)         |
| `@luxass/pi-whimsical` | Display playful working messages while the agent runs.                                  | [Whimsical](packages/pi-whimsical/README.md) |

## Install

Install whichever extensions you want:

```sh
pi install npm:@luxass/pi-btw
pi install npm:@luxass/pi-personal
pi install npm:@luxass/pi-voice
pi install npm:@luxass/pi-whimsical
```

Use `/btw` for side questions, and `/voice` or **Ctrl+Shift+V** for recording. Whimsical and personal load automatically.

Voice recording requires `sox`. Local transcription also requires `whisper-cli` and a Whisper model. API transcription does not require Whisper. Run `/voice doctor` to check your setup.

## Development

Use Node.js 24 and the pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
```

Try an extension from the checkout:

```sh
pi -e ./packages/pi-btw
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for shared TypeScript settings, linting, formatting, and the new-package checklist. There is no build step. The packages ship TypeScript source.

## Pi package gallery

The [Pi package gallery](https://pi.dev/packages) discovers npm packages tagged with the `pi-package` keyword. Pi's [package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md#create-a-package) describes the discovery metadata.

Each Pi extension in this repository already has:

- The `pi-package` keyword.
- A `pi.extensions` manifest pointing to its source entry point.
- A description and repository URL.
- Public npm publishing configured.

Publish each extension as its own npm package through the existing Changesets release workflow. The private repository-root package is not published. The keyword makes a published package eligible for gallery discovery; it does not guarantee immediate indexing. No separate submission step is documented.

Optional `pi.image` and `pi.video` fields add gallery previews. Each package sets `pi.image` to a generated PNG cover committed under `packages/*/docs/`. Run `pnpm covers` to regenerate them, and push the result to `main` so the raw GitHub URLs resolve. `pi.video` can add a video preview.

## License

[MIT](LICENSE). Each package includes its own MIT license file.
