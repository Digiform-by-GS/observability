import { describe, expect, it, vi } from 'vitest';
import { registerUnloadFlush } from '../src/unload.js';

/** jsdom reports 'visible' and has no setter, so the property is redefined. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  });
}

describe('registerUnloadFlush', () => {
  it('flushes when the page becomes hidden', () => {
    const flush = vi.fn();
    const detach = registerUnloadFlush(flush);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(flush).toHaveBeenCalledTimes(1);
    detach();
  });

  it('does not flush when the page becomes visible again', () => {
    const flush = vi.fn();
    const detach = registerUnloadFlush(flush);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));

    expect(flush).not.toHaveBeenCalled();
    detach();
  });

  // pagehide covers the path visibilitychange misses: a navigation that
  // destroys the page without a hidden transition first.
  it('flushes on pagehide', () => {
    const flush = vi.fn();
    const detach = registerUnloadFlush(flush);

    window.dispatchEvent(new Event('pagehide'));

    expect(flush).toHaveBeenCalledTimes(1);
    detach();
  });

  // Both events fire on a real navigation. Flushing twice would double-export
  // the same batch.
  it('flushes once when hidden and pagehide fire together', () => {
    const flush = vi.fn();
    const detach = registerUnloadFlush(flush);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));

    expect(flush).toHaveBeenCalledTimes(1);
    detach();
  });

  it('detaches both listeners', () => {
    const flush = vi.fn();
    const detach = registerUnloadFlush(flush);
    detach();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));

    expect(flush).not.toHaveBeenCalled();
  });
});
