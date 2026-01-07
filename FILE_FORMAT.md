# Local Code Review — Thread File Format

This extension persists review threads to disk in a workspace-local directory (default: `.code-review/`, configurable via `localCodeReview.storagePath`).

## Directory layout

```
.code-review/
  AGENTS.md
  index.json
  threads/
    <threadId>.md
```

### `index.json` (non-authoritative listing cache)

`index.json` is a small listing file used for fast “what threads exist?” queries. It is not treated as the source of truth; the extension can reconstruct state from `threads/*.md` if needed.

Shape:

- `schemaVersion: 1`
- `threads[]`: entries with `{ id, file, range, status, updatedAt }`

## Thread files: `threads/<threadId>.md` (source of truth)

Each thread lives in a single Markdown file. The file is designed to be:

- human-readable (Markdown),
- round-trippable (edits on disk are reflected in the UI),
- unambiguous to parse (custom tag markers).

### 1) Required thread metadata block

Every thread file must contain a thread metadata block:

```text
<local-code-review-thread>
{ ...JSON... }
</local-code-review-thread>
```

The JSON is the canonical thread metadata. Required fields:

- `schemaVersion: 1`
- `id: string` (thread id; should match the filename stem)
- `target.workspaceRelativePath: string` (workspace-folder-relative path)
- `target.range: { startLine, startCharacter, endLine, endCharacter } | null` (0-based)
- `target.anchor.kind: "lineRange"`
  - `target.anchor.context` optional: `{ before: string[], selection: string, after: string[] }`
  - `target.anchor.git` optional: `{ baseRef?: string, hunkHeader?: string }`
- `status: "open" | "resolved"`
- `createdAt: string` (ISO8601)
- `updatedAt: string` (ISO8601)

**Safety note:** `workspaceRelativePath` must be a safe relative path (no absolute paths, no `..` traversal). Unsafe paths are ignored by the extension.

### 2) Optional patch snapshot block

Threads can embed an optional patch snapshot for readability and better review context.

The patch is stored after a marker line:

```text
<local-code-review-patch lang="diff"/>
```

…followed by a fenced code block (the extension looks for the next fenced block with language `diff` or `patch`):

```diff
@@ -1,3 +1,3 @@
...
```

Edits to this fenced block are round-tripped: the extension treats it as the canonical value for the thread’s “patch snapshot” when reloading from disk.

### 3) Comment markers + bodies

Each comment begins with a single-line marker:

```text
<local-code-review-comment id="c0001" author="You" createdAt="2000-01-01T00:00:00.000Z"/>
```

The comment body is plain Markdown starting after the marker (optionally preceded by a blank line) and continues until the next comment marker (or EOF).

Attributes:

- `id`: string (unique within the thread)
- `author`: string (XML-escaped; the extension unescapes `&amp;`, `&quot;`, `&lt;`, `&gt;`)
- `createdAt`: ISO8601 timestamp string

**Important:** Any line that starts with `<local-code-review-comment` is treated as the start of a new comment. Avoid starting normal prose with that literal sequence.

## Editing rules (manual / LLM)

### Add a reply

1. Append a new `<local-code-review-comment .../>` marker at the end of the file with:
   - a new `id` (don’t reuse existing ids)
   - a new `createdAt`
2. Add the comment body Markdown below it.
3. Update `updatedAt` in the `<local-code-review-thread>` JSON block.

### Resolve / reopen

1. Change `status` to `resolved` or `open` in the `<local-code-review-thread>` JSON block.
2. Bump `updatedAt`.

### Delete a thread

1. Delete `threads/<threadId>.md`
2. Remove the entry from `index.json`

## Example

````md
<local-code-review-thread>
{
  "schemaVersion": 1,
  "id": "t0001",
  "target": {
    "workspaceRelativePath": "example.ts",
    "range": {
      "startLine": 0,
      "startCharacter": 0,
      "endLine": 0,
      "endCharacter": 6
    },
    "anchor": {
      "kind": "lineRange",
      "git": {
        "baseRef": "main",
        "hunkHeader": "@@ -1,3 +1,3 @@"
      }
    }
  },
  "status": "open",
  "createdAt": "2000-01-01T00:00:00.000Z",
  "updatedAt": "2000-01-01T00:00:00.000Z"
}
</local-code-review-thread>

# example.ts:L1 · open

## Patch
<local-code-review-patch lang="diff"/>

```diff
@@ -1,3 +1,3 @@
-export function add(a: number, b: number): number {
-  return a + b;
-}
+export function add(a: number, b: number): number {
+  return a - b;
+}
```

## Comments

<local-code-review-comment id="c0001" author="You" createdAt="2000-01-01T00:00:00.000Z"/>

nit: should this be `sum()` instead?

<local-code-review-comment id="c0002" author="You" createdAt="2000-01-01T00:00:10.000Z"/>

Agreed — will rename.
````

