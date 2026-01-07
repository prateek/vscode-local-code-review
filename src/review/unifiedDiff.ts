export type DiffHunk = {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /**
   * Unified diff snippet for this hunk (includes the @@ header line + hunk lines).
   */
  patch: string;
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parseUnifiedDiffHunks(diffText: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = diffText.split(/\r?\n/);

  let current:
    | (Omit<DiffHunk, 'patch'> & {
        patchLines: string[];
      })
    | undefined;

  const flush = () => {
    if (!current) {
      return;
    }

    hunks.push({
      header: current.header,
      oldStart: current.oldStart,
      oldLines: current.oldLines,
      newStart: current.newStart,
      newLines: current.newLines,
      patch: current.patchLines.join('\n').trimEnd(),
    });
    current = undefined;
  };

  for (const line of lines) {
    const match = HUNK_RE.exec(line);
    if (match) {
      flush();

      const oldStart = Number(match[1]);
      const oldLines = Number(match[2] ?? '1');
      const newStart = Number(match[3]);
      const newLines = Number(match[4] ?? '1');
      const header = line;

      current = {
        header,
        oldStart,
        oldLines,
        newStart,
        newLines,
        patchLines: [line],
      };
      continue;
    }

    if (!current) {
      continue;
    }

    // Some unified diff outputs can contain extra headers between hunks (or between files).
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      flush();
      continue;
    }

    current.patchLines.push(line);
  }

  flush();
  return hunks;
}

export type DiffLineRange = {
  /** 1-based, inclusive */
  start: number;
  /** 1-based, inclusive */
  end: number;
};

/**
 * Returns contiguous 1-based line ranges in the *new* file that contain additions/modified lines.
 * Context lines are not included.
 */
export function parseUnifiedDiffChangedLineRanges(diffText: string): DiffLineRange[] {
  const ranges: DiffLineRange[] = [];
  const lines = diffText.split(/\r?\n/);

  let current: DiffLineRange | null = null;
  let inHunk = false;
  let newLine = 0;

  const flush = () => {
    if (!current) {
      return;
    }
    ranges.push(current);
    current = null;
  };

  for (const line of lines) {
    const match = HUNK_RE.exec(line);
    if (match) {
      flush();
      inHunk = true;
      newLine = Number(match[3]);
      continue;
    }

    if (!inHunk) {
      continue;
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (current && newLine === current.end + 1) {
        current.end = newLine;
      } else {
        flush();
        current = { start: newLine, end: newLine };
      }
      newLine += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      flush();
      continue;
    }

    if (line.startsWith(' ')) {
      flush();
      newLine += 1;
      continue;
    }

    if (line.startsWith('\\')) {
      continue;
    }

    // Any other header line ends a hunk.
    if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      flush();
      inHunk = false;
      newLine = 0;
    }
  }

  flush();
  return ranges;
}
