// Telemetry HTTP routes (CONTRACTS §14, ARCHITECTURE §7.4).
// telemetryRouter mounts at /api/telemetry (X-Telemetry-Key auth, no JWT).
// telemetryOpsRouter mounts at /api/ops/telemetry (Operator JWT guard applied at /api/ops).

import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../core/config';
import {
  optional,
  requireEnum,
  requireInt,
  requireNumber,
  requireString,
  unauthenticated,
} from '../core/errors';
import { INCIDENT_RESOURCE_TYPES } from '../types/enums';
import { ingest, recordReject } from './ingestion';
import { listRejects, queueBattery, queueFault, stallHub } from './telemetry.service';

const STALL_MIN_SECONDS = 1;
const STALL_MAX_SECONDS = 600;

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function wrap(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// Length-safe constant-time comparison for X-Telemetry-Key (Rule 1).
function isValidTelemetryKey(provided: string | undefined): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const expectedBuf = Buffer.from(config.TELEMETRY_KEY, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    // CompareexpectedBuf against itself to keep constant time before returning false.
    crypto.timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

export const telemetryRouter = Router();

telemetryRouter.post(
  '/',
  wrap(async (req, res) => {
    const keyHeader = req.header('X-Telemetry-Key');
    if (!isValidTelemetryKey(keyHeader)) {
      const body = req.body as Record<string, unknown> | undefined;
      const hubId =
        body && typeof body === 'object' && typeof body['hubId'] === 'string' && body['hubId'].trim() !== ''
          ? body['hubId'].trim()
          : null;
      await recordReject({
        hubId,
        packetTimestamp: null,
        reason: 'BAD_KEY',
        payload: hubId ? { hubId } : {},
      });
      throw unauthenticated();
    }

    const result = await ingest(req.body);
    res.status(202).json({
      accepted: true,
      hubId: result.hubId,
      appliedAt: result.appliedAt,
    });
  }),
);

export const telemetryOpsRouter = Router();

telemetryOpsRouter.post(
  '/demo/stall',
  wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const hubId = requireString(body, 'hubId', { min: 1, trim: true });
    const seconds = requireInt(body, 'seconds', {
      min: STALL_MIN_SECONDS,
      max: STALL_MAX_SECONDS,
    });

    const out = await stallHub({ hubId, seconds }, req.user!);
    res.json(out);
  }),
);

telemetryOpsRouter.post(
  '/demo/fault',
  wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const resourceType = requireEnum(body, 'resourceType', INCIDENT_RESOURCE_TYPES);
    const resourceId = requireString(body, 'resourceId', { min: 1, trim: true });
    const faultCode = requireString(body, 'faultCode', { min: 1, trim: true });

    const out = await queueFault({ resourceType, resourceId, faultCode }, req.user!);
    res.json(out);
  }),
);

telemetryOpsRouter.post(
  '/demo/battery',
  wrap(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const vehicleId = requireString(body, 'vehicleId', { min: 1, trim: true });
    const batteryPct = requireNumber(body, 'batteryPct', { min: 0, max: 100 });

    const out = await queueBattery({ vehicleId, batteryPct }, req.user!);
    res.json(out);
  }),
);

telemetryOpsRouter.get(
  '/rejects',
  wrap(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const limit =
      optional(requireInt)(q, 'limit', { min: 1, max: config.LIST_LIMIT_MAX }) ??
      config.LIST_LIMIT_DEFAULT;

    const out = await listRejects(limit);
    res.json(out);
  }),
);
