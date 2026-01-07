export type SuggestionBlock = {
  fullMatch: string;
  replacementText: string;
};

export function findSuggestionBlocks(markdown: string): SuggestionBlock[] {
  const suggestionFenceRe = /```suggestion\r?\n([\s\S]*?)\r?\n```/g;
  const blocks: SuggestionBlock[] = [];
  for (;;) {
    const match = suggestionFenceRe.exec(markdown);
    if (!match) {
      break;
    }

    blocks.push({
      fullMatch: match[0],
      replacementText: match[1] ?? '',
    });
  }

  return blocks;
}
