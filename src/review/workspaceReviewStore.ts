import * as vscode from 'vscode';
import * as path from 'path';

import {
  SCHEMA_VERSION,
  type PersistedAnchorContext,
  type PersistedComment,
  type PersistedIndex,
  type PersistedRange,
  type PersistedThread,
  type PersistedThreadStatus,
} from './persistedTypes';

type WriteTask<T> = () => Promise<T>;

const DEFAULT_STORAGE_PATH = '.code-review';
const LEGACY_STORAGE_PATH = '.vscode/.code-review';
const THREAD_MARKDOWN_EXTENSION = '.md';
const THREAD_META_TAG = 'local-code-review-thread';
const COMMENT_TAG = 'local-code-review-comment';
const PATCH_TAG = 'local-code-review-patch';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStoragePath(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return DEFAULT_STORAGE_PATH;
  }
  if (raw.includes('\0')) {
    return DEFAULT_STORAGE_PATH;
  }

  const normalizedSlashes = raw.replace(/\\/g, '/');
  if (normalizedSlashes.startsWith('/') || normalizedSlashes.startsWith('//')) {
    return DEFAULT_STORAGE_PATH;
  }
  if (/^[A-Za-z]:\//.test(normalizedSlashes)) {
    return DEFAULT_STORAGE_PATH;
  }

  const normalized = path.posix.normalize(normalizedSlashes).replace(/^\.\/+/, '');
  const trimmed = normalized.replace(/\/+$/, '');
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.startsWith('../')) {
    return DEFAULT_STORAGE_PATH;
  }

  return trimmed;
}

function parseNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function parseString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return value;
}

function parseNonEmptyString(value: unknown): string | undefined {
  const str = parseString(value);
  if (!str?.trim()) {
    return undefined;
  }
  return str;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    return undefined;
  }
  return value;
}

function parsePersistedRange(value: unknown): PersistedRange | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const startLine = parseNonNegativeInteger(value.startLine);
  const startCharacter = parseNonNegativeInteger(value.startCharacter);
  const endLine = parseNonNegativeInteger(value.endLine);
  const endCharacter = parseNonNegativeInteger(value.endCharacter);

  if (startLine === undefined || startCharacter === undefined || endLine === undefined || endCharacter === undefined) {
    return null;
  }

  return { startLine, startCharacter, endLine, endCharacter };
}

function parsePersistedAnchorContext(value: unknown): PersistedAnchorContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const before = parseStringArray(value.before);
  const selection = parseString(value.selection);
  const after = parseStringArray(value.after);

  if (!before || selection === undefined || !after) {
    return undefined;
  }

  return { before, selection, after };
}

function parsePersistedThreadStatus(value: unknown, legacyState: unknown): PersistedThreadStatus {
  if (value === 'open' || value === 'resolved') {
    return value;
  }
  if (legacyState === 'resolved') {
    return 'resolved';
  }
  return 'open';
}

function parsePersistedComment(value: unknown, fallbackId: string): PersistedComment | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = parseNonEmptyString(value.id) ?? fallbackId;
  const author = parseNonEmptyString(value.author) ?? 'unknown';
  const bodyMarkdown = parseString(value.bodyMarkdown) ?? parseString(value.body) ?? '';
  const createdAt = parseString(value.createdAt) ?? new Date().toISOString();

  return { id, author, bodyMarkdown, createdAt };
}

type PersistedThreadMeta = Omit<PersistedThread, 'comments'>;

function parsePersistedThreadMeta(value: unknown): PersistedThreadMeta | undefined {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) {
    return undefined;
  }

  const id = parseNonEmptyString(value.id);
  if (!id) {
    return undefined;
  }

  if (!isRecord(value.target)) {
    return undefined;
  }

  const workspaceRelativePath = parseNonEmptyString(value.target.workspaceRelativePath);
  if (!workspaceRelativePath) {
    return undefined;
  }

  const range = parsePersistedRange(value.target.range);

  const anchor: PersistedThread['target']['anchor'] = (() => {
    const raw = value.target.anchor;
    if (isRecord(raw) && raw.kind === 'lineRange') {
      const context = parsePersistedAnchorContext(raw.context);
      const git = isRecord(raw.git)
        ? {
            baseRef: parseString(raw.git.baseRef),
            hunkHeader: parseString(raw.git.hunkHeader),
            hunkPatch: parseString(raw.git.hunkPatch),
          }
        : undefined;

      return {
        kind: 'lineRange',
        context,
        git: git?.baseRef || git?.hunkHeader || git?.hunkPatch ? git : undefined,
      };
    }

    return { kind: 'lineRange' };
  })();

  const status = parsePersistedThreadStatus(value.status, value.state);
  const now = new Date().toISOString();
  const createdAt = parseString(value.createdAt) ?? now;
  const updatedAt = parseString(value.updatedAt) ?? createdAt;

  return {
    schemaVersion: 1,
    id,
    target: {
      workspaceRelativePath,
      range,
      anchor,
    },
    status,
    createdAt,
    updatedAt,
  };
}

