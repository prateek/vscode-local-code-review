# Developer guide

## Prereqs

- Node.js 20+
- VS Code

## Build

- Install deps: `npm ci`
- Compile: `npm run compile`
- Watch mode: `npm run watch`

## Run locally (recommended: Extension Development Host)

1. Open this repo folder in VS Code.
2. Press `F5` (Run → Start Debugging).
3. In the **Extension Development Host** window, open any workspace and try:
   - Command palette: **“Code Review: Add Comment”**
   - Explorer view: **“Local Review”** (lists threads)
   - Panel view: **“Local Review”** (lists threads)

Review data is persisted in your workspace under `.code-review/` by default (configurable via `localCodeReview.storagePath`).

## Install locally into your main VS Code (VSIX)

1. Package a VSIX: `npm run vsce:package`
2. Install it:
   - VS Code → Extensions → “…” → **Install from VSIX…**, OR
   - CLI: `code --install-extension ./local-code-review-*.vsix`

## Use the extension

- Add a thread: select text (or place cursor) → run **“Code Review: Add Comment”**
- Reply/resolve/reopen: use the inline thread UI (or the thread title actions)
- Reveal a thread: from the **Local Review** view, click a thread
- Clear everything: **“Code Review: Clear All Comments”** (keeps `.code-review/AGENTS.md`)

## Tests (e2e + snapshots)

- Run tests: `npm test`
- Update snapshots (intentional changes only): `UPDATE_SNAPSHOTS=1 npm test`

On macOS/Windows, VS Code e2e runs can steal focus; run in Docker to avoid that:

- `npm run test:docker`

## Regenerate README media (screenshot + gif)

Media is generated via an opt-in e2e test gated by `CAPTURE_README_MEDIA=1` (runs best in Docker/Xvfb).

- `docker build -f Dockerfile.test -t local-code-review-test .`
- `docker run --rm -e CAPTURE_README_MEDIA=1 -v \"$(pwd)/media:/workspace/media\" local-code-review-test`
