import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

import { expect } from 'chai';
import * as vscode from 'vscode';

const CAPTURE = process.env.CAPTURE_README_MEDIA === '1';

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'ignore' });
}

async function exists(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then(() => true)
    .catch(() => false);
}

if (CAPTURE) {
  suite('readme media (capture)', () => {
    test('captures README screenshot + demo gif', async function () {
      this.timeout(120_000);

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      expect(workspaceFolder, 'test workspace should be opened').to.not.equal(undefined);

      const ext = vscode.extensions.getExtension('prateek.local-code-review');
      expect(ext, 'extension should be present').to.not.equal(undefined);

      await ext!.activate();

      const mediaDir = path.join(ext!.extensionPath, 'media');
      await fs.mkdir(mediaDir, { recursive: true });

      const tmpDir = path.join(mediaDir, '.capture-tmp');
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.mkdir(tmpDir, { recursive: true });

      const frames = [
        path.join(tmpDir, 'frame-1.png'),
        path.join(tmpDir, 'frame-2.png'),
        path.join(tmpDir, 'frame-3.png'),
      ];
      const screenshotPath = path.join(mediaDir, 'screenshot.png');
      const gifPath = path.join(mediaDir, 'demo.gif');

      await vscode.commands.executeCommand('localCodeReview.clearAllComments', { force: true });
      await vscode.workspace
        .getConfiguration('localCodeReview')
        .update('onlyCommentOnChanges', false, vscode.ConfigurationTarget.Workspace);

      const docUri = vscode.Uri.joinPath(workspaceFolder!.uri, 'example.ts');
      const doc = await vscode.workspace.openTextDocument(docUri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 6));

      const threadId = await vscode.commands.executeCommand<string>('localCodeReview.addComment');
      expect(threadId).to.be.a('string').and.not.equal('');

      await sleep(800);
      run('import', ['-window', 'root', frames[0]!]);

      await vscode.commands.executeCommand('localCodeReview.submitComment', { threadId, text: 'LGTM' });
      await sleep(800);
      run('import', ['-window', 'root', frames[1]!]);

      try {
        await vscode.commands.executeCommand('workbench.action.openView', 'localCodeReview.commentsPanel');
      } catch {
        // ignore (best-effort; still capture the editor view)
      }
      await sleep(800);
      run('import', ['-window', 'root', frames[2]!]);

      await fs.copyFile(frames[2]!, screenshotPath);

      run('convert', [
        ...frames,
        '-resize',
        '960x',
        '-delay',
        '120',
        '-loop',
        '0',
        '-layers',
        'Optimize',
        gifPath,
      ]);

      try {
        run('gifsicle', ['-O3', '-o', gifPath, gifPath]);
      } catch {
        // ignore
      }

      expect(await exists(screenshotPath), 'screenshot.png should be created').to.equal(true);
      expect(await exists(gifPath), 'demo.gif should be created').to.equal(true);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });
}

