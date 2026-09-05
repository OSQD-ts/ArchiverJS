import { describe, expect, it, vi } from 'vitest';
import { TypedEmitter } from '../src/internal/emitter.js';

interface Events {
  ping: (value: number) => void;
  pong: () => void;
}

describe('TypedEmitter', () => {
  it('delivers to every listener and unsubscribes through the returned handle', () => {
    const emitter = new TypedEmitter<Events>();
    const seen: number[] = [];
    const off = emitter.on('ping', (value) => seen.push(value));
    emitter.on('ping', (value) => seen.push(value * 10));

    emitter.emit('ping', 1);
    off();
    emitter.emit('ping', 2);

    expect(seen).toEqual([1, 10, 20]);
    expect(emitter.listenerCount('ping')).toBe(1);
  });

  it('supports once, off and removeAllListeners', () => {
    const emitter = new TypedEmitter<Events>();
    const once = vi.fn();
    const forever = vi.fn();
    emitter.once('pong', once);
    emitter.on('pong', forever);

    emitter.emit('pong');
    emitter.emit('pong');
    expect(once).toHaveBeenCalledTimes(1);
    expect(forever).toHaveBeenCalledTimes(2);

    emitter.off('pong', forever);
    emitter.emit('pong');
    expect(forever).toHaveBeenCalledTimes(2);

    emitter.on('ping', vi.fn());
    emitter.removeAllListeners('ping');
    expect(emitter.listenerCount('ping')).toBe(0);
    emitter.on('ping', vi.fn());
    emitter.removeAllListeners();
    expect(emitter.listenerCount('ping')).toBe(0);
  });

  it('keeps dispatching when a listener throws, and reports it', () => {
    const failures: unknown[] = [];
    const emitter = new TypedEmitter<Events>((error) => failures.push(error));
    const after = vi.fn();
    emitter.on('pong', () => {
      throw new Error('listener is broken');
    });
    emitter.on('pong', after);

    emitter.emit('pong');

    // A broken metrics listener must not take an archival run down with it.
    expect(after).toHaveBeenCalledOnce();
    expect((failures[0] as Error).message).toBe('listener is broken');
  });

  it('survives a listener that unsubscribes itself mid-dispatch', () => {
    const emitter = new TypedEmitter<Events>();
    const calls: string[] = [];
    const off = emitter.on('pong', () => {
      calls.push('first');
      off();
    });
    emitter.on('pong', () => calls.push('second'));

    emitter.emit('pong');
    emitter.emit('pong');

    expect(calls).toEqual(['first', 'second', 'second']);
  });

  it('emitting with nothing attached is a no-op', () => {
    expect(() => new TypedEmitter<Events>().emit('pong')).not.toThrow();
  });
});
