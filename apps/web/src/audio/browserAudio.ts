export function createAudioContext(): AudioContext {
  return new AudioContext({ latencyHint: 'interactive' });
}

export function selectRecorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

export async function decodeRecording(context: AudioContext, blob: Blob): Promise<AudioBuffer> {
  const bytes = await blob.arrayBuffer();
  return context.decodeAudioData(bytes.slice(0));
}

export function reverseAudioBuffer(context: AudioContext, source: AudioBuffer): AudioBuffer {
  const output = context.createBuffer(
    source.numberOfChannels,
    source.length,
    source.sampleRate,
  );

  for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
    const input = source.getChannelData(channel);
    const destination = output.getChannelData(channel);
    for (let i = 0; i < input.length; i += 1) {
      destination[i] = input[input.length - 1 - i];
    }
  }

  return output;
}

export function audioBufferToMono(buffer: AudioBuffer): Float32Array {
  const output = new Float32Array(buffer.length);
  const channelCount = Math.max(1, buffer.numberOfChannels);

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      output[i] += data[i] / channelCount;
    }
  }

  return output;
}

export async function playAudioBuffer(context: AudioContext, buffer: AudioBuffer): Promise<void> {
  // HTMLAudio is more reliable than a BufferSource on iOS Safari: it keeps the
  // user gesture that started playback and routes sound to the media speaker.
  if (typeof Audio !== 'undefined' && typeof URL !== 'undefined') {
    const url = URL.createObjectURL(audioBufferToWav(buffer));
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.volume = 1;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          if (error) reject(error); else resolve();
        };
        const timeout = window.setTimeout(() => finish(new Error('Audio playback timed out')), 15_000);
        audio.addEventListener('ended', () => finish(), { once: true });
        audio.addEventListener('error', () => finish(new Error('Audio playback failed')), { once: true });
        audio.play()?.catch(() => finish(new Error('Audio playback was blocked')));
      });
      return;
    } finally {
      audio.pause();
      URL.revokeObjectURL(url);
    }
  }

  if (context.state !== 'running') await context.resume();

  await new Promise<void>((resolve, reject) => {
    try {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.addEventListener('ended', () => resolve(), { once: true });
      source.start();
    } catch (error) {
      reject(error);
    }
  });
}

export function normalizedGameAudio(context: AudioContext, samples: Float32Array, sampleRate: number): AudioBuffer {
  const output = context.createBuffer(1, samples.length, sampleRate);
  output.getChannelData(0).set(samples);
  return output;
}

export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const length = buffer.length * channels * 2;
  const bytes = new ArrayBuffer(44 + length);
  const view = new DataView(bytes);
  const write = (offset: number, value: string) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  write(0, 'RIFF'); view.setUint32(4, 36 + length, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, length, true);
  let offset = 44;
  for (let i = 0; i < buffer.length; i += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true); offset += 2;
    }
  }
  return new Blob([bytes], { type: 'audio/wav' });
}
