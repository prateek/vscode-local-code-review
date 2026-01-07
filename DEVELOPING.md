# Developing `vscode-local-code-review`

## Prereqs

- Node.js (recommend Node 20+)
- VS Code

## Install + build

- Install deps: `npm ci`
- Compile: `npm run compile`

## Run the extension (Extension Host)

1. Open this folder in VS Code.
2. Press `F5` (Run → Start Debugging).
3. In the Extension Development Host window, open a workspace and use **“Code Review: Add Comment”**.

## Tests (e2e + snapshots)

This repo prioritizes **end-to-end/integration tests** using the VS Code Extension Test Runner.

- Run tests: `npm test`
- Update snapshots (intentional changes only): `UPDATE_SNAPSHOTS=1 npm test`

Notes:
- Tests launch a VS Code instance; don’t run multiple test runs concurrently.
- On Linux, `npm run test:ci` runs tests under Xvfb (no physical display). On macOS/Windows, VS Code will open a window and may steal focus; there is no reliable fully-headless mode for the extension test runner.
- Snapshot files live under `src/test/snapshots/`.

## Run tests in Docker (no focus stealing)

On macOS/Windows, running the e2e tests inside a Linux container avoids VS Code taking focus on your host.

- One-shot: `npm run test:docker`
- Manual:
  - `docker build -f Dockerfile.test -t local-code-review-test .`
  - `docker run --rm local-code-review-test`

## Regenerate README media (screenshot + gif)

This repo includes an opt-in e2e test gated by `CAPTURE_README_MEDIA=1` that writes:
- `media/screenshot.png`
- `media/demo.gif`

Run it in Docker/Xvfb:

- `docker build -f Dockerfile.test -t local-code-review-test .`
- `docker run --rm -e CAPTURE_README_MEDIA=1 -v \"$(pwd)/media:/workspace/media\" local-code-review-test`

## TDD expectations

When adding/changing behavior:
1. Add or update an e2e test first (**red**).
2. Implement the smallest change to pass (**green**).
3. Clean up (**refactor**) while keeping the suite green.
