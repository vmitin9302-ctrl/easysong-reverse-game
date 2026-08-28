import { describe, expect, it } from 'vitest';
import { normalizePhrase, phraseScore } from './localGame';

describe('local phrase scoring', () => {
  it('normalizes case, punctuation, spaces and ё', () => {
    expect(normalizePhrase('  Ёжик,   ПРИВЕТ! ')).toBe('ежик привет');
  });

  it('gives an exact normalized answer a full score', () => {
    expect(phraseScore('Сегодня — отличный день!', 'сегодня отличный день')).toBe(100);
  });

  it('returns zero for an empty answer and a partial score for a typo', () => {
    expect(phraseScore('секрет', '')).toBe(0);
    expect(phraseScore('привет', 'привед')).toBe(83);
  });

  it('matches the online SequenceMatcher scoring for representative answers', () => {
    expect(phraseScore('сегодня отличный день', 'сегодня день')).toBe(73);
    expect(phraseScore('мама мыла раму', 'мама раму')).toBe(78);
    expect(phraseScore('кот', 'ток')).toBe(33);
  });
});