function parsePersistedThread(value: unknown): PersistedThread | undefined {
  const meta = parsePersistedThreadMeta(value);
  if (!meta) {
    return undefined;
  }

  const commentsRaw = isRecord(value) && Array.isArray(value.comments) ? value.comments : [];
  const comments = commentsRaw
    .map((c, i) => parsePersistedComment(c, `${meta.id}:${i}`))
    .filter((c): c is PersistedComment => Boolean(c));

  return { ...meta, comments };
}

function formatRangeLabel(range: PersistedRange | null): string {
  if (!range) {
    return 'File';
  }
  const start = range.startLine + 1;
  const end = range.endLine + 1;
  return start === end ? `L${start}` : `L${start}-L${end}`;
}

function serializeThreadMarkdown(thread: PersistedThread): string {
  const { comments, ...metaBase } = thread;
  const meta: PersistedThreadMeta = (() => {
    const anchor = metaBase.target.anchor;
    const git = anchor.git ? { ...anchor.git } : undefined;
    if (git) {
      delete git.hunkPatch;
    }

    return {
      ...metaBase,
      target: {
        ...metaBase.target,
        anchor: {
          ...anchor,
          git: git && (git.baseRef || git.hunkHeader) ? git : undefined,
        },
      },
    };
  })();

  const hunkPatch = metaBase.target.anchor.git?.hunkPatch;

  const headerLabel = `${thread.target.workspaceRelativePath}:${formatRangeLabel(thread.target.range)} · ${thread.status}`;
  const lines: string[] = [];

  lines.push(`<${THREAD_META_TAG}>`);
  lines.push(JSON.stringify(meta, null, 2));
  lines.push(`</${THREAD_META_TAG}>`);
  lines.push('');
  lines.push(`# ${headerLabel}`);

  const context = thread.target.anchor.context;
  if (context) {
    lines.push('');
    lines.push('## Context');

    lines.push('');
    lines.push('### Before');
    lines.push('```text');
    lines.push(...context.before);
    lines.push('```');

    lines.push('');
    lines.push('### Selection');
    lines.push('```text');
    const selectionLines = context.selection.replace(/\r\n/g, '\n').split('\n');
    lines.push(...selectionLines);
    lines.push('```');

    lines.push('');
    lines.push('### After');
    lines.push('```text');
    lines.push(...context.after);
    lines.push('```');
  }

  const git = thread.target.anchor.git;
  if (git?.baseRef || git?.hunkHeader) {
    lines.push('');
    lines.push('## Git');
    if (git.baseRef) {
      lines.push(`- baseRef: ${git.baseRef}`);
    }
    if (git.hunkHeader) {
      lines.push(`- hunkHeader: ${git.hunkHeader}`);
    }
  }

  const patch = hunkPatch?.trimEnd();
  if (patch) {
    lines.push('');
    lines.push('## Patch');
    lines.push(`<${PATCH_TAG} lang="diff"/>`);
    lines.push('');
    lines.push('```diff');
    lines.push(...patch.replace(/\r\n/g, '\n').split('\n'));
    lines.push('```');
  }

  lines.push('');
  lines.push('## Comments');

  for (const comment of comments) {
    lines.push('');
    const escapeXmlAttr = (value: string): string =>
      value
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
    const metaLine = `<${COMMENT_TAG} id="${escapeXmlAttr(comment.id)}" author="${escapeXmlAttr(comment.author)}" createdAt="${escapeXmlAttr(comment.createdAt)}"/>`;
    lines.push(metaLine);
    lines.push('');
    const body = comment.bodyMarkdown.trimEnd();
    if (body) {
      lines.push(...body.replace(/\r\n/g, '\n').split('\n'));
    }
  }

  return `${lines.join('\n')}\n`;
}

