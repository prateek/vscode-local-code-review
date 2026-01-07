import * as vscode from 'vscode';

import { fromPersistedRange } from './uriUtil';
import type { PersistedThread } from './persistedTypes';
import type { WorkspaceReviewStore } from './workspaceReviewStore';

export type ChangedFileInfo = {
  store: WorkspaceReviewStore;
  file: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
};

type ThreadInfo = {
  store: WorkspaceReviewStore;
  persisted: PersistedThread;
};

type FileNode = {
  kind: 'file';
  store: WorkspaceReviewStore;
  file: string;
  isChanged: boolean;
};

type ThreadNode = {
  kind: 'thread';
  threadId: string;
  store: WorkspaceReviewStore;
  persisted: PersistedThread;
};

type TreeNode = FileNode | ThreadNode;

export class ReviewCommentsTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(
    private readonly getThreads: () => ThreadInfo[],
    private readonly getChangedFiles: () => ChangedFileInfo[],
  ) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(element.file, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = element.isChanged ? new vscode.ThemeIcon('diff') : vscode.ThemeIcon.File;
      return item;
    }

    const range = fromPersistedRange(element.persisted.target.range);
    const lineLabel = range ? `L${range.start.line + 1}` : 'File';
    const status = element.persisted.status;
    const commentCount = element.persisted.comments.length;
    const item = new vscode.TreeItem(`${lineLabel} · ${status} · ${commentCount} comment${commentCount === 1 ? '' : 's'}`);
    item.iconPath = new vscode.ThemeIcon(element.persisted.status === 'resolved' ? 'pass' : 'comment-discussion');
    item.command = {
      command: 'localCodeReview.revealThread',
      title: 'Reveal Thread',
      arguments: [{ threadId: element.threadId }],
    };
    item.contextValue = 'localCodeReview.thread';
    return item;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    const threads = this.getThreads();
    if (!element) {
      const files = new Map<string, FileNode>();
      const changedFiles = this.getChangedFiles();

      for (const changed of changedFiles) {
        const key = `${changed.store.workspaceFolder.uri.toString()}::${changed.file}`;
        if (!files.has(key)) {
          files.set(key, { kind: 'file', store: changed.store, file: changed.file, isChanged: true });
        }
      }

      for (const { store, persisted } of threads) {
        const key = `${store.workspaceFolder.uri.toString()}::${persisted.target.workspaceRelativePath}`;
        if (!files.has(key)) {
          files.set(key, { kind: 'file', store, file: persisted.target.workspaceRelativePath, isChanged: false });
        }
      }

      return [...files.values()].sort((a, b) => {
        if (a.isChanged !== b.isChanged) {
          return a.isChanged ? -1 : 1;
        }
        return a.file.localeCompare(b.file);
      });
    }

    if (element.kind === 'file') {
      return threads
        .filter((t) => t.persisted.target.workspaceRelativePath === element.file && t.store === element.store)
        .map((t) => ({
          kind: 'thread' as const,
          threadId: t.persisted.id,
          store: t.store,
          persisted: t.persisted,
        }))
        .sort((a, b) => {
          const ar = fromPersistedRange(a.persisted.target.range);
          const br = fromPersistedRange(b.persisted.target.range);
          const aline = ar?.start.line ?? 0;
          const bline = br?.start.line ?? 0;
          return aline - bline || a.threadId.localeCompare(b.threadId);
        });
    }

    return [];
  }
}
