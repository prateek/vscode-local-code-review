import { expect } from 'chai';
import * as vscode from 'vscode';

suite('local-code-review smoke', () => {
  test('extension activates', async () => {
    const ext = vscode.extensions.getExtension('prateek.local-code-review');
    expect(ext, 'extension should be present').to.not.equal(undefined);
    await ext!.activate();
  });

  test('add comment command is registered', async () => {
    const ext = vscode.extensions.getExtension('prateek.local-code-review')!;
    await ext.activate();

    // Will throw if not registered by the extension.
    await vscode.commands.executeCommand('localCodeReview.addComment');
  });
});
