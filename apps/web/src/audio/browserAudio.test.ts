import { describe, expect, it } from 'vitest';
import { selectRecorderMimeType } from './browserAudio';

describe('selectRecorderMimeType', () => {
  it('does not crash in an environment without MediaRecorder', () => {
    expect(() => selectRecorderMimeType()).not.toThrow();
  });
});
