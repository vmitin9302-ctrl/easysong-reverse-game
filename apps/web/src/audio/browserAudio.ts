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
  if (context.state === 'suspended') await context.resume();

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
