import * as vscode from 'vscode';

import { LocalCodeReviewManager, type LocalCodeReviewApi } from './review/localCodeReviewManager';

export async function activate(context: vscode.ExtensionContext): Promise<LocalCodeReviewApi> {
  const manager = new LocalCodeReviewManager(context);
  context.subscriptions.push(manager);
  return await manager.activate();
}

export function deactivate() {}
