import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectRecorderMimeType } from './browserAudio';

afterEach(() => vi.unstubAllGlobals());

describe('selectRecorderMimeType', () => {
  it('falls back to MP4 on Safari when WebM is unavailable', () => {
    vi.stubGlobal('MediaRecorder', { isTypeSupported: (mime: string) => mime === 'audio/mp4' });
    expect(selectRecorderMimeType()).toBe('audio/mp4');
  });
  it('lets older recorders choose their default format', () => {
    vi.stubGlobal('MediaRecorder', {});
    expect(selectRecorderMimeType()).toBeUndefined();
  });
  it('does not crash in an environment without MediaRecorder', () => {
    expect(() => selectRecorderMimeType()).not.toThrow();
  });
});
