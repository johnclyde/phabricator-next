type MicrophoneUse = 'audio' | 'commands';
interface MicrophoneLease { kind: MicrophoneUse; stop: () => void }
let current: MicrophoneLease | null = null;

/** An audio recording must never share capture with provider-backed recognition. */
export function claimMicrophone(kind: MicrophoneUse, stop: () => void): () => void {
  if (current && (current.kind === 'audio' || kind === 'commands')) {
    throw new Error(current.kind === 'audio' ? 'Stop the audio recording before starting voice commands or another recording.' : 'Voice command capture is already active.');
  }
  const previous = current;
  const lease = { kind, stop };
  current = lease;
  try { previous?.stop(); }
  catch (error) { if (current === lease) current = previous; throw error; }
  return () => { if (current === lease) current = null; };
}
