import { AUDIO_INBOX_LIMITS } from './audio-inbox';
import { claimMicrophone } from './microphone';

export interface AudioCaptureState { phase: 'idle' | 'requesting' | 'recording' | 'stopping'; elapsedMs: number; bytes: number }
export interface AudioCaptureResult { blob: Blob; durationMs: number; notice: string }
interface CaptureOptions {
  active: () => boolean;
  changed: (state: AudioCaptureState) => void;
  completed: (result: AudioCaptureResult) => void;
  failed: (message: string) => void;
  microphone: (active: boolean) => void;
}
const TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
export function audioRecordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}
function permissionError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was denied. Allow it in your browser settings, then choose Record audio again.';
  if (name === 'NotFoundError') return 'No microphone is available. Connect one, then try again.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone could not be opened. Another application or the device may be using it.';
  return 'Audio recording could not start in this browser. No audio was saved.';
}

/** One explicit capture. Cancelling retires both pending permissions and late events. */
export class AudioCapture {
  private generation = 0;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private release: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private stoppingTimeout: ReturnType<typeof setTimeout> | null = null;
  private chunks: Blob[] = [];
  private bytes = 0;
  private startedAt = 0;
  private duration = 0;
  private notice = '';
  private phase: AudioCaptureState['phase'] = 'idle';
  constructor(private readonly options: CaptureOptions) {}
  get busy(): boolean { return this.phase !== 'idle'; }
  private state() { this.options.changed({ phase: this.phase, elapsedMs: this.phase === 'recording' ? Math.max(0, performance.now() - this.startedAt) : this.duration, bytes: this.bytes }); }
  private stopTracks() { for (const track of this.stream?.getTracks() || []) track.stop(); }
  private clearTimers() {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.deadline !== null) clearTimeout(this.deadline);
    if (this.stoppingTimeout !== null) clearTimeout(this.stoppingTimeout);
    this.timer = null; this.deadline = null; this.stoppingTimeout = null;
  }
  private finish() {
    this.clearTimers(); this.stopTracks();
    if (this.recorder) this.recorder.ondataavailable = this.recorder.onstop = this.recorder.onerror = null;
    this.recorder = null; this.stream = null; this.chunks = []; this.bytes = 0;
    this.release?.(); this.release = null; this.phase = 'idle'; this.options.microphone(false); this.state();
  }
  cancel() {
    this.generation++;
    const recorder = this.recorder;
    if (recorder) recorder.ondataavailable = recorder.onstop = recorder.onerror = null;
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* All tracks are stopped independently. */ }
    this.finish();
  }
  private fail(message: string) { const deliver = this.options.active(); this.cancel(); if (deliver) this.options.failed(message); }
  async start(): Promise<void> {
    if (this.busy || !this.options.active()) return;
    if (!audioRecordingSupported()) { this.options.failed('Audio recording is unavailable in this browser. A supported browser on HTTPS or localhost is required.'); return; }
    try { this.release = claimMicrophone('audio', () => this.cancel()); }
    catch (error) { this.options.failed(error instanceof Error ? error.message : 'Another recording is already using the microphone.'); return; }
    const ticket = ++this.generation;
    this.phase = 'requesting'; this.duration = 0; this.notice = ''; this.options.microphone(true); this.state();
    let granted: MediaStream;
    try { granted = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
    catch (error) { if (ticket === this.generation) this.fail(permissionError(error)); return; }
    if (ticket !== this.generation || !this.options.active()) { for (const track of granted.getTracks()) track.stop(); if (ticket === this.generation) this.cancel(); return; }
    this.stream = granted;
    if (!granted.getAudioTracks().some(track => track.readyState === 'live')) { this.fail('The microphone did not provide a live audio track. No audio was saved.'); return; }
    try {
      const mimeType = TYPES.find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(granted, mimeType ? { mimeType } : undefined);
      this.recorder = recorder;
      const current = () => ticket === this.generation && this.options.active() && this.recorder === recorder;
      recorder.ondataavailable = event => {
        if (!current() || !event.data.size) return;
        if (event.data.size > AUDIO_INBOX_LIMITS.maxClipBytes - this.bytes) {
          this.fail('The browser delivered audio beyond the 25 MiB limit. Recording stopped and this clip was not retained; no partial container was saved. Try a shorter recording.'); return;
        }
        this.chunks.push(event.data); this.bytes += event.data.size; this.state();
        if (this.bytes >= AUDIO_INBOX_LIMITS.maxClipBytes) this.stop('Recording stopped at the 25 MiB limit.');
      };
      recorder.onerror = () => { if (current()) this.fail('The browser reported a recording error. The microphone was stopped and the unsuccessful clip was not retained.'); };
      recorder.onstop = () => {
        if (!current()) return;
        if (this.phase !== 'stopping') { this.duration = Math.max(1, performance.now() - this.startedAt); this.notice = 'The audio input ended. Check playback before saving.'; }
        if (this.duration > AUDIO_INBOX_LIMITS.maxDurationMs) { this.fail('The browser delayed stopping beyond the ten-minute limit. This clip was not retained. Keep the page visible and record a shorter clip.'); return; }
        const blob = new Blob(this.chunks, { type: recorder.mimeType || this.chunks[0]?.type || '' });
        const result = { blob, durationMs: this.duration, notice: this.notice };
        if (!blob.size) { this.fail('No audio bytes were captured. Nothing was saved. Check the microphone and try again.'); return; }
        this.finish(); if (this.options.active()) this.options.completed(result);
      };
      for (const track of granted.getAudioTracks()) track.addEventListener('ended', () => { if (current()) this.stop('The audio input ended. Check playback before saving.'); }, { once: true });
      this.startedAt = performance.now(); this.phase = 'recording'; recorder.start(1000); this.state();
      this.timer = setInterval(() => { if (!current()) { this.cancel(); return; } this.state(); if (performance.now() - this.startedAt >= AUDIO_INBOX_LIMITS.maxDurationMs - 1000) this.stop('Recording stopped near the ten-minute limit.'); }, 250);
      this.deadline = setTimeout(() => this.stop('Recording stopped near the ten-minute limit.'), AUDIO_INBOX_LIMITS.maxDurationMs - 1000);
    } catch (error) { if (ticket === this.generation) this.fail(permissionError(error)); }
  }
  stop(notice = '') {
    if (this.phase === 'requesting') { this.cancel(); return; }
    if (this.phase !== 'recording' || !this.recorder) return;
    if (!this.options.active()) { this.cancel(); return; }
    this.duration = Math.max(1, performance.now() - this.startedAt); this.notice = notice; this.phase = 'stopping'; this.clearTimers(); this.state();
    try {
      if (this.recorder.state !== 'inactive') this.recorder.stop();
      this.stopTracks();
      this.stoppingTimeout = setTimeout(() => { if (this.phase === 'stopping') this.fail('The browser did not finish the audio file. The microphone is stopped; this clip was not retained.'); }, 5000);
    } catch { this.fail('The browser could not finish the audio file. The microphone is stopped; this clip was not retained.'); }
  }
}
