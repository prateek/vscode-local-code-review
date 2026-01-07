export const SCHEMA_VERSION = 1;

export type PersistedRange = {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
};

export type PersistedComment = {
  id: string;
  author: string;
  bodyMarkdown: string;
  createdAt: string; // ISO8601
};

export type PersistedThreadStatus = 'open' | 'resolved';

export type PersistedAnchorContext = {
  before: string[];
  selection: string;
  after: string[];
};

export type PersistedAnchor = {
  kind: 'lineRange';
  context?: PersistedAnchorContext;
  /**
   * Optional git/diff metadata to improve re-anchoring across changes.
   * Not required for core functionality.
   */
  git?: {
    baseRef?: string;
    hunkHeader?: string;
    /**
     * Optional snapshot of the relevant unified diff hunk for readability.
     * Stored in Markdown thread files under the "Patch" section.
     */
    hunkPatch?: string;
  };
};

export type PersistedThreadTarget = {
  workspaceRelativePath: string;
  range: PersistedRange | null;
  anchor: PersistedAnchor;
};

export type PersistedThread = {
  schemaVersion: 1;
  id: string;
  target: PersistedThreadTarget;
  status: PersistedThreadStatus;
  comments: PersistedComment[];
  createdAt: string; // ISO8601
  updatedAt: string; // ISO8601
};

export type PersistedIndexEntry = {
  id: string;
  file: string; // workspace-folder-relative path
  range: PersistedRange | null;
  status: PersistedThreadStatus;
  updatedAt: string; // ISO8601
};

export type PersistedIndex = {
  schemaVersion: 1;
  threads: PersistedIndexEntry[];
};
