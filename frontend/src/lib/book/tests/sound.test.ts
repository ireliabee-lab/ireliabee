// @vitest-environment jsdom
import "./setup";
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageSound } from '../sound';

function fakeAudio(state: AudioContextState = 'running') {
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  const node = (): Record<string, unknown> => {
    const n: Record<string, unknown> = { frequency: param(), Q: param(), gain: param(), type: '' };
    n.connect = vi.fn(() => node());
    return n;
  };
  const source = { buffer: null, connect: vi.fn(() => node()), start: vi.fn(), stop: vi.fn() };
  const resume = vi.fn(async () => undefined);
  const ctor = vi.fn(function (this: Record<string, unknown>) {
    Object.assign(this, {
      state,
      resume,
      sampleRate: 8000,
      currentTime: 0,
      destination: {},
      createBuffer: (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) }),
      createBufferSource: () => source,
      createBiquadFilter: node,
      createGain: node,
    });
  });
  vi.stubGlobal('AudioContext', ctor);
  return { ctor, source, resume };
}

afterEach(() => vi.unstubAllGlobals());

describe('PageSound', () => {
  it('synthesizes a short rustle and reuses its audio context', () => {
    const { ctor, source } = fakeAudio();
    const sound = new PageSound();
    sound.play();
    sound.play();
    expect(ctor).toHaveBeenCalledTimes(1);
    expect(source.start).toHaveBeenCalledTimes(2);
  });

  it('resumes a suspended context', () => {
    const { resume } = fakeAudio('suspended');
    new PageSound().play();
    expect(resume).toHaveBeenCalled();
  });

  it('stays silent when disabled or unsupported', () => {
    const { ctor } = fakeAudio();
    new PageSound(false).play();
    expect(ctor).not.toHaveBeenCalled();
    vi.stubGlobal('AudioContext', undefined);
    expect(() => new PageSound().play()).not.toThrow();
  });

  it('survives a browser that refuses to create audio', () => {
    vi.stubGlobal('AudioContext', vi.fn(() => { throw new Error('blocked'); }));
    expect(() => new PageSound().play()).not.toThrow();
  });
});
