# Packaging & publishing to the VS Code Marketplace

## Package a `.vsix` locally

Use `vsce` (VS Code Extension Manager):

- One-time install (global): `npm i -g @vscode/vsce`
- Build + package: `npm run compile && vsce package`
- Or use the repo script (uses `npm exec`): `npm run vsce:package`

The command produces a `*.vsix` you can install via **Extensions → “Install from VSIX…”**.

## Publish to Marketplace (manual)

1. Create/confirm your **publisher** in the VS Code Marketplace (Azure DevOps-backed).
2. Create a Personal Access Token (PAT) with Marketplace publishing permissions.
3. Update `package.json`:
   - `publisher` (must match your Marketplace publisher)
   - `repository` (recommended; `vsce` warns if missing)
   - `version` (bump before publishing)
   - (recommended) add a `LICENSE` file if you plan to publish publicly
4. Publish:
   - `vsce publish -p <YOUR_PAT>`
   - Or use the repo script: `npm run vsce:publish -- -p <YOUR_PAT>`

## Publish from GitHub Actions (recommended path)

This repo includes a workflow that can package on tags and optionally publish when a secret is present.

Set repository secrets:
- `VSCE_PAT`: your Marketplace PAT

Then push a tag like `v0.0.2` to trigger the release workflow.

## Artifact integrity notes

- Marketplace installs: the Visual Studio Marketplace signs published extensions and VS Code verifies the signature on install (default behavior).
- GitHub Actions tag builds: the workflow generates `SHA256SUMS`, emits a GitHub build provenance attestation for the produced `*.vsix`, and attaches both to the GitHub Release created for the tag.

To verify a VSIX downloaded from GitHub Releases:

- `sha256sum -c SHA256SUMS`
- Optional (provenance): `gh attestation verify local-code-review-*.vsix --repo <owner>/<repo>`
