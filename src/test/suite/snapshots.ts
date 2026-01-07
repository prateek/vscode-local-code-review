import * as fs from 'fs/promises';
import * as path from 'path';

import { expect } from 'chai';

function getSnapshotsDir(): string {
  // Compiled tests run from `out/test/suite`, so go back to repo root and then `src/test/snapshots`.
  return path.resolve(__dirname, '../../../src/test/snapshots');
}

export async function assertSnapshot(name: string, contents: string): Promise<void> {
  const snapshotsDir = getSnapshotsDir();
  const snapshotPath = path.join(snapshotsDir, `${name}.snap`);

  await fs.mkdir(snapshotsDir, { recursive: true });

  if (process.env.UPDATE_SNAPSHOTS) {
    await fs.writeFile(snapshotPath, contents, 'utf8');
    return;
  }

  const expected = await fs.readFile(snapshotPath, 'utf8');
  expect(contents).to.equal(expected);
}

