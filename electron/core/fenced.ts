/** Bodies of fenced markdown blocks for a known language tag. Malformed fences are skipped. */
export function extractFencedBlocks(language: string, text: string): string[] {
  if (typeof text !== 'string' || typeof language !== 'string' || !/^[a-z0-9-]+$/.test(language)) return [];
  const pattern = new RegExp('```' + language + '\\s*\\r?\\n([\\s\\S]*?)```', 'g');
  return [...text.matchAll(pattern)].map((m) => m[1]);
}
