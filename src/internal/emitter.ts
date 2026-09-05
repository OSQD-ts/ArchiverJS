/**
 * Minimal typed event emitter.
 *
 * Deliberately not `node:events`: a thrown listener must never break an
 * archival run, and `EventEmitter`'s untyped surface would lose the payload
 * types that make the events worth subscribing to.
 */

export type EventMap = Record<PropertyKey, (...args: never[]) => void>;

export class TypedEmitter<Events extends { [K in keyof Events]: (...args: never[]) => void }> {
  readonly #listeners = new Map<keyof Events, Set<(...args: never[]) => void>>();
  readonly #onListenerError: (error: unknown, event: keyof Events) => void;

  constructor(onListenerError?: (error: unknown, event: keyof Events) => void) {
    this.#onListenerError = onListenerError ?? (() => {});
  }

  /** Subscribe. Returns an unsubscribe function. */
  on<E extends keyof Events>(event: E, listener: Events[E]): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  /** Subscribe until the first delivery. */
  once<E extends keyof Events>(event: E, listener: Events[E]): () => void {
    const wrapper = ((...args: Parameters<Events[E]>) => {
      this.off(event, wrapper);
      (listener as unknown as (...a: unknown[]) => void)(...args);
    }) as Events[E];
    return this.on(event, wrapper);
  }

  off<E extends keyof Events>(event: E, listener: Events[E]): void {
    this.#listeners.get(event)?.delete(listener);
  }

  removeAllListeners(event?: keyof Events): void {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
  }

  listenerCount(event: keyof Events): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  emit<E extends keyof Events>(event: E, ...args: Parameters<Events[E]>): void {
    const set = this.#listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy first: a listener may unsubscribe itself during dispatch.
    for (const listener of [...set]) {
      try {
        (listener as unknown as (...a: unknown[]) => void)(...args);
      } catch (error) {
        this.#onListenerError(error, event);
      }
    }
  }
}
