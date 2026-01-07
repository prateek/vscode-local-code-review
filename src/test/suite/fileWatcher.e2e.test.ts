import { execFileSync } from 'child_process';
import { expect } from 'chai';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

import { tryGetGitApi } from '../../review/git';
import { assertSnapshot } from './snapshots';

const EXAMPLE_TS_BASELINE = ['export function add(a: number, b: number): number {', '  return a + b;', '}', ''].join('\n');

class TestClock {
  private tick = 0;
  now(): Date {
    const base = Date.UTC(2000, 0, 1, 0, 0, 0);
    return new Date(base + this.tick++ * 1000);
  }
}

class TestIdGenerator {
  private thread = 0;
  private comment = 0;

  newThreadId(): string {
    this.thread += 1;
    return `t${String(this.thread).padStart(4, '0')}`;
  }

  newCommentId(): string {
    this.comment += 1;
    return `c${String(this.comment).padStart(4, '0')}`;
  }
}

async function readText(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(bytes);
}

async function writeText(uri: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

function execGit(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function initCleanRepo(workspaceRoot: string): Promise<void> {
  const gitDir = path.join(workspaceRoot, '.git');
  const hasGit = await fs
    .stat(gitDir)
    .then(() => true)
    .catch(() => false);

  if (!hasGit) {
    try {
      execGit(workspaceRoot, ['init', '-b', 'main']);
    } catch {
      execGit(workspaceRoot, ['init']);
      execGit(workspaceRoot, ['checkout', '-b', 'main']);
    }
  }

  execGit(workspaceRoot, ['config', 'user.email', 'test@example.com']);
  execGit(workspaceRoot, ['config', 'user.name', 'Test']);

  if (hasGit) {
    execGit(workspaceRoot, ['checkout', '-B', 'main']);
    let root = '';
    try {
      root = execGit(workspaceRoot, ['rev-list', '--max-parents=0', 'HEAD']).trim().split('\n')[0] ?? '';
    } catch {
      root = '';
    }

    if (root) {
      execGit(workspaceRoot, ['reset', '--hard', root]);
    }
    execGit(workspaceRoot, ['clean', '-fd']);
    return;
  }

  execGit(workspaceRoot, ['add', '-A']);
  execGit(workspaceRoot, ['commit', '-m', 'init'], {
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  });
}

async function waitForRepoRoot(workspaceRoot: string): Promise<void> {
  const workspaceUri = vscode.Uri.file(workspaceRoot);
  await waitFor(
    'vscode.git to detect the test repository',
    async () => {
      const api = await tryGetGitApi();
      return api?.getRepository(workspaceUri) ?? null;
    },
    (repo) => Boolean(repo && repo.rootUri.fsPath === workspaceRoot),
    { timeoutMs: 15_000 },
  );
}

async function waitFor<T>(
  label: string,
  fn: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const intervalMs = opts?.intervalMs ?? 100;

  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const value = await fn();
    if (predicate(value)) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

suite('local-code-review hot reload (file watcher)', () => {
  async function prepare(): Promise<{ workspaceFolder: vscode.WorkspaceFolder; api: any }> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    expect(workspaceFolder, 'test workspace should be opened').to.not.equal(undefined);

    const exampleUri = vscode.Uri.joinPath(workspaceFolder!.uri, 'example.ts');
    const doc = await vscode.workspace.openTextDocument(exampleUri);
    const edit = new vscode.WorkspaceEdit();
    const last = doc.lineAt(doc.lineCount - 1);
    edit.replace(exampleUri, new vscode.Range(new vscode.Position(0, 0), last.range.end), EXAMPLE_TS_BASELINE);
    await vscode.workspace.applyEdit(edit);
    await doc.save();

    const ext = vscode.extensions.getExtension('prateek.local-code-review');
    expect(ext, 'extension should be present').to.not.equal(undefined);

    const api = (await ext!.activate()) as any;
    api.__setTestingHooks({ clock: new TestClock(), idGenerator: new TestIdGenerator() });

    await vscode.commands.executeCommand('localCodeReview.clearAllComments', { force: true });
    await vscode.workspace.getConfiguration('localCodeReview').update('onlyCommentOnChanges', false, vscode.ConfigurationTarget.Workspace);
    await initCleanRepo(workspaceFolder!.uri.fsPath);
    await waitForRepoRoot(workspaceFolder!.uri.fsPath);
    return { workspaceFolder: workspaceFolder!, api };
  }

  test('editing thread markdown on disk updates in-memory threads', async () => {
    const { workspaceFolder, api } = await prepare();

    const docUri = vscode.Uri.joinPath(workspaceFolder.uri, 'example.ts');
    const doc = await vscode.workspace.openTextDocument(docUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 6));

    const threadId = await vscode.commands.executeCommand<string>('localCodeReview.addComment');
    expect(threadId).to.equal('t0001');

    await vscode.commands.executeCommand('localCodeReview.submitComment', { threadId, text: 'original comment' });

    const reviewRoot = vscode.Uri.joinPath(workspaceFolder.uri, '.code-review');
    const threadFile = vscode.Uri.joinPath(reviewRoot, 'threads', `${threadId}.md`);

    const originalMd = await readText(threadFile);
    await assertSnapshot('watcher.thread.before.md', originalMd);

    const lines = originalMd.replace(/\r\n/g, '\n').split('\n');
    const metaStart = lines.findIndex((l) => l.trim() === '<local-code-review-thread>');
    expect(metaStart).to.be.greaterThan(-1);
    const metaEnd = lines.findIndex((l, idx) => idx > metaStart && l.trim() === '</local-code-review-thread>');
    expect(metaEnd).to.be.greaterThan(metaStart);

    const metaJson = lines.slice(metaStart + 1, metaEnd).join('\n').trim();
    const meta = JSON.parse(metaJson) as any;
    meta.status = 'resolved';
    meta.updatedAt = '2000-01-01T00:00:09.000Z';
    const nextMetaLines = JSON.stringify(meta, null, 2).split('\n');
    lines.splice(metaStart + 1, metaEnd - metaStart - 1, ...nextMetaLines);

    const commentMarker = lines.findIndex((l) => l.trim().startsWith('<local-code-review-comment'));
    expect(commentMarker).to.be.greaterThan(-1);
    let bodyStart = commentMarker + 1;
    if (lines[bodyStart] === '') {
      bodyStart += 1;
    }
    let bodyEnd = bodyStart;
    while (bodyEnd < lines.length && !lines[bodyEnd]!.trim().startsWith('<local-code-review-comment')) {
      bodyEnd += 1;
    }
    lines.splice(bodyStart, bodyEnd - bodyStart, 'edited comment');

    await writeText(threadFile, `${lines.join('\n')}\n`);

    await waitFor(
      'thread to reload after external edit',
      () => api.getThread(threadId),
      (t) => t?.status === 'resolved' && t?.comments?.[0]?.bodyMarkdown === 'edited comment',
    );

    await assertSnapshot('watcher.thread.after.md', await readText(threadFile));
  });

  test('unsafe workspaceRelativePath is ignored (no path traversal)', async () => {
    const { workspaceFolder, api } = await prepare();

    const reviewRoot = vscode.Uri.joinPath(workspaceFolder.uri, '.code-review');
    const threadFile = vscode.Uri.joinPath(reviewRoot, 'threads', 't9999.md');

    const safeMeta = {
      schemaVersion: 1,
      id: 't9999',
      target: {
        workspaceRelativePath: 'example.ts',
        range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 6 },
        anchor: { kind: 'lineRange' },
      },
      status: 'open',
      createdAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2000-01-01T00:00:00.000Z',
    };

    const safeThread = [
      '<local-code-review-thread>',
      JSON.stringify(safeMeta, null, 2),
      '</local-code-review-thread>',
      '',
      '# example.ts:L1 · open',
      '',
      '<local-code-review-comment id="c0001" author="You" createdAt="2000-01-01T00:00:00.000Z"/>',
      '',
      'hello',
      '',
    ].join('\n');

    await writeText(threadFile, `${safeThread}\n`);

    await waitFor('thread to load after creating JSON on disk', () => api.getThread('t9999'), (t) => Boolean(t));

    const unsafeMeta = {
      ...safeMeta,
      target: { ...safeMeta.target, workspaceRelativePath: '../escape.ts' },
      updatedAt: '2000-01-01T00:00:01.000Z',
    };
    const unsafeThread = safeThread.replace(JSON.stringify(safeMeta, null, 2), JSON.stringify(unsafeMeta, null, 2));
    await writeText(threadFile, `${unsafeThread}\n`);

    await waitFor('thread to be dropped due to unsafe path', () => api.getThread('t9999'), (t) => t === undefined);
  });
});
