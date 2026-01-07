# Experiment: vscode-local-code-review

## Goal

Build a VS Code extension that enables GitHub/Gerrit-style local code reviews: inline/threaded comments on diffs, stored in .code-review (configurable), with a review panel and reset flow.

## Engineering process (must-follow)

- Prefer **end-to-end / integration tests** over isolated unit tests (use the VS Code Extension Test runner where possible).
- Use **TDD when relevant**: write a failing test first (**red**), implement the smallest change to pass (**green**), then clean up (**refactor**).
- Use **snapshot testing** for stable artifacts:
  - persisted `.code-review/**` JSON,
  - “all comments” view output (TreeView item labels / structured output),
  - any rendered summaries produced by the extension.
- Before claiming a feature is done (or asking for user feedback), **run the full e2e suite** and verify snapshots (and any captured UI output/images) locally.

## Where to look first

- See `references/index.md` for the inventory of repos, links, and notes.
- Cloned repos live under `references/repos/` and are ignored by git.
