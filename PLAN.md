# VS Code Local Code Review Extension — Build Plan

## Product shape (what “done” looks like)

- GitHub/Gerrit-style inline review comments for local changes.
- Create a comment thread on a selected line/range; replies create a threaded discussion.
- Native UI: gutter indicators + inline thread widget with collapse/expand.
- A dedicated “Review Comments” view lists all threads in the workspace.
- All review data is persisted under `.code-review/` (configurable) and can be reset/cleared.

## Key design choice: reuse VS Code’s native Comments API

Use `vscode.comments.createCommentController(...)` so we get:
- in-editor thread UI,
- gutter indicators,
- built-in collapse behavior,
- built-in “Comments” infrastructure (while still providing our own custom view).

## Storage layout (source of truth on disk)

Create and manage this directory:

```
.code-review/
  AGENTS.md
  index.json
  threads/
    <threadId>.md
```

**`index.json`**
- `schemaVersion`
- `threads`: minimal metadata for fast listing (id, file, range, status, updatedAt)

**`threads/<threadId>.md`**
- Starts with a `<local-code-review-thread>...</local-code-review-thread>` JSON block (thread metadata).
- Optionally includes a `<local-code-review-patch .../>` marker followed by a fenced ```diff block.
- Comments are stored as repeating `<local-code-review-comment .../>` markers followed by Markdown bodies.

## MVP milestones

1) **Extension skeleton**
   - `activate()` registers a `CommentController`, commands, and a TreeView.

2) **Create + reply to threads (UI)**
   - Command: “Add Review Comment” (editor context menu + command palette).
   - When selection exists: create a `CommentThread` for the active document + selected range.
   - Reply flow appends a new `Comment` to the thread.
   - Support “Resolve/Unresolve” per thread (updates both UI + persisted JSON).

3) **Persistence**
   - On any thread mutation: write updated `threads/<id>.md` + refresh `index.json`.
   - On activation: load `index.json` + threads and rehydrate into `CommentThread`s.
   - File watcher on `.code-review/**/*.{json,md}` (configurable root) so external edits (including by LLMs) hot-reload.

4) **Review Comments view**
   - TreeView groups by file → thread.
   - Clicking a thread opens the file and reveals the range; focuses/expands the inline thread.

5) **Reset/Clear**
   - Command: “Clear All Review Comments” with confirmation.
   - Deletes `threads/` and rebuilds empty `index.json` (keeps `AGENTS.md`).

## Phase 2 (diff-aware “review local changes”)

- Integrate with Git (via the built-in `vscode.git` extension API) to:
  - show “changed files” in the panel,
  - optionally constrain “Add Review Comment” to changed lines/hunks,
  - store diff context (base ref + hunk context) to improve re-anchoring.

## Phase 3 (suggested changes)

- Support a lightweight “suggestion” block in comment Markdown.
- Command: “Apply Suggested Change” parses the suggestion and applies via `WorkspaceEdit`.

## `.code-review/AGENTS.md` (LLM interaction contract)

Include:
- where threads live (`threads/*.md`) and how IDs map to files/ranges,
- how to add a reply (append a new `<local-code-review-comment .../>` marker + body, and bump `updatedAt`),
- how to resolve (set `status: "resolved"` and bump `updatedAt`),
- what not to do (don’t edit source code unless explicitly requested; don’t renumber IDs).
