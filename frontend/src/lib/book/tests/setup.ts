import 'vitest-canvas-mock';
import '@testing-library/jest-dom/vitest';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;
}

// jsdom doesn't implement contenteditable editing state; browsers do.
if (!('isContentEditable' in HTMLElement.prototype) || document.createElement('div').isContentEditable === undefined) {
  Object.defineProperty(HTMLElement.prototype, 'isContentEditable', {
    configurable: true,
    get(this: HTMLElement): boolean {
      const host = this.closest('[contenteditable]');
      return !!host && host.getAttribute('contenteditable') !== 'false';
    },
  });
}
