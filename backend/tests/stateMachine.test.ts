import { describe, it, expect } from 'vitest';
import { transitions, assertTransition, canTransition, type Entity } from '../src/core/stateMachine';
import { InvalidStateTransitionError } from '../src/core/errors';

const entities = Object.keys(transitions) as Entity[];

describe('T-03 AC-4 BR-05 state machine', () => {
  for (const entity of entities) {
    const table = transitions[entity] as Record<string, readonly string[]>;
    const states = Object.keys(table);

    it(`T-03 AC-4 ${entity}: every allowed transition in SPEC §4 passes`, () => {
      for (const from of states) {
        for (const to of table[from] ?? []) {
          expect(canTransition(entity, from, to), `${entity} ${from}->${to}`).toBe(true);
          expect(() => assertTransition(entity, from, to), `${entity} ${from}->${to}`).not.toThrow();
        }
      }
    });

    it(`T-03 AC-4 ${entity}: same-state X->X is forbidden`, () => {
      for (const s of states) {
        expect(canTransition(entity, s, s), `${entity} ${s}->${s}`).toBe(false);
        expect(() => assertTransition(entity, s, s)).toThrow(InvalidStateTransitionError);
      }
    });

    it(`T-03 AC-4 ${entity}: forbidden moves throw 409 with details (>=3)`, () => {
      const forbidden: Array<[string, string]> = [];
      for (const from of states) {
        const allowed = table[from] ?? [];
        for (const to of states) {
          if (!allowed.includes(to)) forbidden.push([from, to]); // includes X->X
        }
      }
      expect(forbidden.length).toBeGreaterThanOrEqual(3);
      for (const [from, to] of forbidden) {
        let caught: unknown;
        try {
          assertTransition(entity, from, to);
        } catch (err) {
          caught = err;
        }
        expect(caught, `${entity} ${from}->${to} should throw`).toBeInstanceOf(
          InvalidStateTransitionError,
        );
        const e = caught as InvalidStateTransitionError;
        expect(e.status).toBe(409);
        expect(e.code).toBe('INVALID_STATE_TRANSITION');
        expect(e.details).toEqual({ entity, from, to });
      }
    });
  }
});
