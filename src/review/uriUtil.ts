import * as vscode from 'vscode';

import type { PersistedRange } from './persistedTypes';

export function toPersistedRange(range: vscode.Range | undefined): PersistedRange | null {
  if (!range) {
    return null;
  }

  return {
    startLine: range.start.line,
    startCharacter: range.start.character,
    endLine: range.end.line,
    endCharacter: range.end.character,
  };
}

export function fromPersistedRange(range: PersistedRange | null): vscode.Range | undefined {
  if (!range) {
    return undefined;
  }

  return new vscode.Range(
    new vscode.Position(range.startLine, range.startCharacter),
    new vscode.Position(range.endLine, range.endCharacter),
  );
}

export function isSameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.toString() === b.toString();
}
