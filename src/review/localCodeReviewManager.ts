import * as vscode from 'vscode';
import * as path from 'path';

import { SystemClock, type Clock } from './clock';
import { UuidIdGenerator, type IdGenerator } from './idGenerator';
import type { PersistedAnchorContext, PersistedRange, PersistedThread, PersistedThreadStatus } from './persistedTypes';
import { tryGetGitApi, type GitAPI, type GitRepository } from './git';
import { findSuggestionBlocks } from './suggestions';
import { parseUnifiedDiffChangedLineRanges, parseUnifiedDiffHunks, type DiffHunk, type DiffLineRange } from './unifiedDiff';
import { fromPersistedRange, isSameUri, toPersistedRange } from './uriUtil';
import { WorkspaceReviewStore } from './workspaceReviewStore';
import { ReviewCommentsTreeDataProvider, type ChangedFileInfo } from './reviewTreeView';

const CONTROLLER_ID = 'localCodeReview';
const CONTROLLER_LABEL = 'Local Review';
const THREAD_CONTEXT_UNRESOLVED = 'localCodeReviewUnresolved';
const THREAD_CONTEXT_RESOLVED = 'localCodeReviewResolved';

type ThreadInfo = {
  store: WorkspaceReviewStore;
  persisted: PersistedThread;
  thread: vscode.CommentThread;
};

export type LocalCodeReviewApi = {
  listThreads(): PersistedThread[];
  getThread(threadId: string): PersistedThread | undefined;
  listChangedFiles(): Array<{
    workspaceFolder: string;
    file: string;
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
  }>;
  __dumpViewForTesting(): string;
  __getCommentingRangesForTesting(uri: vscode.Uri): Promise<vscode.CommentingRanges>;
  __setTestingHooks(hooks: { clock?: Clock; idGenerator?: IdGenerator }): void;
};

export class LocalCodeReviewManager implements vscode.Disposable {
  private readonly commentController: vscode.CommentController;
  private readonly stores: WorkspaceReviewStore[] = [];
  private readonly threadById = new Map<string, ThreadInfo>();
  private readonly threadIdByThread = new WeakMap<vscode.CommentThread, string>();

  private gitApi: GitAPI | undefined;
  private readonly repoByWorkspaceFolder = new Map<string, GitRepository | null>();
  private readonly repoStateSubscriptionByWorkspaceFolder = new Map<string, vscode.Disposable>();

  private readonly treeDataProvider: ReviewCommentsTreeDataProvider;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly reloadDebouncers = new Map<string, NodeJS.Timeout>();
  private isClearingAllComments = false;

  private static readonly COMMENTING_RANGES_CACHE_TTL_MS = 750;
  private readonly commentingRangesCache = new Map<
    string,
    { computedAt: number; version: number; ranges: vscode.CommentingRanges }
  >();
  private readonly commentingRangesInFlight = new Map<string, Promise<vscode.CommentingRanges>>();
  private commentingRangesGeneration = 0;

  private clock: Clock = new SystemClock();
  private idGenerator: IdGenerator = new UuidIdGenerator();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.commentController = vscode.comments.createCommentController(CONTROLLER_ID, CONTROLLER_LABEL);
    this.commentController.options = {
      placeHolder: 'Leave a review comment…',
      prompt: 'Add review comment',
    };
    this.commentController.commentingRangeProvider = {
      provideCommentingRanges: async (document) => this.provideCommentingRanges(document),
    };

