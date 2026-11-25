// Private EV routes (CONTRACTS §7, FR-25..FR-28).
// Validates input, calls the service, sends the response. No Prisma in routes (AGENTS.md §4).

import { Router, type Request, type Response, type NextFunction } from 'express';
import {
  badRequest,
  optional,
  requireEnum,
  requireIsoDate,
  requireNumber,
  requireString,
} from '../../core/errors';
import { parseIdempotencyKey } from '../../core/idempotency';
import { PRIVATE_EV_TYPES, type PrivateEvType } from '../../types/enums';
import { PRIVATE_EV_LABEL_MAX, PRIVATE_EV_LABEL_MIN } from './privateEvs.rules';
import {
  bookParkingAndCharging,
  createPrivateEv,
  listPrivateEvs,
  removePrivateEv,
  updatePrivateEv,
  type UpdatePrivateEvInput,
} from './privateEvs.service';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function wrap(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.', 'body', [
      'Send a valid JSON object in the request body.',
    ]);
  }
  return body as Record<string, unknown>;
}

function requirePositiveCapacity(body: Record<string, unknown>): number {
  const n = requireNumber(body, 'batteryCapacityKwh');
  if (n <= 0) {
    throw badRequest('batteryCapacityKwh must be greater than 0.', 'batteryCapacityKwh');
  }
  return n;
}

export const privateEvsRouter = Router();

// GET /api/private-evs (FR-25)
privateEvsRouter.get(
  '/',
  wrap(async (req, res) => {
    const items = await listPrivateEvs(req.user!.id);
    res.status(200).json(items);
  }),
);

// POST /api/private-evs (FR-25, BR-13)
privateEvsRouter.post(
  '/',
  wrap(async (req, res) => {
    const body = asObject(req.body);
    const type = requireEnum(body, 'type', PRIVATE_EV_TYPES);
    const label = requireString(body, 'label', {
      trim: true,
      min: PRIVATE_EV_LABEL_MIN,
      max: PRIVATE_EV_LABEL_MAX,
    });
    const batteryCapacityKwh = requirePositiveCapacity(body);
    const batteryPct = requireNumber(body, 'batteryPct', { min: 0, max: 100 });

    const created = await createPrivateEv(req.user!.id, {
      type,
      label,
      batteryCapacityKwh,
      batteryPct,
    });
    res.status(201).json(created);
  }),
);

// PATCH /api/private-evs/:id (FR-26)
privateEvsRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const body = asObject(req.body);
    const patch: UpdatePrivateEvInput = {};

    // Explicit `null` on an editable field is rejected with 400 details.field (T-14 approved plan).
    if (Object.prototype.hasOwnProperty.call(body, 'type') && body['type'] !== undefined) {
      patch.type = requireEnum(body, 'type', PRIVATE_EV_TYPES) as PrivateEvType;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'label') && body['label'] !== undefined) {
      patch.label = requireString(body, 'label', {
        trim: true,
        min: PRIVATE_EV_LABEL_MIN,
        max: PRIVATE_EV_LABEL_MAX,
      });
    }
    if (
      Object.prototype.hasOwnProperty.call(body, 'batteryCapacityKwh') &&
      body['batteryCapacityKwh'] !== undefined
    ) {
      patch.batteryCapacityKwh = requirePositiveCapacity(body);
    }
    if (
      Object.prototype.hasOwnProperty.call(body, 'batteryPct') &&
      body['batteryPct'] !== undefined
    ) {
      patch.batteryPct = requireNumber(body, 'batteryPct', { min: 0, max: 100 });
    }

    if (
      patch.type === undefined &&
      patch.label === undefined &&
      patch.batteryCapacityKwh === undefined &&
      patch.batteryPct === undefined
    ) {
      throw badRequest('Provide at least one editable field to update.', 'body', [
        'Include at least one of label, type, batteryCapacityKwh, or batteryPct.',
      ]);
    }

    const updated = await updatePrivateEv(req.user!.id, req.params.id as string, patch);
    res.status(200).json(updated);
  }),
);

// DELETE /api/private-evs/:id (FR-27)
privateEvsRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    await removePrivateEv(req.user!.id, req.params.id as string);
    res.status(204).send();
  }),
);

// POST /api/private-evs/:id/book-parking-charging (FR-28, BR-14, NFR-08)
privateEvsRouter.post(
  '/:id/book-parking-charging',
  wrap(async (req, res) => {
    const body = asObject(req.body);
    const hubId = requireString(body, 'hubId', { trim: true, min: 1 });
    const windowStart = requireIsoDate(body, 'windowStart');
    const windowEnd = requireIsoDate(body, 'windowEnd');
    const targetPct = requireNumber(body, 'targetPct', { max: 100 });
    if (targetPct <= 0) {
      throw badRequest('targetPct must be greater than 0 and at most 100.', 'targetPct');
    }
    const chargeStart = optional(requireIsoDate)(body, 'chargeStart');
    const idemKey = parseIdempotencyKey(req.headers['idempotency-key']);

    const result = await bookParkingAndCharging(
      req.user!,
      req.params.id as string,
      { hubId, windowStart, windowEnd, targetPct, chargeStart },
      { idemKey },
    );
    res.status(201).json(result);
  }),
);
