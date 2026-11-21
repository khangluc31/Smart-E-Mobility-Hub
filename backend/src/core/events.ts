// Typed, post-commit event bus (ARCHITECTURE §4.6).
// emit ONLY after the transaction commits — listeners do side effects that are
// safe to lose, because the interval jobs repeat them anyway.
import { EventEmitter } from 'node:events';

export interface EventPayloads {
  TELEMETRY_INGESTED: { hubId: string };
  CHARGING_QUEUE_CHANGED: { hubId: string };
  RESOURCE_WITHDRAWN: { hubId: string };
  RESERVATION_CHANGED: { hubId: string };
}

export type EventName = keyof EventPayloads;

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

export const events = {
  on<E extends EventName>(event: E, listener: (payload: EventPayloads[E]) => void | Promise<void>): void {
    emitter.on(event, (payload: EventPayloads[E]) => {
      // A throwing or rejecting listener must never break emit or other listeners.
      try {
        const result = listener(payload);
        if (result instanceof Promise) {
          result.catch((err) => console.error(`[events] listener for ${event} rejected`, err));
        }
      } catch (err) {
        console.error(`[events] listener for ${event} threw`, err);
      }
    });
  },

  // Fire-and-forget: never throws, never awaits listeners.
  emit<E extends EventName>(event: E, payload: EventPayloads[E]): void {
    emitter.emit(event, payload);
  },
};
