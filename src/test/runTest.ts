import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { runTests } from '@vscode/test-electron';

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.vscode') {
      continue;
    }
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
      continue;
    }
    if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
}

function execGit(cwd: string, args: string[], env?: Record<string, string>): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function prepareWorkspace(): Promise<{ workspacePath: string; cleanup: () => Promise<void> }> {
  const fixturePath = path.resolve(__dirname, '../../src/test/workspace');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-local-code-review-'));
  const workspacePath = path.join(root, 'workspace');
  await copyDir(fixturePath, workspacePath);

  try {
    execGit(workspacePath, ['init', '-b', 'main']);
  } catch {
    execGit(workspacePath, ['init']);
    execGit(workspacePath, ['checkout', '-b', 'main']);
  }
  execGit(workspacePath, ['config', 'user.email', 'test@example.com']);
  execGit(workspacePath, ['config', 'user.name', 'Test']);
  execGit(workspacePath, ['add', '-A']);
  execGit(workspacePath, ['commit', '-m', 'init'], {
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  });

  return {
    workspacePath,
    cleanup: async () => {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function main() {
  const prepared = await prepareWorkspace();
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        prepared.workspacePath,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to run tests', error);
    process.exit(1);
  } finally {
    await prepared.cleanup();
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