function parseThreadMarkdown(markdown: string): PersistedThread | undefined {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  let i = 0;
  while (i < lines.length && lines[i].trim() !== `<${THREAD_META_TAG}>`) {
    i += 1;
  }
  if (i >= lines.length) {
    return undefined;
  }

  i += 1;
  const metaLines: string[] = [];
  while (i < lines.length && lines[i].trim() !== `</${THREAD_META_TAG}>`) {
    metaLines.push(lines[i]!);
    i += 1;
  }
  if (i >= lines.length) {
    return undefined;
  }
  i += 1;

  let metaObject: unknown;
  try {
    metaObject = JSON.parse(metaLines.join('\n').trim());
  } catch {
    return undefined;
  }

  const meta = parsePersistedThreadMeta(metaObject);
  if (!meta) {
    return undefined;
  }

  const comments: PersistedComment[] = [];
  let commentIndex = 0;
  let j = i;

  // Extract an optional Patch code fence following a <local-code-review-patch/> marker.
  for (let k = i; k < lines.length; k += 1) {
    const line = (lines[k] ?? '').trim();
    if (!line.startsWith(`<${PATCH_TAG}`)) {
      continue;
    }

    // Find the next fenced block (```diff or ```patch).
    for (let m = k + 1; m < lines.length; m += 1) {
      const fenceLine = (lines[m] ?? '').trimEnd();
      if (!fenceLine.startsWith('```')) {
        continue;
      }
      const lang = fenceLine.slice(3).trim();
      if (lang !== 'diff' && lang !== 'patch') {
        continue;
      }
      m += 1;
      const patchLines: string[] = [];
      while (m < lines.length && (lines[m]?.trimEnd() ?? '') !== '```') {
        patchLines.push(lines[m]!);
        m += 1;
      }
      const patch = patchLines.join('\n').trimEnd();
      if (patch) {
        const existing = meta.target.anchor.git ?? {};
        meta.target.anchor.git = { ...existing, hunkPatch: patch };
      }
      break;
    }
    break;
  }

  while (j < lines.length) {
    const raw = (lines[j] ?? '').trim();
    if (!raw.startsWith(`<${COMMENT_TAG}`)) {
      j += 1;
      continue;
    }

    const attrs = raw;
    const idMatch = /\bid="([^"]*)"/.exec(attrs);
    const authorMatch = /\bauthor="([^"]*)"/.exec(attrs);
    const createdAtMatch = /\bcreatedAt="([^"]*)"/.exec(attrs);

    const fallbackId = `${meta.id}:${commentIndex}`;
    commentIndex += 1;
    const fallbackCreatedAt = meta.updatedAt || meta.createdAt;

    const commentId = (idMatch?.[1] ?? '').trim() || fallbackId;
    const unescapeXmlAttr = (value: string): string =>
      value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    const author = unescapeXmlAttr((authorMatch?.[1] ?? '')).trim() || 'unknown';
    const createdAt = (createdAtMatch?.[1] ?? '').trim() || fallbackCreatedAt;

    j += 1;
    if (j < lines.length && lines[j] === '') {
      j += 1;
    }

    const bodyLines: string[] = [];
    while (j < lines.length && !(lines[j] ?? '').trim().startsWith(`<${COMMENT_TAG}`)) {
      bodyLines.push(lines[j]!);
      j += 1;
    }
    const bodyMarkdown = bodyLines.join('\n').trimEnd();

    comments.push({ id: commentId, author, createdAt, bodyMarkdown });
  }

  return { ...meta, comments };
}

export class WorkspaceReviewStore implements vscode.Disposable {
  private readonly rootUri: vscode.Uri;
  private readonly rootRelativePath: string;
  private readonly legacyRootUri: vscode.Uri;
  private readonly threadsDirUri: vscode.Uri;
  private readonly legacyCommentsDirUri: vscode.Uri;
  private readonly indexUri: vscode.Uri;
  private readonly agentsUri: vscode.Uri;

  private writeChain: Promise<unknown> = Promise.resolve();
  private migrationInProgress = false;
  private legacyRootMigrated = false;

