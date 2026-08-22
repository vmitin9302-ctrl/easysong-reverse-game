import { describe, expect, it } from 'vitest';
import { reverseSamples, scoreSignals } from './index';

function sine(seconds: number, sampleRate: number, frequency: number): Float32Array {
  const length = Math.floor(seconds * sampleRate);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    data[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * 0.35;
  }
  return data;
}

describe('reverseSamples', () => {
  it('reverses a buffer and is involutive', () => {
    const original = new Float32Array([0.1, 0.2, -0.3, 0.4]);
    const reversed = reverseSamples(original);
    expect(Array.from(reversed)).toEqual([0.4, -0.3, 0.2, 0.1]);
    expect(Array.from(reverseSamples(reversed))).toEqual(Array.from(original));
  });
});

describe('scoreSignals', () => {
  it('gives identical meaningful audio a very high score', () => {
    const sampleRate = 16_000;
    const audio = sine(1.2, sampleRate, 220);
    const result = scoreSignals(audio, sampleRate, audio, sampleRate);
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThanOrEqual(95);
  });

  it('rejects silence', () => {
    const silence = new Float32Array(16_000);
    expect(scoreSignals(silence, 16_000, silence, 16_000)).toBeNull();
  });

  it('scores a clearly different signal lower than an identical one', () => {
    const sampleRate = 16_000;
    const a = sine(1.2, sampleRate, 180);
    const b = sine(1.2, sampleRate, 720);
    const same = scoreSignals(a, sampleRate, a, sampleRate)!;
    const different = scoreSignals(a, sampleRate, b, sampleRate)!;
    expect(different.score).toBeLessThan(same.score);
  });
});
