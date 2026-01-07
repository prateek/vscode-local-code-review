import * as vscode from 'vscode';

export type GitChange = {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly renameUri?: vscode.Uri;
  readonly status: number;
};

export type GitRepositoryState = {
  readonly HEAD: { readonly name?: string; readonly commit?: string } | undefined;
  readonly workingTreeChanges: GitChange[];
  readonly indexChanges: GitChange[];
  readonly untrackedChanges: GitChange[];
  readonly onDidChange: vscode.Event<void>;
};

export type GitRepository = {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
  diffWithHEAD(path: string): Promise<string>;
};

export type GitAPI = {
  readonly repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
};

type GitExtensionExports = {
  getAPI(version: 1): GitAPI;
};

export async function tryGetGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) {
    return undefined;
  }

  try {
    const exports = (await ext.activate()) as GitExtensionExports;
    return exports.getAPI(1);
  } catch {
    return undefined;
  }
}
