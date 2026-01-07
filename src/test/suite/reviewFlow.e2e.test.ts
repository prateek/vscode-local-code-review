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

async function resetExampleFile(workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
  const uri = vscode.Uri.joinPath(workspaceFolder.uri, 'example.ts');
  const doc = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  const last = doc.lineAt(doc.lineCount - 1);
  edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), last.range.end), EXAMPLE_TS_BASELINE);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
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
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const api = await tryGetGitApi();
    const repo = api?.getRepository(workspaceUri) ?? null;
    if (repo && repo.rootUri.fsPath === workspaceRoot) {
      return;
    }
    if (Date.now() - start > 15_000) {
      throw new Error('Timed out waiting for vscode.git to detect the test repository');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

suite('local-code-review flow (e2e)', () => {
  async function prepare(): Promise<{ workspaceFolder: vscode.WorkspaceFolder; api: any }> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    expect(workspaceFolder, 'test workspace should be opened').to.not.equal(undefined);
    await resetExampleFile(workspaceFolder!);

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

  test('create thread, submit comment, and persist snapshots', async () => {
    const { workspaceFolder, api } = await prepare();

    const reviewRoot = vscode.Uri.joinPath(workspaceFolder.uri, '.code-review');
    const indexFile = vscode.Uri.joinPath(reviewRoot, 'index.json');
    // Corrupt index.json to ensure store parsing is resilient.
    await vscode.workspace.fs.writeFile(indexFile, new TextEncoder().encode('{ this is not json'));

    const docUri = vscode.Uri.joinPath(workspaceFolder!.uri, 'example.ts');
    const doc = await vscode.workspace.openTextDocument(docUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 6));

    const threadId = await vscode.commands.executeCommand<string>('localCodeReview.addComment');
    expect(threadId).to.equal('t0001');

    await vscode.commands.executeCommand('localCodeReview.submitComment', { threadId, text: 'LGTM' });

    const threadFile = vscode.Uri.joinPath(reviewRoot, 'threads', `${threadId}.md`);
    const agentsFile = vscode.Uri.joinPath(reviewRoot, 'AGENTS.md');

    const [threadJson, indexJson] = await Promise.all([readText(threadFile), readText(indexFile)]);
    expect(threadJson).to.contain('LGTM');
    expect(indexJson).to.contain(`\"${threadId}\"`);

    expect(await vscode.workspace.fs.stat(agentsFile)).to.not.equal(undefined);

    await assertSnapshot('thread.t0001.md', threadJson);
    await assertSnapshot('index.json', indexJson);

    const view = JSON.parse(api.__dumpViewForTesting()) as any;
    view.files = Array.isArray(view.files) ? view.files.filter((f: any) => Array.isArray(f.threads) && f.threads.length > 0) : [];
    await assertSnapshot('view.after-one-thread.json', `${JSON.stringify(view, null, 2)}\n`);
  });

  test('resolve + reopen updates persisted state', async () => {
    const { workspaceFolder } = await prepare();

    const docUri = vscode.Uri.joinPath(workspaceFolder.uri, 'example.ts');
    const doc = await vscode.workspace.openTextDocument(docUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 6));

    const threadId = await vscode.commands.executeCommand<string>('localCodeReview.addComment');
    expect(threadId).to.equal('t0001');
    await vscode.commands.executeCommand('localCodeReview.submitComment', { threadId, text: 'nit: rename this' });

    await vscode.commands.executeCommand('localCodeReview.resolveThread', { threadId });
    await vscode.commands.executeCommand('localCodeReview.reopenThread', { threadId });

    const reviewRoot = vscode.Uri.joinPath(workspaceFolder.uri, '.code-review');
    const threadFile = vscode.Uri.joinPath(reviewRoot, 'threads', `${threadId}.md`);
    const indexFile = vscode.Uri.joinPath(reviewRoot, 'index.json');

    await assertSnapshot('thread.t0001.reopened.md', await readText(threadFile));
    await assertSnapshot('index.reopened.json', await readText(indexFile));
  });

  test('apply suggestion edits the document', async () => {
    const { workspaceFolder } = await prepare();

    const docUri = vscode.Uri.joinPath(workspaceFolder.uri, 'example.ts');
    const doc = await vscode.workspace.openTextDocument(docUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    const targetLine = 1;
    const targetText = doc.lineAt(targetLine).text;
    editor.selection = new vscode.Selection(
      new vscode.Position(targetLine, 0),
      new vscode.Position(targetLine, targetText.length),
    );

    const threadId = await vscode.commands.executeCommand<string>('localCodeReview.addComment');
    expect(threadId).to.equal('t0001');

    await vscode.commands.executeCommand('localCodeReview.submitComment', {
      threadId,
      text: ['```suggestion', '  return a - b;', '```'].join('\n'),
    });

    await vscode.commands.executeCommand('localCodeReview.applySuggestion', { threadId });

    await assertSnapshot('example.after-suggestion.ts', doc.getText());
  });
});
