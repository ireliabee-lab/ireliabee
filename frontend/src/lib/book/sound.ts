/** A synthesized paper rustle — no audio files needed. */

type AudioContextCtor = new () => AudioContext;

export interface SoundLike {
  enabled: boolean;
  play(): void;
}

export class PageSound implements SoundLike {
  enabled: boolean;
  private ctx: AudioContext | null = null;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  private context(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    const Ctor = g.AudioContext ?? g.webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      return null;
    }
    return this.ctx;
  }

  play(): void {
    if (!this.enabled) return;
    const ac = this.context();
    if (!ac) return;
    if (ac.state === 'suspended') void ac.resume();

    const duration = 0.45;
    const length = Math.floor(ac.sampleRate * duration);
    const buffer = ac.createBuffer(1, length, ac.sampleRate);
    const data = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.03 * white) / 1.03;
      const crackle = Math.random() < 0.015 ? white * 2.2 : 0;
      data[i] = brown * 2.4 + white * 0.22 + crackle;
    }

    const source = ac.createBufferSource();
    source.buffer = buffer;
    const band = ac.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.6;
    const t = ac.currentTime;
    band.frequency.setValueAtTime(1400, t);
    band.frequency.linearRampToValueAtTime(3600, t + duration * 0.7);
    const high = ac.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 350;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.32, t + 0.05);
    gain.gain.linearRampToValueAtTime(0.12, t + duration * 0.55);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    source.connect(band).connect(high).connect(gain).connect(ac.destination);
    source.start(t);
    source.stop(t + duration);
  }
}