  constructor(readonly workspaceFolder: vscode.WorkspaceFolder) {
    const config = vscode.workspace.getConfiguration('localCodeReview', this.workspaceFolder.uri);
    this.rootRelativePath = normalizeStoragePath(config.get<string>('storagePath'));

    const parts = this.rootRelativePath.split('/').filter(Boolean);
    this.rootUri = vscode.Uri.joinPath(this.workspaceFolder.uri, ...parts);
    this.legacyRootUri = vscode.Uri.joinPath(this.workspaceFolder.uri, ...LEGACY_STORAGE_PATH.split('/'));
    this.threadsDirUri = vscode.Uri.joinPath(this.rootUri, 'threads');
    this.legacyCommentsDirUri = vscode.Uri.joinPath(this.rootUri, 'comments');
    this.indexUri = vscode.Uri.joinPath(this.rootUri, 'index.json');
    this.agentsUri = vscode.Uri.joinPath(this.rootUri, 'AGENTS.md');
  }

  dispose() {}

  getRootUri(): vscode.Uri {
    return this.rootUri;
  }

  getRootRelativePath(): string {
    return this.rootRelativePath;
  }

  getThreadsDirUri(): vscode.Uri {
    return this.threadsDirUri;
  }

  getThreadUri(threadId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.threadsDirUri, `${threadId}${THREAD_MARKDOWN_EXTENSION}`);
  }

  private getLegacyThreadJsonUri(threadId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.threadsDirUri, `${threadId}.json`);
  }

  async ensureInitialized(): Promise<void> {
    await this.tryMigrateLegacyRootDir();
    await vscode.workspace.fs.createDirectory(this.threadsDirUri);
    // Keep legacy dir present (even if empty) to avoid noisy ENOENT logs from readDirectory.
    await vscode.workspace.fs.createDirectory(this.legacyCommentsDirUri);
    await this.ensureAgentsFile();
    await this.ensureIndexFile();
    await this.tryMigrateLegacyCommentsDir();
    await this.tryMigrateLegacyThreadJsonFiles();
  }

  async clearAllComments(): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.ensureInitialized();

      // Clear both current and legacy storage locations.
      try {
        await vscode.workspace.fs.delete(this.legacyCommentsDirUri, { recursive: true, useTrash: false });
      } catch {
        // ignore
      }
      await vscode.workspace.fs.delete(this.threadsDirUri, { recursive: true, useTrash: false });
      await vscode.workspace.fs.createDirectory(this.threadsDirUri);
      await this.writeIndex({ schemaVersion: SCHEMA_VERSION, threads: [] });
    });
  }

  async listThreadIds(): Promise<string[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.threadsDirUri);
    } catch {
      return [];
    }

    const ids = new Set<string>();
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File) {
        continue;
      }
      if (name.endsWith(THREAD_MARKDOWN_EXTENSION)) {
        ids.add(name.slice(0, -THREAD_MARKDOWN_EXTENSION.length));
      } else if (name.endsWith('.json')) {
        ids.add(name.slice(0, -'.json'.length));
      }
    }
    return [...ids].sort();
  }

  async readThread(threadId: string): Promise<PersistedThread | undefined> {
    const mdUri = this.getThreadUri(threadId);
    const rawMd = await this.tryReadFile(mdUri);
    if (rawMd) {
      try {
        const parsed = parseThreadMarkdown(new TextDecoder('utf-8').decode(rawMd));
        if (parsed) {
          return parsed;
        }
      } catch {
        return undefined;
      }
    }

    // Legacy fallback: read JSON thread files if present.
    const jsonUri = this.getLegacyThreadJsonUri(threadId);
    const rawJson = await this.tryReadFile(jsonUri);
    if (!rawJson) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(new TextDecoder('utf-8').decode(rawJson)) as unknown;
      return parsePersistedThread(parsed);
    } catch {
      return undefined;
    }
  }

  async writeThread(thread: PersistedThread): Promise<void> {
    await this.enqueueWrite(async () => {
      if (!this.migrationInProgress) {
        await this.ensureInitialized();
      }
      await this.writeText(this.getThreadUri(thread.id), serializeThreadMarkdown(thread));
      await this.tryDelete(this.getLegacyThreadJsonUri(thread.id));

      const index = await this.readIndex();
      const threads = index.threads.filter((t) => t.id !== thread.id);
      threads.push({
        id: thread.id,
        file: thread.target.workspaceRelativePath,
        range: thread.target.range,
        status: thread.status,
        updatedAt: thread.updatedAt,
      });
      threads.sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
      await this.writeIndex({ schemaVersion: SCHEMA_VERSION, threads });
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      if (!this.migrationInProgress) {
        await this.ensureInitialized();
      }
      await this.tryDelete(this.getThreadUri(threadId));
      await this.tryDelete(this.getLegacyThreadJsonUri(threadId));
      const index = await this.readIndex();
      const threads = index.threads.filter((t) => t.id !== threadId);
      await this.writeIndex({ schemaVersion: SCHEMA_VERSION, threads });
    });
  }

  async readIndex(): Promise<PersistedIndex> {
    const raw = await this.tryReadFile(this.indexUri);
    if (!raw) {
      return { schemaVersion: SCHEMA_VERSION, threads: [] };
    }

    let parsed: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parsed = JSON.parse(new TextDecoder('utf-8').decode(raw)) as any;
    } catch {
      return { schemaVersion: SCHEMA_VERSION, threads: [] };
    }
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed?.threads)) {
      return { schemaVersion: SCHEMA_VERSION, threads: [] };
    }

    const threads = parsed.threads
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((t: any) => {
        const status =
          typeof t?.status === 'string'
            ? t.status
            : typeof t?.state === 'string'
              ? t.state === 'resolved'
                ? 'resolved'
                : 'open'
              : 'open';

        return {
          id: String(t?.id ?? ''),
          file: String(t?.file ?? ''),
          range: t?.range ?? null,
          status,
          updatedAt: String(t?.updatedAt ?? ''),
        };
      })
      .filter((t: { id: string; file: string }) => Boolean(t.id) && Boolean(t.file));

    return { schemaVersion: SCHEMA_VERSION, threads };
  }

  private async writeIndex(index: PersistedIndex): Promise<void> {
    await this.writeJson(this.indexUri, index);
  }

  private async ensureIndexFile(): Promise<void> {
    const raw = await this.tryReadFile(this.indexUri);
    if (raw) {
      return;
    }
    await this.writeJson(this.indexUri, { schemaVersion: SCHEMA_VERSION, threads: [] });
  }

  private async ensureAgentsFile(): Promise<void> {
    const raw = await this.tryReadFile(this.agentsUri);
    if (raw) {
      return;
    }

    const contents = [
      '# Local Code Review — Comment Store',
      '',
      'This directory is owned by the **Local Code Review** VS Code extension.',
      '',
      'Note: The storage directory is configurable via `localCodeReview.storagePath` in VS Code settings.',
      '',
      '## Files',
      '',
      '- `threads/*.md`: one file per thread (Markdown, round-trippable).',
      '- `index.json`: lightweight index for listing threads quickly.',
      '',
      '## Thread file format (`threads/<threadId>.md`)',
      '',
      '- The file starts with a `<local-code-review-thread>...</local-code-review-thread>` JSON block (thread metadata).',
      '- Comments are stored as repeating `<local-code-review-comment .../>` markers followed by Markdown bodies.',
      '- Optional patch snapshot is stored after a `<local-code-review-patch .../>` marker as a fenced ```diff block.',
      '',
      '## How LLMs should interact',
      '',
      '- To **reply**: append a new `<local-code-review-comment .../>` marker with a new id + timestamp, then write the Markdown body below it.',
      '- To **resolve** / **reopen**: update `status` in the top `<local-code-review-thread>` JSON block, and bump `updatedAt`.',
      '- To **delete a thread**: delete `threads/<threadId>.md` and remove it from `index.json`.',
      '',
      '## Guardrails',
      '',
      '- Do not modify source code files unless explicitly requested by the user.',
      '- Prefer small, local edits; avoid renaming thread IDs.',
      '',
    ].join('\n');

    await this.writeText(this.agentsUri, contents);
  }

  private async tryMigrateLegacyRootDir(): Promise<void> {
    if (this.legacyRootMigrated) {
      return;
    }
    this.legacyRootMigrated = true;

    if (this.rootUri.toString() === this.legacyRootUri.toString()) {
      return;
    }

    try {
      await vscode.workspace.fs.rename(this.legacyRootUri, this.rootUri, { overwrite: false });
    } catch {
      // ignore (leave legacy location in place)
    }
  }

  private async tryMigrateLegacyCommentsDir(): Promise<void> {
    // Best-effort migration from older experiments that stored threads under `comments/`.
    const entries = await this.tryReadDirectory(this.legacyCommentsDirUri);
    if (!entries || entries.length === 0) {
      return;
    }

    const legacyThreadIds = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
      .map(([name]) => name.slice(0, -'.json'.length));

    if (legacyThreadIds.length === 0) {
      return;
    }

    // If `threads/` already has content, assume migration already happened.
    const current = await this.tryReadDirectory(this.threadsDirUri);
    if (current && current.some(([, type]) => type === vscode.FileType.File)) {
      return;
    }

    this.migrationInProgress = true;
    try {
      const migratedThreads: PersistedThread[] = [];

      for (const threadId of legacyThreadIds) {
        const legacyUri = vscode.Uri.joinPath(this.legacyCommentsDirUri, `${threadId}.json`);
        const raw = await this.tryReadFile(legacyUri);
        if (!raw) {
          continue;
        }
        let legacy: any;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          legacy = JSON.parse(new TextDecoder('utf-8').decode(raw)) as any;
        } catch {
          continue;
        }

        if (legacy?.schemaVersion !== 1 || typeof legacy?.id !== 'string') {
          continue;
        }

        const migrated: PersistedThread = {
          schemaVersion: 1,
          id: legacy.id,
          target: {
            workspaceRelativePath: String(legacy.file ?? ''),
            range: legacy.range
              ? {
                  startLine: legacy.range.start?.line ?? 0,
                  startCharacter: legacy.range.start?.character ?? 0,
                  endLine: legacy.range.end?.line ?? 0,
                  endCharacter: legacy.range.end?.character ?? 0,
                }
              : null,
            anchor: { kind: 'lineRange' },
          },
          status: legacy.state === 'resolved' ? 'resolved' : 'open',
          comments: Array.isArray(legacy.comments) ? legacy.comments : [],
          createdAt: typeof legacy.createdAt === 'string' ? legacy.createdAt : new Date().toISOString(),
          updatedAt: typeof legacy.updatedAt === 'string' ? legacy.updatedAt : new Date().toISOString(),
        };

        migratedThreads.push(migrated);
        await this.writeText(this.getThreadUri(migrated.id), serializeThreadMarkdown(migrated));
      }

      const threads = migratedThreads
        .map((t) => ({
          id: t.id,
          file: t.target.workspaceRelativePath,
          range: t.target.range,
          status: t.status,
          updatedAt: t.updatedAt,
        }))
        .sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));

      await this.writeIndex({ schemaVersion: SCHEMA_VERSION, threads });

      // Delete the legacy folder so we don't repeatedly re-migrate.
      try {
        await vscode.workspace.fs.delete(this.legacyCommentsDirUri, { recursive: true, useTrash: false });
      } catch {
        // ignore
      }
    } finally {
      this.migrationInProgress = false;
    }
  }

  private async tryMigrateLegacyThreadJsonFiles(): Promise<void> {
    const entries = await this.tryReadDirectory(this.threadsDirUri);
    if (!entries) {
      return;
    }

    const legacyThreadIds = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
      .map(([name]) => name.slice(0, -'.json'.length));

    if (legacyThreadIds.length === 0) {
      return;
    }

    this.migrationInProgress = true;
    try {
      for (const threadId of legacyThreadIds) {
        const raw = await this.tryReadFile(this.getLegacyThreadJsonUri(threadId));
        if (!raw) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder('utf-8').decode(raw)) as unknown;
        } catch {
          continue;
        }

        const thread = parsePersistedThread(parsed);
        if (!thread) {
          continue;
        }

        await this.writeThread(thread);
      }
    } finally {
      this.migrationInProgress = false;
    }
  }

  private enqueueWrite<T>(task: WriteTask<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async tryReadFile(uri: vscode.Uri): Promise<Uint8Array | undefined> {
    try {
      return await vscode.workspace.fs.readFile(uri);
    } catch {
      return undefined;
    }
  }

  private async tryReadDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][] | undefined> {
    try {
      return await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return undefined;
    }
  }

  private async tryDelete(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
    } catch {
      // ignore
    }
  }

  private async writeJson(uri: vscode.Uri, data: unknown): Promise<void> {
    await this.writeText(uri, `${JSON.stringify(data, null, 2)}\n`);
  }

  private async writeText(uri: vscode.Uri, text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text);
    await vscode.workspace.fs.writeFile(uri, bytes);
  }
}
