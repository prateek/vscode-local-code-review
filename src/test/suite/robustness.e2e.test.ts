import { expect } from 'chai';
import * as vscode from 'vscode';

import { findSuggestionBlocks } from '../../review/suggestions';
import { WorkspaceReviewStore } from '../../review/workspaceReviewStore';

suite('local-code-review robustness', () => {
  test('findSuggestionBlocks is stateless across calls', () => {
    const md = ['hello', '```suggestion', '  return a - b;', '```', 'bye'].join('\n');
    const a = findSuggestionBlocks(md);
    const b = findSuggestionBlocks(md);

    expect(a).to.have.length(1);
    expect(b).to.have.length(1);
    expect(a[0]?.replacementText).to.contain('return a - b;');
    expect(b[0]?.replacementText).to.contain('return a - b;');
  });

  test('readThread returns undefined for parseable but invalid thread markdown', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    expect(workspaceFolder, 'test workspace should be opened').to.not.equal(undefined);

    const store = new WorkspaceReviewStore(workspaceFolder!);
    await store.ensureInitialized();

    const threadId = 't-invalid';
    const threadUri = store.getThreadUri(threadId);
    const invalidMeta = { schemaVersion: 1, id: threadId };
    const invalid = [
      '<local-code-review-thread>',
      JSON.stringify(invalidMeta, null, 2),
      '</local-code-review-thread>',
      '',
      '# invalid',
      '',
    ].join('\n');
    await vscode.workspace.fs.writeFile(threadUri, new TextEncoder().encode(`${invalid}\n`));

    expect(await store.readThread(threadId)).to.equal(undefined);
  });

  test('addComment clamps out-of-range lineNumber', async () => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    expect(workspaceFolder, 'test workspace should be opened').to.not.equal(undefined);

    const ext = vscode.extensions.getExtension('prateek.local-code-review');
    expect(ext, 'extension should be present').to.not.equal(undefined);
    await ext!.activate();

    await vscode.commands.executeCommand('localCodeReview.clearAllComments', { force: true });
    await vscode.workspace.getConfiguration('localCodeReview').update('onlyCommentOnChanges', false, vscode.ConfigurationTarget.Workspace);

    const docUri = vscode.Uri.joinPath(workspaceFolder!.uri, 'example.ts');
    const doc = await vscode.workspace.openTextDocument(docUri);

    const threadId = await vscode.commands.executeCommand<string>('localCodeReview.addComment', docUri, 999_999);
    expect(threadId).to.be.a('string').and.not.equal('');

    const store = new WorkspaceReviewStore(workspaceFolder!);
    await store.ensureInitialized();
    const persisted = await store.readThread(threadId);
    expect(persisted?.target?.range?.startLine).to.equal(doc.lineCount - 1);
  });
});
