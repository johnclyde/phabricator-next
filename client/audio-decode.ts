import { LOCAL_TRANSCRIPTION_LIMITS as LIMITS, TranscriptionCancelledError } from '../shared/local-transcription.ts';

export interface DecodedAudio { sampleRate: number; length: number; numberOfChannels: number; getChannelData(channel: number): Float32Array }
/** No trimming, normalization or silence removal. Stereo channels are averaged at their original sample positions. */
export function transcriptionMonoPcm(audio: DecodedAudio): Float32Array {
  if (audio.sampleRate !== LIMITS.sampleRate || !Number.isSafeInteger(audio.length) || audio.length < 1 || audio.length > LIMITS.maxSamples || !Number.isInteger(audio.numberOfChannels) || audio.numberOfChannels < 1 || audio.numberOfChannels > LIMITS.maxChannels) throw new Error('Decoded audio must be nonempty, at most 10 minutes, and mono or stereo at 16 kHz.');
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const data = audio.getChannelData(channel);
    if (!(data instanceof Float32Array) || data.length !== audio.length) throw new Error('The browser returned incomplete decoded audio.');
    channels.push(data);
  }
  const samples = new Float32Array(audio.length);
  for (let index = 0; index < audio.length; index++) {
    let sum = 0;
    for (const channel of channels) { const value = channel[index]; if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error('Decoded audio contains invalid samples.'); sum += value; }
    samples[index] = sum / channels.length;
  }
  return samples;
}

/** Browser decoders allocate internally before returning. Our bounds apply to accepted output, not their native allocation. */
export async function decodeTranscriptionAudio(bytes: ArrayBuffer, signal: AbortSignal): Promise<Float32Array> {
  if (signal.aborted) throw new TranscriptionCancelledError();
  if (typeof AudioContext === 'undefined') throw new Error('This browser cannot decode recordings for local transcription.');
  const context = new AudioContext({ sampleRate: LIMITS.sampleRate });
  const stop = () => { void context.close().catch(() => {}); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    const audio = await context.decodeAudioData(bytes);
    if (signal.aborted) throw new TranscriptionCancelledError();
    return transcriptionMonoPcm(audio);
  } finally { signal.removeEventListener('abort', stop); stop(); }
}
