export type LocalRoundResult = {
  number: number;
  challenger: number;
  responder: number;
  phrase: string;
  guess: string;
  score: number;
};

export function normalizePhrase(value: string): string {
  return value
    .toLocaleLowerCase('ru-RU')
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function phraseScore(phrase: string, guess: string): number {
  const expected = normalizePhrase(phrase);
  const actual = normalizePhrase(guess);
  if (!expected || !actual) return 0;

  function matchingCharacters(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
    let bestA = aStart;
    let bestB = bStart;
    let bestLength = 0;
    const lengths = new Map<number, number>();

    for (let a = aStart; a < aEnd; a += 1) {
      const next = new Map<number, number>();
      for (let b = bStart; b < bEnd; b += 1) {
        if (expected[a] !== actual[b]) continue;
        const length = (lengths.get(b - 1) || 0) + 1;
        next.set(b, length);
        if (length > bestLength) {
          bestA = a - length + 1;
          bestB = b - length + 1;
          bestLength = length;
        }
      }
      lengths.clear();
      next.forEach((value, key) => lengths.set(key, value));
    }

    if (!bestLength) return 0;
    return bestLength
      + matchingCharacters(aStart, bestA, bStart, bestB)
      + matchingCharacters(bestA + bestLength, aEnd, bestB + bestLength, bEnd);
  }

  const matches = matchingCharacters(0, expected.length, 0, actual.length);
  return Math.round(100 * ((2 * matches) / (expected.length + actual.length)));
}