    this.treeDataProvider = new ReviewCommentsTreeDataProvider(
      () => this.getAllThreadInfos(),
      () => this.getChangedFilesForView(),
    );
    this.disposables.push(
      vscode.window.registerTreeDataProvider('localCodeReview.commentsView', this.treeDataProvider),
      vscode.window.registerTreeDataProvider('localCodeReview.commentsPanel', this.treeDataProvider),
    );

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const store = this.getStoreForUri(doc.uri);
        if (!store) {
          return;
        }
        const repo = this.getRepoForStore(store);
        if (!repo) {
          return;
        }
        this.triggerRepoStatusRefresh(repo);
      }),
    );
  }

  dispose(): void {
    for (const handle of this.reloadDebouncers.values()) {
      clearTimeout(handle);
    }
    this.reloadDebouncers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.commentController.dispose();
    for (const store of this.stores) {
      store.dispose();
    }
  }

  async activate(): Promise<LocalCodeReviewApi> {
    this.disposables.push(
      vscode.commands.registerCommand('localCodeReview.addComment', this.addComment, this),
      vscode.commands.registerCommand('localCodeReview.clearAllComments', this.clearAllComments, this),
      vscode.commands.registerCommand('localCodeReview.refresh', () => this.treeDataProvider.refresh()),
      vscode.commands.registerCommand('localCodeReview.submitComment', this.submitComment, this),
      vscode.commands.registerCommand('localCodeReview.cancelComment', this.cancelComment, this),
      vscode.commands.registerCommand('localCodeReview.resolveThread', (arg) => this.setThreadState(arg, 'resolved')),
      vscode.commands.registerCommand('localCodeReview.reopenThread', (arg) => this.setThreadState(arg, 'open')),
      vscode.commands.registerCommand('localCodeReview.deleteThread', this.deleteThread, this),
      vscode.commands.registerCommand('localCodeReview.revealThread', this.revealThread, this),
      vscode.commands.registerCommand('localCodeReview.applySuggestion', this.applySuggestion, this),
    );

    this.gitApi = await tryGetGitApi();
    await this.initializeFromDisk();

    return {
      listThreads: () => [...this.threadById.values()].map((t) => t.persisted),
      getThread: (threadId: string) => this.threadById.get(threadId)?.persisted,
      listChangedFiles: () =>
        this.getChangedFilesForView().map((c) => ({
          workspaceFolder: c.store.workspaceFolder.name,
          file: c.file,
          staged: c.staged,
          unstaged: c.unstaged,
          untracked: c.untracked,
        })),
      __dumpViewForTesting: () => this.dumpViewForTesting(),
      __getCommentingRangesForTesting: async (uri: vscode.Uri) => {
        const doc = await vscode.workspace.openTextDocument(uri);
        return this.provideCommentingRanges(doc);
      },
      __setTestingHooks: (hooks) => {
        if (hooks.clock) {
          this.clock = hooks.clock;
        }
        if (hooks.idGenerator) {
          this.idGenerator = hooks.idGenerator;
        }
      },
    };
  }

  private getAllThreadInfos(): ThreadInfo[] {
    return [...this.threadById.values()];
  }

  private dumpViewForTesting(): string {
    const threads = this.getAllThreadInfos();
    const changedFiles = this.getChangedFilesForView();

    const files = new Map<
      string,
      {
        workspaceFolder: string;
        file: string;
        isChanged: boolean;
        threads: Array<{ id: string; label: string }>;
      }
    >();

    const ensureFile = (store: WorkspaceReviewStore, file: string, isChanged: boolean) => {
      const key = `${store.workspaceFolder.uri.toString()}::${file}`;
      const existing = files.get(key);
      if (existing) {
        existing.isChanged = existing.isChanged || isChanged;
        return existing;
      }

      const created = {
        workspaceFolder: store.workspaceFolder.name,
        file,
        isChanged,
        threads: [] as Array<{ id: string; label: string }>,
      };
      files.set(key, created);
      return created;
    };

    for (const changed of changedFiles) {
      ensureFile(changed.store, changed.file, true);
    }

    for (const info of threads) {
      const file = info.persisted.target.workspaceRelativePath;
      const fileEntry = ensureFile(info.store, file, false);
      const range = info.persisted.target.range;
      const lineLabel = range ? `L${range.startLine + 1}` : 'File';
      const status = info.persisted.status;
      const commentCount = info.persisted.comments.length;
      fileEntry.threads.push({
        id: info.persisted.id,
        label: `${lineLabel} · ${status} · ${commentCount} comment${commentCount === 1 ? '' : 's'}`,
      });
    }

    const output = [...files.values()]
      .sort((a, b) => {
        if (a.isChanged !== b.isChanged) {
          return a.isChanged ? -1 : 1;
        }
        return a.file.localeCompare(b.file);
      })
      .map((f) => ({
        ...f,
        threads: f.threads.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
      }));

    return `${JSON.stringify({ files: output }, null, 2)}\n`;
  }

  private async initializeFromDisk(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of workspaceFolders) {
      const store = new WorkspaceReviewStore(folder);
      await store.ensureInitialized();
      this.stores.push(store);

      this.registerFileWatchers(store);
      this.registerGitWatchers(store);

      const threadIds = await store.listThreadIds();
      for (const threadId of threadIds) {
        const persisted = await store.readThread(threadId);
        if (!persisted) {
          continue;
        }
        const anchored = await this.reanchorThreadIfNeeded(store, persisted);
        this.upsertThreadFromPersisted(store, anchored);
      }
    }

    this.treeDataProvider.refresh();
  }

  private registerGitWatchers(store: WorkspaceReviewStore): void {
    if (!this.gitApi) {
      this.repoByWorkspaceFolder.set(store.workspaceFolder.uri.toString(), null);
      return;
    }

    void this.refreshRepoForStore(store);
  }

  private getChangedFilesForView(): ChangedFileInfo[] {
    if (!this.gitApi) {
      return [];
    }

    const files: ChangedFileInfo[] = [];
    for (const store of this.stores) {
      const repo = this.getRepoForStore(store);
      if (!repo) {
        continue;
      }

      const merged = new Map<
        string,
        { file: string; staged: boolean; unstaged: boolean; untracked: boolean }
      >();

      const ingest = (uri: vscode.Uri, kind: 'staged' | 'unstaged' | 'untracked') => {
        const file = this.toWorkspaceRelativePath(store, uri);
        if (!file || file.startsWith('..')) {
          return;
        }
        const existing = merged.get(file) ?? { file, staged: false, unstaged: false, untracked: false };
        existing[kind] = true;
        merged.set(file, existing);
      };

      for (const change of repo.state.indexChanges) {
        ingest(change.uri, 'staged');
      }
      for (const change of repo.state.workingTreeChanges) {
        ingest(change.uri, 'unstaged');
      }
      for (const change of repo.state.untrackedChanges) {
        ingest(change.uri, 'untracked');
      }

      for (const info of merged.values()) {
        files.push({ store, file: info.file, staged: info.staged, unstaged: info.unstaged, untracked: info.untracked });
      }
    }

    return files.sort((a, b) => a.file.localeCompare(b.file));
  }

  private getRepoForStore(store: WorkspaceReviewStore): GitRepository | undefined {
    if (!this.gitApi) {
      return undefined;
    }

    return this.refreshRepoForStore(store);
  }

  private refreshRepoForStore(store: WorkspaceReviewStore): GitRepository | undefined {
    if (!this.gitApi) {
      return undefined;
    }

    const key = store.workspaceFolder.uri.toString();
    const repo = this.gitApi.getRepository(store.workspaceFolder.uri);
    this.repoByWorkspaceFolder.set(key, repo);

    const existingSubscription = this.repoStateSubscriptionByWorkspaceFolder.get(key);
    if (repo && !existingSubscription) {
      const disposable = repo.state.onDidChange(() => {
        this.clearCommentingRangesCache();
        this.treeDataProvider.refresh();
      });
      this.repoStateSubscriptionByWorkspaceFolder.set(key, disposable);
      this.disposables.push(disposable);
      this.triggerRepoStatusRefresh(repo);
    } else if (!repo && existingSubscription) {
      existingSubscription.dispose();
      this.repoStateSubscriptionByWorkspaceFolder.delete(key);
    }

    return repo ?? undefined;
  }

  private triggerRepoStatusRefresh(repo: GitRepository): void {
    // `vscode.git` repositories expose a `status()` method, but we keep the type lightweight.
    const status = (repo as unknown as { status?: () => Thenable<unknown> }).status;
    if (typeof status !== 'function') {
      return;
    }

    try {
      void status.call(repo);
    } catch {
      // ignore
    }
  }

  private async refreshRepoStatus(repo: GitRepository): Promise<void> {
    const status = (repo as unknown as { status?: () => Thenable<unknown> }).status;
    if (typeof status !== 'function') {
      return;
    }

    try {
      await Promise.race([
        status.call(repo),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('status timeout')), 5_000)),
      ]);
    } catch {
      // ignore
    }
  }

  private toRepoRelativePath(repo: GitRepository, uri: vscode.Uri): string | undefined {
    const rel = path.relative(repo.rootUri.fsPath, uri.fsPath);
    if (!rel || rel.startsWith('..')) {
      return undefined;
    }

    return rel.split(path.sep).join('/');
  }

  private clearCommentingRangesCache(): void {
    this.commentingRangesGeneration += 1;
    this.commentingRangesCache.clear();
    this.commentingRangesInFlight.clear();
  }

  private async getUnifiedDiffForUri(store: WorkspaceReviewStore, uri: vscode.Uri): Promise<string | undefined> {
    const repo = this.getRepoForStore(store);
    if (!repo) {
      return undefined;
    }

    const repoRelPath = this.toRepoRelativePath(repo, uri);
    if (!repoRelPath) {
      return undefined;
    }

    try {
      const diff = await new Promise<string>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => reject(new Error('diffWithHEAD timeout')), 8_000);
        repo.diffWithHEAD(repoRelPath).then(
          (value) => {
            clearTimeout(timeoutHandle);
            resolve(value);
          },
          (err) => {
            clearTimeout(timeoutHandle);
            reject(err);
          },
        );
      });
      return diff;
    } catch {
      return undefined;
    }
  }

  private async getDiffHunksForUri(store: WorkspaceReviewStore, uri: vscode.Uri): Promise<DiffHunk[]> {
    const diff = await this.getUnifiedDiffForUri(store, uri);
    if (!diff) {
      return [];
    }
    return parseUnifiedDiffHunks(diff);
  }

  private async getDiffChangedLineRangesForUri(store: WorkspaceReviewStore, uri: vscode.Uri): Promise<DiffLineRange[]> {
    const diff = await this.getUnifiedDiffForUri(store, uri);
    if (!diff) {
      return [];
    }
    return parseUnifiedDiffChangedLineRanges(diff);
  }

  private findHunkContainingLine(hunks: DiffHunk[], line0: number): DiffHunk | undefined {
    const line1 = line0 + 1;
    return hunks.find((h) => line1 >= h.newStart && line1 < h.newStart + h.newLines);
  }

  private getOnlyCommentOnChanges(uri: vscode.Uri): boolean {
    return vscode.workspace.getConfiguration('localCodeReview', uri).get<boolean>('onlyCommentOnChanges', false);
  }

  private getFullDocumentRange(document: vscode.TextDocument): vscode.Range {
    if (document.lineCount === 0) {
      return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    }

    const lastLine = document.lineCount - 1;
    return new vscode.Range(
      new vscode.Position(0, 0),
      new vscode.Position(lastLine, document.lineAt(lastLine).text.length),
    );
  }

  private isUriChangedInRepo(repo: GitRepository, uri: vscode.Uri): { changed: boolean; untracked: boolean } {
    const samePath = (a: vscode.Uri) => a.fsPath === uri.fsPath;
    const untracked = repo.state.untrackedChanges.some((c) => samePath(c.uri));
    const changed =
      untracked ||
      repo.state.workingTreeChanges.some((c) => samePath(c.uri)) ||
      repo.state.indexChanges.some((c) => samePath(c.uri));
    return { changed, untracked };
  }

  private async provideCommentingRanges(document: vscode.TextDocument): Promise<vscode.CommentingRanges> {
    const store = this.getStoreForUri(document.uri);
    if (!store) {
      return { enableFileComments: false, ranges: [] };
    }

    if (!this.getOnlyCommentOnChanges(document.uri)) {
      return { enableFileComments: true, ranges: [this.getFullDocumentRange(document)] };
    }

    const generation = this.commentingRangesGeneration;
    const cacheKey = document.uri.toString();
    const cached = this.commentingRangesCache.get(cacheKey);
    if (
      cached &&
      cached.version === document.version &&
      Date.now() - cached.computedAt < LocalCodeReviewManager.COMMENTING_RANGES_CACHE_TTL_MS
    ) {
      return cached.ranges;
    }

    const inflightKey = `${generation}::${cacheKey}::${document.version}`;
    const inflight = this.commentingRangesInFlight.get(inflightKey);
    if (inflight) {
      return inflight;
    }

    const compute = (async (): Promise<vscode.CommentingRanges> => {
      const repo = this.getRepoForStore(store);
      if (!repo) {
        return { enableFileComments: true, ranges: [this.getFullDocumentRange(document)] };
      }

      await this.refreshRepoStatus(repo);

      const { changed, untracked } = this.isUriChangedInRepo(repo, document.uri);
      if (!changed) {
        return { enableFileComments: true, ranges: [] };
      }

      if (untracked) {
        return { enableFileComments: true, ranges: [this.getFullDocumentRange(document)] };
      }

      const changedRanges = await this.getDiffChangedLineRangesForUri(store, document.uri);
      const changedLineRanges = changedRanges
        .map((r) => {
          const startLine = Math.max(0, r.start - 1);
          const endLine = Math.min(document.lineCount - 1, r.end - 1);
          return new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, document.lineAt(endLine).text.length),
          );
        })
        .filter((r) => !r.isEmpty);

      if (changedLineRanges.length) {
        return { enableFileComments: true, ranges: changedLineRanges };
      }

      // Fallback to hunk ranges if we couldn't extract per-line changes (e.g., delete-only hunks).
      const hunks = await this.getDiffHunksForUri(store, document.uri);
      const hunkRanges = hunks
        .filter((h) => h.newLines > 0)
        .map((h) => {
          const startLine = Math.max(0, h.newStart - 1);
          const endLine = Math.min(document.lineCount - 1, startLine + h.newLines - 1);
          return new vscode.Range(
            new vscode.Position(startLine, 0),
            new vscode.Position(endLine, document.lineAt(endLine).text.length),
          );
        });

      return { enableFileComments: true, ranges: hunkRanges.length ? hunkRanges : [this.getFullDocumentRange(document)] };
    })();

    this.commentingRangesInFlight.set(inflightKey, compute);
    try {
      const ranges = await compute;
      if (generation === this.commentingRangesGeneration) {
        this.commentingRangesCache.set(cacheKey, { computedAt: Date.now(), version: document.version, ranges });
      }
      return ranges;
    } finally {
      this.commentingRangesInFlight.delete(inflightKey);
    }
  }

  private registerFileWatchers(store: WorkspaceReviewStore): void {
    const patterns = [
      new vscode.RelativePattern(store.workspaceFolder, `${store.getRootRelativePath()}/**/*.json`),
      new vscode.RelativePattern(store.workspaceFolder, `${store.getRootRelativePath()}/**/*.md`),
    ];

    const schedule = () => this.scheduleReloadStore(store);
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(schedule, this, this.disposables);
      watcher.onDidChange(schedule, this, this.disposables);
      watcher.onDidDelete(schedule, this, this.disposables);
      this.disposables.push(watcher);
    }
  }

  private scheduleReloadStore(store: WorkspaceReviewStore): void {
    if (this.isClearingAllComments) {
      return;
    }

    const key = store.workspaceFolder.uri.toString();
    const existing = this.reloadDebouncers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const handle = setTimeout(() => {
      this.reloadDebouncers.delete(key);
      void this.reloadStoreFromDisk(store);
    }, 150);
    this.reloadDebouncers.set(key, handle);
  }

  private async reloadStoreFromDisk(store: WorkspaceReviewStore): Promise<void> {
    await store.ensureInitialized();

    const threadIds = new Set(await store.listThreadIds());
    const existingThreadIds = [...this.threadById.entries()]
      .filter(([, info]) => info.store === store)
      .map(([id]) => id);

    for (const threadId of existingThreadIds) {
      if (threadIds.has(threadId)) {
        continue;
      }
      const info = this.threadById.get(threadId);
      if (!info) {
        continue;
      }
      info.thread.dispose();
      this.threadById.delete(threadId);
    }

    for (const threadId of threadIds) {
      try {
        const persisted = await store.readThread(threadId);
        if (!persisted) {
          continue;
        }
        const anchored = await this.reanchorThreadIfNeeded(store, persisted);
        this.upsertThreadFromPersisted(store, anchored);
      } catch {
        // Ignore invalid JSON edits; keep last-known-good in memory.
      }
    }

    this.treeDataProvider.refresh();
  }

  private getStoreForUri(uri: vscode.Uri): WorkspaceReviewStore | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return undefined;
    }
    return this.stores.find((s) => isSameUri(s.workspaceFolder.uri, folder.uri));
  }

  private upsertThreadFromPersisted(store: WorkspaceReviewStore, persisted: PersistedThread): void {
    const existing = this.threadById.get(persisted.id);
    if (existing) {
      const oldPath = existing.persisted.target.workspaceRelativePath;
      const newPath = persisted.target.workspaceRelativePath;
      if (oldPath !== newPath) {
        existing.thread.dispose();
        this.threadById.delete(persisted.id);
        this.upsertThreadFromPersisted(store, persisted);
        return;
      }

      existing.persisted = persisted;
      existing.thread.range = fromPersistedRange(persisted.target.range);
      existing.thread.comments = persisted.comments.map((c) => this.toVscodeComment(c));
      existing.thread.state = this.toVscodeThreadState(persisted.status);
      existing.thread.contextValue = this.getThreadContextValue(persisted.status);
      existing.thread.canReply = true;
      existing.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      return;
    }

    const uri = this.resolveWorkspaceRelativePath(store, persisted.target.workspaceRelativePath);
    if (!uri) {
      return;
    }
    const range = fromPersistedRange(persisted.target.range);
    const comments = persisted.comments.map((c) => this.toVscodeComment(c));
    const safeRange = range ?? new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    const thread = this.commentController.createCommentThread(uri, safeRange, comments);
    thread.contextValue = this.getThreadContextValue(persisted.status);
    thread.canReply = true;
    thread.range = range;
    thread.state = this.toVscodeThreadState(persisted.status);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;

    const info: ThreadInfo = { store, persisted, thread };
    this.threadById.set(persisted.id, info);
    this.threadIdByThread.set(thread, persisted.id);
  }

  private toVscodeThreadState(status: PersistedThreadStatus): vscode.CommentThreadState {
    return status === 'resolved' ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
  }

  private toPersistedThreadStatus(state: vscode.CommentThreadState | undefined): PersistedThreadStatus {
    return state === vscode.CommentThreadState.Resolved ? 'resolved' : 'open';
  }

  private getThreadContextValue(status: PersistedThreadStatus): string {
    return status === 'resolved' ? THREAD_CONTEXT_RESOLVED : THREAD_CONTEXT_UNRESOLVED;
  }

  private normalizeWorkspaceRelativePath(workspaceRelativePath: string): string | undefined {
    const raw = String(workspaceRelativePath ?? '').trim();
    if (!raw) {
      return undefined;
    }

    if (raw.includes('\0')) {
      return undefined;
    }

    const normalizedSlashes = raw.replace(/\\/g, '/');
    if (normalizedSlashes.startsWith('/') || normalizedSlashes.startsWith('//')) {
      return undefined;
    }
    if (/^[A-Za-z]:\//.test(normalizedSlashes)) {
      return undefined;
    }

    const normalized = path.posix.normalize(normalizedSlashes).replace(/^\.\/+/, '');
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      return undefined;
    }

    return normalized;
  }

  private resolveWorkspaceRelativePath(store: WorkspaceReviewStore, workspaceRelativePath: string): vscode.Uri | undefined {
    const normalized = this.normalizeWorkspaceRelativePath(workspaceRelativePath);
    if (!normalized) {
      return undefined;
    }

    const parts = normalized.split('/').filter(Boolean);
    return vscode.Uri.joinPath(store.workspaceFolder.uri, ...parts);
  }

  private toWorkspaceRelativePath(store: WorkspaceReviewStore, uri: vscode.Uri): string {
    const rel = path.relative(store.workspaceFolder.uri.fsPath, uri.fsPath);
    return rel.split(path.sep).join('/');
  }

  private toVscodeComment(comment: PersistedThread['comments'][number]): vscode.Comment {
    return {
      author: { name: comment.author },
      body: new vscode.MarkdownString(comment.bodyMarkdown),
      mode: vscode.CommentMode.Preview,
      timestamp: new Date(comment.createdAt),
    };
  }

  private extractThread(arg: unknown): vscode.CommentThread | undefined {
    if (!arg) {
      return undefined;
    }

    if (typeof arg === 'string') {
      const info = this.threadById.get(arg);
      return info?.thread;
    }

    if (typeof arg === 'object' && arg !== null && 'threadId' in arg) {
      const threadId = String((arg as { threadId: unknown }).threadId);
      const info = this.threadById.get(threadId);
      return info?.thread;
    }

    if (typeof arg === 'object' && arg !== null && 'thread' in arg) {
      return (arg as { thread?: vscode.CommentThread }).thread;
    }

    if (typeof arg === 'object' && arg !== null && 'uri' in arg && 'comments' in arg) {
      return arg as vscode.CommentThread;
    }

    return undefined;
  }

  private async addComment(uri?: vscode.Uri, lineNumber?: number): Promise<string | undefined> {
    const editor = vscode.window.activeTextEditor;
    const targetUri = uri ?? editor?.document.uri;
    if (!targetUri) {
      return undefined;
    }

    const store = this.getStoreForUri(targetUri);
    if (!store) {
      void vscode.window.showErrorMessage('Local Code Review: file is not inside an open workspace folder.');
      return undefined;
    }

    const document =
      editor && isSameUri(editor.document.uri, targetUri)
        ? editor.document
        : await vscode.workspace.openTextDocument(targetUri);

    const rawRange = this.getTargetRange(editor, document, targetUri, lineNumber);
    const range = this.normalizeRangeForComment(document, rawRange);

    if (range && this.getOnlyCommentOnChanges(targetUri)) {
      const commenting = await this.provideCommentingRanges(document);
      const allowed = commenting.ranges?.some((r) => !!r.intersection(range));
      if (!allowed) {
        void vscode.window.showErrorMessage(
          'Local Code Review: cursor/selection must be within a changed hunk to add a comment (disable localCodeReview.onlyCommentOnChanges to allow anywhere).',
        );
        return undefined;
      }
    }

    const now = this.clock.now().toISOString();
    const threadId = this.idGenerator.newThreadId();
    const workspaceRelativePath = this.toWorkspaceRelativePath(store, targetUri);
    const anchorContext = range ? this.buildAnchorContext(document, range) : undefined;

    const persisted: PersistedThread = {
      schemaVersion: 1,
      id: threadId,
      target: {
        workspaceRelativePath,
        range: toPersistedRange(range),
        anchor: { kind: 'lineRange', context: anchorContext },
      },
      status: 'open',
      comments: [],
      createdAt: now,
      updatedAt: now,
    };

    const repo = this.getRepoForStore(store);
    if (repo && range && this.getOnlyCommentOnChanges(targetUri)) {
      let hunk: DiffHunk | undefined;
      const { changed, untracked } = this.isUriChangedInRepo(repo, targetUri);
      if (changed) {
        const baseRef = repo.state.HEAD?.name ?? repo.state.HEAD?.commit;
        if (!untracked) {
          const hunks = await this.getDiffHunksForUri(store, targetUri);
          hunk = this.findHunkContainingLine(hunks, range.start.line);
        }
        if (baseRef || hunk) {
          persisted.target.anchor.git = {
            baseRef,
            hunkHeader: hunk?.header,
            hunkPatch: hunk?.patch,
          };
        }
      }
    }

    await store.writeThread(persisted);
    this.upsertThreadFromPersisted(store, persisted);

    if (editor && isSameUri(editor.document.uri, targetUri)) {
      editor.revealRange(range ?? editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    this.treeDataProvider.refresh();

    return threadId;
  }

  private getTargetRange(
    editor: vscode.TextEditor | undefined,
    document: vscode.TextDocument,
    uri: vscode.Uri,
    lineNumber: number | undefined,
  ): vscode.Range | undefined {
    if (editor && isSameUri(editor.document.uri, uri) && !editor.selection.isEmpty) {
      return new vscode.Range(editor.selection.start, editor.selection.end);
    }

    if (typeof lineNumber === 'number') {
      const rawLine = Number.isFinite(lineNumber) ? Math.trunc(lineNumber) : undefined;
      if (rawLine !== undefined) {
        const maxLine = Math.max(0, document.lineCount - 1);
        const safeLine = Math.min(maxLine, Math.max(0, rawLine));
        const pos = new vscode.Position(safeLine, 0);
        return new vscode.Range(pos, pos);
      }
    }

    if (editor && isSameUri(editor.document.uri, uri)) {
      const pos = editor.selection.active;
      return new vscode.Range(pos, pos);
    }

    return undefined;
  }

  private normalizeRangeForComment(document: vscode.TextDocument, range: vscode.Range | undefined): vscode.Range | undefined {
    if (!range) {
      return undefined;
    }

    if (range.isEmpty) {
      const line = document.lineAt(range.start.line);
      return new vscode.Range(new vscode.Position(line.lineNumber, 0), new vscode.Position(line.lineNumber, line.text.length));
    }

    return range;
  }

  private buildAnchorContext(document: vscode.TextDocument, range: vscode.Range): PersistedAnchorContext {
    const beforeLineCount = 2;
    const afterLineCount = 2;

    const selectionText = document.getText(range);
    const startLine = range.start.line;
    const endLine = range.end.line;

    const beforeStart = Math.max(0, startLine - beforeLineCount);
    const before: string[] = [];
    for (let i = beforeStart; i < startLine; i += 1) {
      before.push(document.lineAt(i).text);
    }

    const afterEnd = Math.min(document.lineCount - 1, endLine + afterLineCount);
    const after: string[] = [];
    for (let i = endLine + 1; i <= afterEnd; i += 1) {
      after.push(document.lineAt(i).text);
    }

    return { before, selection: selectionText, after };
  }

  private async reanchorThreadIfNeeded(store: WorkspaceReviewStore, persisted: PersistedThread): Promise<PersistedThread> {
    const context = persisted.target.anchor.context;
    if (!context || !context.selection.trim() || !persisted.target.range) {
      return persisted;
    }

    const uri = this.resolveWorkspaceRelativePath(store, persisted.target.workspaceRelativePath);
    if (!uri) {
      return persisted;
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return persisted;
    }

    const fileText = new TextDecoder('utf-8').decode(bytes).replace(/\r\n/g, '\n');
    const anchoredRange = this.findAnchoredRangeInText(fileText, context, persisted.target.range, persisted.target.anchor.git?.hunkHeader);
    if (!anchoredRange) {
      return persisted;
    }

    const newPersistedRange = toPersistedRange(anchoredRange);
    if (!newPersistedRange || this.arePersistedRangesEqual(newPersistedRange, persisted.target.range)) {
      return persisted;
    }

    persisted.target.range = newPersistedRange;
    persisted.updatedAt = this.clock.now().toISOString();
    await store.writeThread(persisted);
    return persisted;
  }

  private arePersistedRangesEqual(a: PersistedRange, b: PersistedRange): boolean {
    return (
      a.startLine === b.startLine &&
      a.startCharacter === b.startCharacter &&
      a.endLine === b.endLine &&
      a.endCharacter === b.endCharacter
    );
  }

  private findAnchoredRangeInText(
    fileText: string,
    context: PersistedAnchorContext,
    fallbackRange: PersistedRange,
    hunkHeader: string | undefined,
  ): vscode.Range | undefined {
    const selection = context.selection.replace(/\r\n/g, '\n');
    if (!selection.trim()) {
      return undefined;
    }

    const occurrences: number[] = [];
    for (let idx = fileText.indexOf(selection); idx !== -1 && occurrences.length < 50; idx = fileText.indexOf(selection, idx + 1)) {
      occurrences.push(idx);
    }
    if (occurrences.length === 0) {
      return undefined;
    }

    const approximateLine = this.getApproximateLine(fallbackRange, hunkHeader);
    const lines = fileText.split('\n');
    const lineStarts = this.buildLineStarts(fileText);
    const selectionLineCount = selection.split('\n').length;

    let bestOffset = occurrences[0];
    let bestScore = Number.NEGATIVE_INFINITY;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const offset of occurrences) {
      const startPos = this.offsetToPosition(lineStarts, offset);
      const selectionStartLine = startPos.line;
      const selectionEndLine = selectionStartLine + selectionLineCount - 1;

      let contextMatches = 0;

      // Compare preceding lines (from nearest backwards).
      for (let i = 0; i < context.before.length; i += 1) {
        const expected = context.before[context.before.length - 1 - i];
        const actualIndex = selectionStartLine - 1 - i;
        if (actualIndex < 0) {
          break;
        }
        if (lines[actualIndex] === expected) {
          contextMatches += 1;
        } else {
          break;
        }
      }

      // Compare following lines.
      for (let i = 0; i < context.after.length; i += 1) {
        const actualIndex = selectionEndLine + 1 + i;
        if (actualIndex >= lines.length) {
          break;
        }
        if (lines[actualIndex] === context.after[i]) {
          contextMatches += 1;
        } else {
          break;
        }
      }

      const distance = approximateLine !== undefined ? Math.abs(selectionStartLine - approximateLine) : 0;
      const score = contextMatches * 10 - distance;

      if (score > bestScore || (score === bestScore && distance < bestDistance)) {
        bestScore = score;
        bestDistance = distance;
        bestOffset = offset;
      }
    }

    const start = this.offsetToPosition(lineStarts, bestOffset);
    const end = this.offsetToPosition(lineStarts, bestOffset + selection.length);
    return new vscode.Range(new vscode.Position(start.line, start.character), new vscode.Position(end.line, end.character));
  }

  private getApproximateLine(fallbackRange: PersistedRange, hunkHeader: string | undefined): number | undefined {
    const parsed = hunkHeader ? /@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(hunkHeader) : null;
    if (parsed) {
      const newStart = Number(parsed[1]);
      if (Number.isFinite(newStart)) {
        return Math.max(0, newStart - 1);
      }
    }

    const startLine = Number(fallbackRange.startLine);
    return Number.isFinite(startLine) ? startLine : undefined;
  }

  private buildLineStarts(text: string): number[] {
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10 /* \\n */) {
        starts.push(i + 1);
      }
    }
    return starts;
  }

  private offsetToPosition(lineStarts: number[], offset: number): { line: number; character: number } {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const start = lineStarts[mid];
      if (start === offset) {
        return { line: mid, character: 0 };
      }
      if (start < offset) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const line = Math.max(0, high);
    return { line, character: Math.max(0, offset - lineStarts[line]) };
  }

  private async submitComment(arg: unknown): Promise<void> {
    const { threadId, text } = this.getThreadIdAndTextFromReply(arg);
    if (!threadId) {
      return;
    }

    const info = this.threadById.get(threadId);
    if (!info) {
      return;
    }

    const normalizedText = text.trimEnd();
    if (!normalizedText.trim()) {
      return;
    }

    const persisted = (await info.store.readThread(threadId)) ?? info.persisted;
    const now = this.clock.now().toISOString();

    persisted.comments = [
      ...persisted.comments,
      {
        id: this.idGenerator.newCommentId(),
        author: 'You',
        bodyMarkdown: normalizedText,
        createdAt: now,
      },
    ];
    persisted.updatedAt = now;
    persisted.status = this.toPersistedThreadStatus(info.thread.state);

    await info.store.writeThread(persisted);
    this.upsertThreadFromPersisted(info.store, persisted);
    this.treeDataProvider.refresh();
  }

  private async cancelComment(arg: unknown): Promise<void> {
    const { threadId } = this.getThreadIdAndTextFromReply(arg);
    if (!threadId) {
      return;
    }

    const info = this.threadById.get(threadId);
    if (!info) {
      return;
    }

    if (info.thread.comments.length > 0) {
      return;
    }

    await info.store.deleteThread(threadId);
    info.thread.dispose();
    this.threadById.delete(threadId);
    this.treeDataProvider.refresh();
  }

  private getThreadIdAndTextFromReply(arg: unknown): { threadId?: string; text: string } {
    if (typeof arg === 'object' && arg !== null) {
      if ('threadId' in arg && 'text' in arg) {
        return { threadId: String((arg as { threadId: unknown }).threadId), text: String((arg as { text: unknown }).text) };
      }

      if ('thread' in arg && 'text' in arg) {
        const thread = (arg as { thread?: vscode.CommentThread }).thread;
        const threadId = thread ? this.threadIdByThread.get(thread) : undefined;
        return { threadId, text: String((arg as { text: unknown }).text) };
      }
    }

    return { threadId: undefined, text: '' };
  }

  private async setThreadState(arg: unknown, status: PersistedThreadStatus): Promise<void> {
    const thread = this.extractThread(arg);
    if (!thread) {
      return;
    }
    const threadId = this.threadIdByThread.get(thread);
    if (!threadId) {
      return;
    }
    const info = this.threadById.get(threadId);
    if (!info) {
      return;
    }

    const persisted = (await info.store.readThread(threadId)) ?? info.persisted;
    persisted.status = status;
    persisted.updatedAt = this.clock.now().toISOString();
    await info.store.writeThread(persisted);

    this.upsertThreadFromPersisted(info.store, persisted);
    this.treeDataProvider.refresh();
  }

  private async deleteThread(arg: unknown): Promise<void> {
    const thread = this.extractThread(arg);
    if (!thread) {
      return;
    }
    const threadId = this.threadIdByThread.get(thread);
    if (!threadId) {
      return;
    }
    const info = this.threadById.get(threadId);
    if (!info) {
      return;
    }

    await info.store.deleteThread(threadId);
    info.thread.dispose();
    this.threadById.delete(threadId);
    this.treeDataProvider.refresh();
  }

  private async clearAllComments(arg?: unknown): Promise<void> {
    const force =
      typeof arg === 'object' && arg !== null && 'force' in arg ? Boolean((arg as { force?: unknown }).force) : false;
    if (!force) {
      const ok = await vscode.window.showWarningMessage(
        'Clear all Local Code Review comments in this workspace?',
        { modal: true },
        'Clear',
      );
      if (ok !== 'Clear') {
        return;
      }
    }

    this.isClearingAllComments = true;
    try {
      for (const handle of this.reloadDebouncers.values()) {
        clearTimeout(handle);
      }
      this.reloadDebouncers.clear();

      for (const info of this.threadById.values()) {
        info.thread.dispose();
      }
      this.threadById.clear();

      await Promise.all(this.stores.map((s) => s.clearAllComments()));
    } finally {
      this.isClearingAllComments = false;
    }

    this.treeDataProvider.refresh();
  }

  private async revealThread(arg: unknown): Promise<void> {
    const threadId =
      typeof arg === 'string'
        ? arg
        : typeof arg === 'object' && arg !== null && 'threadId' in arg
          ? String((arg as { threadId: unknown }).threadId)
          : undefined;

    if (!threadId) {
      return;
    }

    const info = this.threadById.get(threadId);
    if (!info) {
      return;
    }

    const docUri = this.resolveWorkspaceRelativePath(info.store, info.persisted.target.workspaceRelativePath);
    if (!docUri) {
      void vscode.window.showErrorMessage('Local Code Review: unsafe thread path; cannot reveal.');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(docUri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });

    const range = fromPersistedRange(info.persisted.target.range);
    if (range) {
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      editor.selection = new vscode.Selection(range.start, range.end);
    }
  }

  private async applySuggestion(arg: unknown): Promise<void> {
    const thread = this.extractThread(arg);
    const threadId = thread ? this.threadIdByThread.get(thread) : undefined;
    if (!threadId) {
      return;
    }
    const info = this.threadById.get(threadId);
    if (!info) {
      return;
    }

    const persisted = (await info.store.readThread(threadId)) ?? info.persisted;
    const range = fromPersistedRange(persisted.target.range);
    if (!range) {
      void vscode.window.showInformationMessage('No range associated with this thread.');
      return;
    }

    const latest = persisted.comments[persisted.comments.length - 1];
    if (!latest) {
      void vscode.window.showInformationMessage('No comments in this thread.');
      return;
    }

    const suggestions = findSuggestionBlocks(latest.bodyMarkdown);
    if (suggestions.length === 0) {
      void vscode.window.showInformationMessage('No ```suggestion``` block found in the latest comment.');
      return;
    }

    const docUri = this.resolveWorkspaceRelativePath(info.store, persisted.target.workspaceRelativePath);
    if (!docUri) {
      void vscode.window.showErrorMessage('Local Code Review: unsafe thread path; cannot apply suggestion.');
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      docUri,
      range,
      suggestions[0].replacementText,
    );
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      void vscode.window.showErrorMessage('Failed to apply suggestion.');
    }
  }
}
