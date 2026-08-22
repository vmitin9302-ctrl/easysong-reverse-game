export type PreparedSignal = {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
  rms: number;
};

export type ScoreBreakdown = {
  score: number;
  acousticSimilarity: number;
  rhythmSimilarity: number;
  durationSimilarity: number;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function reverseSamples(input: Float32Array): Float32Array {
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    output[i] = input[input.length - 1 - i];
  }
  return output;
}

export function computeRms(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    sum += value * value;
  }
  return Math.sqrt(sum / samples.length);
}

export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate = 16_000,
): Float32Array {
  if (!input.length || fromRate === toRate) return new Float32Array(input);

  const ratio = toRate / fromRate;
  const outputLength = Math.max(1, Math.round(input.length * ratio));
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i += 1) {
    const sourcePosition = i / ratio;
    const left = Math.floor(sourcePosition);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = sourcePosition - left;
    output[i] = input[left] * (1 - fraction) + input[right] * fraction;
  }

  return output;
}

export function trimSilence(
  input: Float32Array,
  sampleRate: number,
  threshold = 0.012,
  paddingMs = 100,
): Float32Array {
  if (!input.length) return input;

  const windowSize = Math.max(1, Math.floor(sampleRate * 0.02));
  let first = -1;
  let last = -1;

  for (let start = 0; start < input.length; start += windowSize) {
    const end = Math.min(input.length, start + windowSize);
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    if (rms >= threshold) {
      if (first < 0) first = start;
      last = end;
    }
  }

  if (first < 0 || last < 0) return new Float32Array();

  const padding = Math.floor((paddingMs / 1000) * sampleRate);
  const from = Math.max(0, first - padding);
  const to = Math.min(input.length, last + padding);
  return input.slice(from, to);
}

export function normalizeRms(input: Float32Array, targetRms = 0.12): Float32Array {
  const rms = computeRms(input);
  if (!input.length || rms < 1e-6) return new Float32Array(input);
  const gain = Math.min(12, targetRms / rms);
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    output[i] = Math.max(-1, Math.min(1, input[i] * gain));
  }
  return output;
}

export function prepareSignal(
  input: Float32Array,
  sampleRate: number,
  targetRate = 16_000,
): PreparedSignal | null {
  if (!input.length || sampleRate <= 0) return null;

  const rawRms = computeRms(input);
  if (rawRms < 0.004) return null;

  const resampled = resampleLinear(input, sampleRate, targetRate);
  const trimmed = trimSilence(resampled, targetRate);
  const durationMs = (trimmed.length / targetRate) * 1000;

  if (durationMs < 650 || !trimmed.length) return null;

  return {
    samples: normalizeRms(trimmed),
    sampleRate: targetRate,
    durationMs,
    rms: rawRms,
  };
}

type FrameFeature = [number, number, number];

function extractFrameFeatures(signal: PreparedSignal): FrameFeature[] {
  const frameSize = Math.max(16, Math.round(signal.sampleRate * 0.025));
  const hopSize = Math.max(8, Math.round(signal.sampleRate * 0.01));
  const features: FrameFeature[] = [];

  for (let start = 0; start + frameSize <= signal.samples.length; start += hopSize) {
    let energy = 0;
    let zeroCrossings = 0;
    let derivative = 0;
    let previous = signal.samples[start];

    for (let i = start; i < start + frameSize; i += 1) {
      const current = signal.samples[i];
      energy += current * current;
      if (i > start) {
        if ((current >= 0 && previous < 0) || (current < 0 && previous >= 0)) {
          zeroCrossings += 1;
        }
        derivative += Math.abs(current - previous);
      }
      previous = current;
    }

    const rms = Math.sqrt(energy / frameSize);
    const zcr = zeroCrossings / frameSize;
    const diff = derivative / frameSize;
    features.push([rms, zcr * 4, diff * 2]);
  }

  return features;
}

function featureDistance(a: FrameFeature, b: FrameFeature): number {
  const d0 = a[0] - b[0];
  const d1 = a[1] - b[1];
  const d2 = a[2] - b[2];
  return Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
}

function dtwSimilarity(a: FrameFeature[], b: FrameFeature[]): number {
  if (!a.length || !b.length) return 0;

  const n = a.length;
  const m = b.length;
  const band = Math.max(Math.abs(n - m), Math.ceil(Math.max(n, m) * 0.22));
  let previous = new Float64Array(m + 1);
  let current = new Float64Array(m + 1);
  previous.fill(Number.POSITIVE_INFINITY);
  previous[0] = 0;

  for (let i = 1; i <= n; i += 1) {
    current.fill(Number.POSITIVE_INFINITY);
    const from = Math.max(1, i - band);
    const to = Math.min(m, i + band);

    for (let j = from; j <= to; j += 1) {
      const cost = featureDistance(a[i - 1], b[j - 1]);
      current[j] = cost + Math.min(previous[j], current[j - 1], previous[j - 1]);
    }

    [previous, current] = [current, previous];
  }

  const normalizedDistance = previous[m] / Math.max(1, n + m);
  return clamp01(Math.exp(-normalizedDistance * 11));
}

function envelope(signal: PreparedSignal, bins = 72): number[] {
  const output = new Array<number>(bins).fill(0);
  for (let bin = 0; bin < bins; bin += 1) {
    const start = Math.floor((bin / bins) * signal.samples.length);
    const end = Math.max(start + 1, Math.floor(((bin + 1) / bins) * signal.samples.length));
    let sum = 0;
    for (let i = start; i < Math.min(end, signal.samples.length); i += 1) {
      sum += signal.samples[i] * signal.samples[i];
    }
    output[bin] = Math.sqrt(sum / Math.max(1, end - start));
  }
  return output;
}

function pearsonSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (!length) return 0;
  const meanA = a.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  const meanB = b.slice(0, length).reduce((sum, value) => sum + value, 0) / length;
  let numerator = 0;
  let denomA = 0;
  let denomB = 0;

  for (let i = 0; i < length; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    numerator += da * db;
    denomA += da * da;
    denomB += db * db;
  }

  if (denomA < 1e-9 || denomB < 1e-9) return 0;
  const correlation = numerator / Math.sqrt(denomA * denomB);
  return clamp01((correlation + 1) / 2);
}

export function scoreSignals(
  originalSamples: Float32Array,
  originalRate: number,
  reconstructedSamples: Float32Array,
  reconstructedRate: number,
): ScoreBreakdown | null {
  const original = prepareSignal(originalSamples, originalRate);
  const reconstructed = prepareSignal(reconstructedSamples, reconstructedRate);
  if (!original || !reconstructed) return null;

  const acousticSimilarity = dtwSimilarity(
    extractFrameFeatures(original),
    extractFrameFeatures(reconstructed),
  );
  const rhythmSimilarity = pearsonSimilarity(envelope(original), envelope(reconstructed));
  const durationSimilarity = clamp01(
    Math.min(original.durationMs, reconstructed.durationMs) /
      Math.max(original.durationMs, reconstructed.durationMs),
  );

  const weighted =
    acousticSimilarity * 0.7 + rhythmSimilarity * 0.2 + durationSimilarity * 0.1;

  return {
    score: Math.round(clamp01(weighted) * 100),
    acousticSimilarity,
    rhythmSimilarity,
    durationSimilarity,
  };
}
