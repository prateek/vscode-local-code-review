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

function snapshotChangedFiles(files: unknown): string {
  return `${JSON.stringify(files, null, 2)}\n`;
}

function snapshotCommentingRanges(ranges: vscode.CommentingRanges): string {
  return `${JSON.stringify(
    {
      enableFileComments: ranges.enableFileComments,
      ranges: (ranges.ranges ?? []).map((r) => ({
        startLine: r.start.line,
        startCharacter: r.start.character,
        endLine: r.end.line,
        endCharacter: r.end.character,
      })),
    },
    null,
    2,
  )}\n`;
}

suite('local-code-review phase 2 (git/diff-aware)', () => {
  async function prepare(): Promise<{ workspaceFolder: vscode.WorkspaceFolder; api: any; workspaceRoot: string }> {
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

    const workspaceRoot = workspaceFolder!.uri.fsPath;
    await initCleanRepo(workspaceRoot);
    await waitForRepoRoot(workspaceRoot);
    return { workspaceFolder: workspaceFolder!, api, workspaceRoot };
  }

  test('lists changed files in the view model', async () => {
    const { workspaceFolder, api } = await prepare();

    const docUri = vscode.Uri.joinPath(workspaceFolder.uri, 'example.ts');
    const doc = await vscode.workspace.openTextDocument(docUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const original = doc.getText();
    const updated = original.replace('a + b', 'a - b');

    await editor.edit((e) => {
      const last = doc.lineAt(doc.lineCount - 1);
      e.replace(new vscode.Range(new vscode.Position(0, 0), last.range.end), updated);
    });
    await doc.save();

    const changed = await waitFor(
      'changed files to include example.ts',
      () => api.listChangedFiles(),
      (files) => Array.isArray(files) && files.some((f: any) => f.file === 'example.ts' && f.unstaged === true),
      { timeoutMs: 15_000 },
    );

    await assertSnapshot('git.changed-files.json', snapshotChangedFiles(changed));
    await assertSnapshot('git.view.changed-files.json', api.__dumpViewForTesting());

    await editor.edit((e) => {
      const last = doc.lineAt(doc.lineCount - 1);
      e.replace(new vscode.Range(new vscode.Position(0, 0), last.range.end), original);
    });
    await doc.save();
  });

  test('onlyCommentOnChanges restricts to diff hunks', async () => {
    const { workspaceFolder, api, workspaceRoot } = await prepare();

    const longUri = vscode.Uri.joinPath(workspaceFolder.uri, 'long.ts');
    const baseline = Array.from({ length: 60 }, (_, i) => `export const n${i} = ${i};`).join('\n') + '\n';
    await vscode.workspace.fs.writeFile(longUri, new TextEncoder().encode(baseline));

    execGit(workspaceRoot, ['add', 'long.ts']);
    execGit(workspaceRoot, ['commit', '-m', 'add long.ts'], {
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    });

    const doc = await vscode.workspace.openTextDocument(longUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await editor.edit((e) => {
      const line = doc.lineAt(20);
      e.replace(line.range, 'export const n20 = 999;');
    });
    await doc.save();

    await vscode.workspace.getConfiguration('localCodeReview').update('onlyCommentOnChanges', true, vscode.ConfigurationTarget.Workspace);

    const commenting = await waitFor(
      'commenting ranges to be available',
      () => api.__getCommentingRangesForTesting(longUri),
      (r) => Array.isArray(r?.ranges) && r.ranges.length > 0,
      { timeoutMs: 15_000 },
    );
    await assertSnapshot('git.commentingRanges.long.onlyChanges.json', snapshotCommentingRanges(commenting));

    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
    const outside = await vscode.commands.executeCommand<string | undefined>('localCodeReview.addComment');
    expect(outside).to.equal(undefined);

    editor.selection = new vscode.Selection(new vscode.Position(20, 0), new vscode.Position(20, 0));
    const threadId = await vscode.commands.executeCommand<string>('localCodeReview.addComment');
    expect(threadId).to.equal('t0001');

    await vscode.commands.executeCommand('localCodeReview.submitComment', { threadId, text: 'comment inside hunk' });

    const persisted = api.getThread(threadId);
    expect(persisted?.target?.anchor?.git?.hunkHeader, 'hunkHeader should be captured when possible').to.be.a('string');
    expect(persisted?.target?.anchor?.git?.baseRef, 'baseRef should be captured when possible').to.be.a('string');

    await vscode.workspace.getConfiguration('localCodeReview').update('onlyCommentOnChanges', false, vscode.ConfigurationTarget.Workspace);
    try {
      await vscode.workspace.fs.delete(longUri, { recursive: false, useTrash: false });
    } catch {
      // ignore
    }
  });
});
