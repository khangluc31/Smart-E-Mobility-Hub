import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, resetDb, loginAs } from './helpers';
import { db } from '../src/core/db';
import { reserveParking } from '../src/modules/reservations/parkingReservations.service';

const app = createTestApp();
const student1Token = loginAs('student1');
const student2Token = loginAs('student2');
const operator1Token = loginAs('operator1');

interface ErrorBody {
  error: {
    code: string;
    message: string;
    nextActions: string[];
    details?: Record<string, unknown>;
  };
}

interface PrivateEvDto {
  id: string;
  type: 'E_MOTORCYCLE' | 'CAR';
  vehicleClass: 'MOTORCYCLE' | 'CAR';
  label: string;
  batteryCapacityKwh: number;
  batteryPct: number;
  hasActiveBooking: boolean;
}

function relFromNow(offsetMs: number): Date {
  return new Date(Date.now() + offsetMs);
}

const HOUR_MS = 3_600_000;

async function createEvViaApi(
  token: string,
  overrides: Partial<{
    type: 'E_MOTORCYCLE' | 'CAR';
    label: string;
    batteryCapacityKwh: number;
    batteryPct: number;
  }> = {},
): Promise<PrivateEvDto> {
  const res = await request(app)
    .post('/api/private-evs')
    .set('Authorization', token)
    .send({
      type: 'E_MOTORCYCLE',
      label: 'Test Moto',
      batteryCapacityKwh: 4.5,
      batteryPct: 65,
      ...overrides,
    });
  expect(res.status).toBe(201);
  return res.body as PrivateEvDto;
}

describe('Private EVs (T-14)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // ---- AC-1: FR-25 register ----

  it('FR-25 AC-1 register derives the class from the type and ignores client vehicleClass', async () => {
    const rentalCountBefore = await db.rentalVehicle.count();

    const motoRes = await request(app)
      .post('/api/private-evs')
      .set('Authorization', student1Token)
      .send({
        type: 'E_MOTORCYCLE',
        label: '  Zippy Moto  ',
        batteryCapacityKwh: 5.5,
        batteryPct: 42,
      });

    expect(motoRes.status).toBe(201);
    const moto = motoRes.body as PrivateEvDto;
    expect(moto).toEqual({
      id: expect.any(String),
      type: 'E_MOTORCYCLE',
      vehicleClass: 'MOTORCYCLE',
      label: 'Zippy Moto',
      batteryCapacityKwh: 5.5,
      batteryPct: 42,
      hasActiveBooking: false,
    });

    const carRes = await request(app)
      .post('/api/private-evs')
      .set('Authorization', student1Token)
      .send({
        type: 'CAR',
        vehicleClass: 'MOTORCYCLE', // must be ignored
        label: 'Campus Sedan',
        batteryCapacityKwh: 60,
        batteryPct: 80,
      });

    expect(carRes.status).toBe(201);
    const car = carRes.body as PrivateEvDto;
    expect(car).toEqual({
      id: expect.any(String),
      type: 'CAR',
      vehicleClass: 'CAR',
      label: 'Campus Sedan',
      batteryCapacityKwh: 60,
      batteryPct: 80,
      hasActiveBooking: false,
    });

    // BR-08: never appears in rental fleet or rental search
    expect(await db.rentalVehicle.count()).toBe(rentalCountBefore);
    const searchRes = await request(app)
      .get('/api/vehicles/search')
      .set('Authorization', student1Token);
    expect(searchRes.status).toBe(200);
    const vehicleIds = (searchRes.body as Array<{ id: string }>).map((v) => v.id);
    expect(vehicleIds).not.toContain(moto.id);
    expect(vehicleIds).not.toContain(car.id);
  });

  // ---- AC-2: FR-25 validation boundaries ----

  it('FR-25 AC-2 validation boundaries reject bad input with 400 details.field and create nothing', async () => {
    const initialCount = await db.privateEv.count();

    const invalidCases: Array<{
      name: string;
      body: Record<string, unknown>;
      field: string;
    }> = [
      {
        name: 'missing type',
        body: { label: 'X', batteryCapacityKwh: 5, batteryPct: 50 },
        field: 'type',
      },
      {
        name: 'bad type',
        body: { type: 'E_BICYCLE', label: 'X', batteryCapacityKwh: 5, batteryPct: 50 },
        field: 'type',
      },
      {
        name: 'missing label',
        body: { type: 'CAR', batteryCapacityKwh: 50, batteryPct: 50 },
        field: 'label',
      },
      {
        name: 'whitespace-only label',
        body: { type: 'CAR', label: '   ', batteryCapacityKwh: 50, batteryPct: 50 },
        field: 'label',
      },
      {
        name: '65-char label',
        body: { type: 'CAR', label: 'a'.repeat(65), batteryCapacityKwh: 50, batteryPct: 50 },
        field: 'label',
      },
      {
        name: 'missing capacity',
        body: { type: 'CAR', label: 'My EV', batteryPct: 50 },
        field: 'batteryCapacityKwh',
      },
      {
        name: 'capacity 0',
        body: { type: 'CAR', label: 'My EV', batteryCapacityKwh: 0, batteryPct: 50 },
        field: 'batteryCapacityKwh',
      },
      {
        name: 'negative capacity',
        body: { type: 'CAR', label: 'My EV', batteryCapacityKwh: -2, batteryPct: 50 },
        field: 'batteryCapacityKwh',
      },
      {
        name: 'missing batteryPct',
        body: { type: 'CAR', label: 'My EV', batteryCapacityKwh: 50 },
        field: 'batteryPct',
      },
      {
        name: 'batteryPct -1',
        body: { type: 'CAR', label: 'My EV', batteryCapacityKwh: 50, batteryPct: -1 },
        field: 'batteryPct',
      },
      {
        name: 'batteryPct 101',
        body: { type: 'CAR', label: 'My EV', batteryCapacityKwh: 50, batteryPct: 101 },
        field: 'batteryPct',
      },
    ];

    for (const c of invalidCases) {
      const res = await request(app)
        .post('/api/private-evs')
        .set('Authorization', student1Token)
        .send(c.body);

      expect(res.status, c.name).toBe(400);
      const err = res.body as ErrorBody;
      expect(err.error.code, c.name).toBe('VALIDATION_ERROR');
      expect(err.error.details?.field, c.name).toBe(c.field);
      expect(err.error.nextActions.length, c.name).toBeGreaterThanOrEqual(1);
    }

    expect(await db.privateEv.count()).toBe(initialCount);

    // Accepted boundary values: 64-char label, batteryPct 0, batteryPct 100
    const res64Zero = await request(app)
      .post('/api/private-evs')
      .set('Authorization', student1Token)
      .send({
        type: 'E_MOTORCYCLE',
        label: 'a'.repeat(64),
        batteryCapacityKwh: 0.1,
        batteryPct: 0,
      });
    expect(res64Zero.status).toBe(201);
    expect((res64Zero.body as PrivateEvDto).label).toBe('a'.repeat(64));
    expect((res64Zero.body as PrivateEvDto).batteryPct).toBe(0);

    const res100 = await request(app)
      .post('/api/private-evs')
      .set('Authorization', student1Token)
      .send({
        type: 'CAR',
        label: 'A',
        batteryCapacityKwh: 100,
        batteryPct: 100,
      });
    expect(res100.status).toBe(201);
    expect((res100.body as PrivateEvDto).batteryPct).toBe(100);
  });

  // ---- AC-3: list and hasActiveBooking ----

  it('FR-26 AC-3 list and hasActiveBooking across all parking and charging statuses', async () => {
    // Clear student1's fixture EVs/bookings so we test every state cleanly
    await db.chargingRequest.deleteMany({ where: { ownerId: 'student1' } });
    await db.parkingReservation.deleteMany({ where: { userId: 'student1' } });
    await db.privateEv.deleteMany({ where: { ownerId: 'student1' } });

    const evDefs = [
      { id: 'EV-PR-CONF', label: '01-PR-CONF' },
      { id: 'EV-PR-ACT', label: '02-PR-ACT' },
      { id: 'EV-PR-CANC', label: '03-PR-CANC' },
      { id: 'EV-PR-EXP', label: '04-PR-EXP' },
      { id: 'EV-PR-COMP', label: '05-PR-COMP' },
      { id: 'EV-CR-QUEUED', label: '06-CR-QUEUED' },
      { id: 'EV-CR-SCHED', label: '07-CR-SCHED' },
      { id: 'EV-CR-CHRG', label: '08-CR-CHRG' },
      { id: 'EV-CR-CANC', label: '09-CR-CANC' },
      { id: 'EV-CR-COMP', label: '10-CR-COMP' },
      { id: 'EV-DELETED', label: '11-DELETED', deletedAt: new Date() },
    ];

    await db.privateEv.createMany({
      data: evDefs.map((e) => ({
        id: e.id,
        ownerId: 'student1',
        type: 'E_MOTORCYCLE',
        vehicleClass: 'MOTORCYCLE',
        label: e.label,
        batteryCapacityKwh: 4,
        batteryPct: 50,
        deletedAt: e.deletedAt ?? null,
      })),
    });

    // Parking reservations (non-overlapping windows or distinct spaces)
    await db.parkingReservation.createMany({
      data: [
        {
          id: 'T-PR-CONF',
          userId: 'student1',
          parkingSpaceId: 'DOR-P-M-01',
          hubId: 'dorm',
          vehicleClass: 'MOTORCYCLE',
          privateEvId: 'EV-PR-CONF',
          windowStart: relFromNow(1 * HOUR_MS),
          windowEnd: relFromNow(2 * HOUR_MS),
          status: 'CONFIRMED',
          expiresAt: relFromNow(1.25 * HOUR_MS),
        },
        {
          id: 'T-PR-ACT',
          userId: 'student1',
          parkingSpaceId: 'DOR-P-M-02',
          hubId: 'dorm',
          vehicleClass: 'MOTORCYCLE',
          privateEvId: 'EV-PR-ACT',
          windowStart: relFromNow(-0.5 * HOUR_MS),
          windowEnd: relFromNow(1 * HOUR_MS),
          status: 'ACTIVE',
          claimedAt: relFromNow(-0.4 * HOUR_MS),
          expiresAt: relFromNow(-0.25 * HOUR_MS),
        },
        {
          id: 'T-PR-CANC',
          userId: 'student1',
          parkingSpaceId: 'DOR-P-M-01',
          hubId: 'dorm',
          vehicleClass: 'MOTORCYCLE',
          privateEvId: 'EV-PR-CANC',
          windowStart: relFromNow(3 * HOUR_MS),
          windowEnd: relFromNow(4 * HOUR_MS),
          status: 'CANCELLED',
          expiresAt: relFromNow(3.25 * HOUR_MS),
        },
        {
          id: 'T-PR-EXP',
          userId: 'student1',
          parkingSpaceId: 'DOR-P-M-01',
          hubId: 'dorm',
          vehicleClass: 'MOTORCYCLE',
          privateEvId: 'EV-PR-EXP',
          windowStart: relFromNow(-3 * HOUR_MS),
          windowEnd: relFromNow(-2 * HOUR_MS),
          status: 'EXPIRED',
          expiresAt: relFromNow(-2.75 * HOUR_MS),
        },
        {
          id: 'T-PR-COMP',
          userId: 'student1',
          parkingSpaceId: 'DOR-P-M-01',
          hubId: 'dorm',
          vehicleClass: 'MOTORCYCLE',
          privateEvId: 'EV-PR-COMP',
          windowStart: relFromNow(-5 * HOUR_MS),
          windowEnd: relFromNow(-4 * HOUR_MS),
          status: 'COMPLETED',
          claimedAt: relFromNow(-4.9 * HOUR_MS),
          expiresAt: relFromNow(-4.75 * HOUR_MS),
        },
      ],
    });

    // Charging requests (respect ck_cr_slot: SCHEDULED/CHARGING with point has slotEnd > slotStart)
    await db.chargingRequest.createMany({
      data: [
        {
          id: 'T-CR-QUEUED',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'EV-CR-QUEUED',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'QUEUED',
          targetPct: 90,
          startPct: 50,
          currentPct: 50,
          desiredTime: relFromNow(0),
        },
        {
          id: 'T-CR-SCHED',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'EV-CR-SCHED',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'ADVANCE',
          status: 'SCHEDULED',
          targetPct: 90,
          startPct: 50,
          currentPct: 50,
          chargingPointId: 'DOR-CP-M-01',
          slotStart: relFromNow(2 * HOUR_MS),
          slotEnd: relFromNow(3 * HOUR_MS),
        },
        {
          id: 'T-CR-CHRG',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'EV-CR-CHRG',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'campus-a',
          mode: 'QUEUE',
          status: 'CHARGING',
          targetPct: 90,
          startPct: 50,
          currentPct: 55,
          chargingPointId: 'CPA-CP-M-01',
          slotStart: relFromNow(-0.2 * HOUR_MS),
          slotEnd: relFromNow(0.5 * HOUR_MS),
          startedAt: relFromNow(-0.2 * HOUR_MS),
        },
        {
          id: 'T-CR-CANC',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'EV-CR-CANC',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'CANCELLED',
          targetPct: 90,
          startPct: 50,
          currentPct: 50,
        },
        {
          id: 'T-CR-COMP',
          requestedById: 'student1',
          ownerId: 'student1',
          vehicleKind: 'PRIVATE',
          privateEvId: 'EV-CR-COMP',
          vehicleClass: 'MOTORCYCLE',
          hubId: 'dorm',
          mode: 'QUEUE',
          status: 'COMPLETED',
          targetPct: 90,
          startPct: 50,
          currentPct: 90,
          finalPct: 90,
          endedAt: relFromNow(-1 * HOUR_MS),
        },
      ],
    });

    const listRes = await request(app)
      .get('/api/private-evs')
      .set('Authorization', student1Token);

    expect(listRes.status).toBe(200);
    const items = listRes.body as PrivateEvDto[];
    // 10 non-deleted EVs for student1 (EV-DELETED excluded, student2's PEV-02 excluded)
    expect(items).toHaveLength(10);
    expect(items.map((x) => x.id)).toEqual([
      'EV-PR-CONF',
      'EV-PR-ACT',
      'EV-PR-CANC',
      'EV-PR-EXP',
      'EV-PR-COMP',
      'EV-CR-QUEUED',
      'EV-CR-SCHED',
      'EV-CR-CHRG',
      'EV-CR-CANC',
      'EV-CR-COMP',
    ]);

    const byId = new Map(items.map((x) => [x.id, x.hasActiveBooking]));
    expect(byId.get('EV-PR-CONF')).toBe(true);
    expect(byId.get('EV-PR-ACT')).toBe(true);
    expect(byId.get('EV-PR-CANC')).toBe(false);
    expect(byId.get('EV-PR-EXP')).toBe(false);
    expect(byId.get('EV-PR-COMP')).toBe(false);
    expect(byId.get('EV-CR-QUEUED')).toBe(true);
    expect(byId.get('EV-CR-SCHED')).toBe(true);
    expect(byId.get('EV-CR-CHRG')).toBe(true);
    expect(byId.get('EV-CR-CANC')).toBe(false);
    expect(byId.get('EV-CR-COMP')).toBe(false);
  });

  it('T-14 AC-3 GET /api/private-evs returns consistent PrivateEv[] shape for 0, 1 and several EVs', async () => {
    const reg = await request(app).post('/api/auth/register').send({
      identifier: 'student3_pev',
      password: 'Password123',
      displayName: 'Student Three',
    });
    expect(reg.status).toBe(201);
    const token3 = `Bearer ${(reg.body as { token: string }).token}`;

    // 0 EVs
    const res0 = await request(app).get('/api/private-evs').set('Authorization', token3);
    expect(res0.status).toBe(200);
    expect(res0.body).toEqual([]);

    // 1 EV
    const ev1 = await createEvViaApi(token3, { label: 'Beta' });
    const res1 = await request(app).get('/api/private-evs').set('Authorization', token3);
    expect(res1.status).toBe(200);
    expect(res1.body).toEqual([ev1]);

    // Several EVs (ordered label ASC, id ASC)
    const ev2 = await createEvViaApi(token3, { label: 'Alpha', type: 'CAR', batteryCapacityKwh: 55 });
    const ev3 = await createEvViaApi(token3, { label: 'Gamma' });
    const res3 = await request(app).get('/api/private-evs').set('Authorization', token3);
    expect(res3.status).toBe(200);
    expect(res3.body).toEqual([ev2, ev1, ev3]);
  });

  // ---- AC-4: FR-26 edit ----

  it('FR-26 AC-4 edit rules and type change blocked by an active booking', async () => {
    const ev = await createEvViaApi(student1Token, {
      type: 'E_MOTORCYCLE',
      label: 'Before',
      batteryCapacityKwh: 4,
      batteryPct: 40,
    });

    // Edit non-type fields with no active booking
    const editRes = await request(app)
      .patch(`/api/private-evs/${ev.id}`)
      .set('Authorization', student1Token)
      .send({ label: '  After  ', batteryCapacityKwh: 6.5, batteryPct: 85 });
    expect(editRes.status).toBe(200);
    expect(editRes.body).toEqual({
      id: ev.id,
      type: 'E_MOTORCYCLE',
      vehicleClass: 'MOTORCYCLE',
      label: 'After',
      batteryCapacityKwh: 6.5,
      batteryPct: 85,
      hasActiveBooking: false,
    });

    // Change type with no active booking -> vehicleClass follows
    const typeRes = await request(app)
      .patch(`/api/private-evs/${ev.id}`)
      .set('Authorization', student1Token)
      .send({ type: 'CAR' });
    expect(typeRes.status).toBe(200);
    expect((typeRes.body as PrivateEvDto).type).toBe('CAR');
    expect((typeRes.body as PrivateEvDto).vehicleClass).toBe('CAR');

    // Empty body and unknown-only body -> 400 details.field 'body'
    for (const badBody of [{}, { unknownField: 123 }]) {
      const emptyRes = await request(app)
        .patch(`/api/private-evs/${ev.id}`)
        .set('Authorization', student1Token)
        .send(badBody);
      expect(emptyRes.status).toBe(400);
      expect((emptyRes.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
      expect((emptyRes.body as ErrorBody).error.details?.field).toBe('body');
    }

    // { label: null } -> 400 details.field 'label'
    const nullLabelRes = await request(app)
      .patch(`/api/private-evs/${ev.id}`)
      .set('Authorization', student1Token)
      .send({ label: null });
    expect(nullLabelRes.status).toBe(400);
    expect((nullLabelRes.body as ErrorBody).error.code).toBe('VALIDATION_ERROR');
    expect((nullLabelRes.body as ErrorBody).error.details?.field).toBe('label');

    // Create an active parking reservation via reserveParking
    await reserveParking('student1', {
      hubId: 'dorm',
      vehicleClass: 'CAR',
      privateEvId: ev.id,
      windowStart: relFromNow(1 * HOUR_MS),
      windowEnd: relFromNow(2 * HOUR_MS),
    });

    // Changing type with active parking reservation -> 409 HAS_ACTIVE_BOOKING, unchanged
    const blockedTypeRes = await request(app)
      .patch(`/api/private-evs/${ev.id}`)
      .set('Authorization', student1Token)
      .send({ type: 'E_MOTORCYCLE' });
    expect(blockedTypeRes.status).toBe(409);
    const blockedErr = blockedTypeRes.body as ErrorBody;
    expect(blockedErr.error.code).toBe('HAS_ACTIVE_BOOKING');
    expect(blockedErr.error.nextActions.length).toBeGreaterThanOrEqual(1);

    const dbRowAfterBlock = await db.privateEv.findUniqueOrThrow({ where: { id: ev.id } });
    expect(dbRowAfterBlock.type).toBe('CAR');
    expect(dbRowAfterBlock.vehicleClass).toBe('CAR');

    // Changing type with active charging request (PEV-01 has CR-C-001 CHARGING) -> 409
    const blockedChargeRes = await request(app)
      .patch('/api/private-evs/PEV-01')
      .set('Authorization', student1Token)
      .send({ type: 'E_MOTORCYCLE' });
    expect(blockedChargeRes.status).toBe(409);
    expect((blockedChargeRes.body as ErrorBody).error.code).toBe('HAS_ACTIVE_BOOKING');

    // Re-sending the SAME type with an active booking -> 200
    const sameTypeRes = await request(app)
      .patch(`/api/private-evs/${ev.id}`)
      .set('Authorization', student1Token)
      .send({ type: 'CAR', label: 'Same Type OK' });
    expect(sameTypeRes.status).toBe(200);
    expect((sameTypeRes.body as PrivateEvDto).label).toBe('Same Type OK');
    expect((sameTypeRes.body as PrivateEvDto).hasActiveBooking).toBe(true);
  });

  // ---- AC-5: FR-27 soft delete ----

  it('FR-27 AC-5 soft delete rules', async () => {
    const ev = await createEvViaApi(student1Token, { type: 'E_MOTORCYCLE', label: 'To Remove' });

    // Remove with no active booking -> 204
    const delRes = await request(app)
      .delete(`/api/private-evs/${ev.id}`)
      .set('Authorization', student1Token);
    expect(delRes.status).toBe(204);
    expect(delRes.text).toBe('');

    // Gone from list, deletedAt set in DB
    const listRes = await request(app)
      .get('/api/private-evs')
      .set('Authorization', student1Token);
    expect(listRes.status).toBe(200);
    expect((listRes.body as PrivateEvDto[]).map((x) => x.id)).not.toContain(ev.id);

    const deletedRow = await db.privateEv.findUniqueOrThrow({ where: { id: ev.id } });
    expect(deletedRow.deletedAt).not.toBeNull();

    // reserveParking via POST /api/parking-reservations with removed EV -> 404
    const parkRes = await request(app)
      .post('/api/parking-reservations')
      .set('Authorization', student1Token)
      .send({
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        privateEvId: ev.id,
        windowStart: relFromNow(1 * HOUR_MS).toISOString(),
        windowEnd: relFromNow(2 * HOUR_MS).toISOString(),
      });
    expect(parkRes.status).toBe(404);

    // Second DELETE -> 404, PATCH -> 404
    const del2 = await request(app)
      .delete(`/api/private-evs/${ev.id}`)
      .set('Authorization', student1Token);
    expect(del2.status).toBe(404);

    const patchDeleted = await request(app)
      .patch(`/api/private-evs/${ev.id}`)
      .set('Authorization', student1Token)
      .send({ label: 'Ghost' });
    expect(patchDeleted.status).toBe(404);

    // Remove with active charging request (PEV-01) -> 409 HAS_ACTIVE_BOOKING, still listed
    const delCharging = await request(app)
      .delete('/api/private-evs/PEV-01')
      .set('Authorization', student1Token);
    expect(delCharging.status).toBe(409);
    expect((delCharging.body as ErrorBody).error.code).toBe('HAS_ACTIVE_BOOKING');

    // Remove with active parking reservation -> 409 HAS_ACTIVE_BOOKING, still listed
    const evParked = await createEvViaApi(student1Token, { type: 'CAR', label: 'Parked EV' });
    await reserveParking('student1', {
      hubId: 'dorm',
      vehicleClass: 'CAR',
      privateEvId: evParked.id,
      windowStart: relFromNow(1 * HOUR_MS),
      windowEnd: relFromNow(2 * HOUR_MS),
    });

    const delParked = await request(app)
      .delete(`/api/private-evs/${evParked.id}`)
      .set('Authorization', student1Token);
    expect(delParked.status).toBe(409);
    expect((delParked.body as ErrorBody).error.code).toBe('HAS_ACTIVE_BOOKING');

    const listAfter = await request(app)
      .get('/api/private-evs')
      .set('Authorization', student1Token);
    const idsAfter = (listAfter.body as PrivateEvDto[]).map((x) => x.id);
    expect(idsAfter).toContain('PEV-01');
    expect(idsAfter).toContain(evParked.id);
  });

  // ---- AC-6: Rule 7 race ----

  it('FR-26 AC-6 type change racing a parking reservation never leaves a class mismatch', async () => {
    const ROUNDS = 10;

    for (let i = 0; i < ROUNDS; i += 1) {
      await resetDb();
      const ev = await createEvViaApi(student1Token, {
        type: 'E_MOTORCYCLE',
        label: `Race EV ${i}`,
      });

      const windowStart = relFromNow(1 * HOUR_MS).toISOString();
      const windowEnd = relFromNow(2 * HOUR_MS).toISOString();

      const [patchRes, parkRes] = await Promise.all([
        request(app)
          .patch(`/api/private-evs/${ev.id}`)
          .set('Authorization', student1Token)
          .send({ type: 'CAR' }),
        request(app)
          .post('/api/parking-reservations')
          .set('Authorization', student1Token)
          .send({
            hubId: 'dorm',
            vehicleClass: 'MOTORCYCLE',
            privateEvId: ev.id,
            windowStart,
            windowEnd,
          }),
      ]);

      const pairOk =
        (parkRes.status === 201 &&
          patchRes.status === 409 &&
          (patchRes.body as ErrorBody).error.code === 'HAS_ACTIVE_BOOKING') ||
        (patchRes.status === 200 &&
          parkRes.status === 409 &&
          (parkRes.body as ErrorBody).error.code === 'CLASS_MISMATCH');

      expect(
        pairOk,
        `Round ${i}: unexpected statuses patch=${patchRes.status} (${JSON.stringify(patchRes.body)}), park=${parkRes.status} (${JSON.stringify(parkRes.body)})`,
      ).toBe(true);

      const finalEv = await db.privateEv.findUniqueOrThrow({ where: { id: ev.id } });
      const confirmedReservations = await db.parkingReservation.findMany({
        where: { privateEvId: ev.id, status: 'CONFIRMED' },
      });

      for (const r of confirmedReservations) {
        expect(r.vehicleClass).toBe(finalEv.vehicleClass);
      }
    }
  });

  // ---- AC-7: Ownership, 403, 401 ----

  it('FR-61 AC-7 ownership, 403, 401', async () => {
    // 401 without token or with bad token
    for (const authHeader of [undefined, 'Bearer invalid.jwt.token']) {
      const reqs = [
        request(app).get('/api/private-evs'),
        request(app)
          .post('/api/private-evs')
          .send({ type: 'CAR', label: 'NoAuth', batteryCapacityKwh: 50, batteryPct: 50 }),
        request(app).patch('/api/private-evs/PEV-01').send({ label: 'NoAuth' }),
        request(app).delete('/api/private-evs/PEV-01'),
      ];
      for (const req of reqs) {
        if (authHeader) req.set('Authorization', authHeader);
        const res = await req;
        expect(res.status).toBe(401);
        expect((res.body as ErrorBody).error.code).toBe('UNAUTHENTICATED');
      }
    }

    // 403 for OPERATOR on all private-ev endpoints
    const opGet = await request(app).get('/api/private-evs').set('Authorization', operator1Token);
    expect(opGet.status).toBe(403);
    expect((opGet.body as ErrorBody).error.code).toBe('FORBIDDEN');

    const opPost = await request(app)
      .post('/api/private-evs')
      .set('Authorization', operator1Token)
      .send({ type: 'CAR', label: 'OpCar', batteryCapacityKwh: 50, batteryPct: 50 });
    expect(opPost.status).toBe(403);
    expect((opPost.body as ErrorBody).error.code).toBe('FORBIDDEN');

    const opPatch = await request(app)
      .patch('/api/private-evs/PEV-01')
      .set('Authorization', operator1Token)
      .send({ label: 'OpEdit' });
    expect(opPatch.status).toBe(403);
    expect((opPatch.body as ErrorBody).error.code).toBe('FORBIDDEN');

    const opDelete = await request(app)
      .delete('/api/private-evs/PEV-01')
      .set('Authorization', operator1Token);
    expect(opDelete.status).toBe(403);
    expect((opDelete.body as ErrorBody).error.code).toBe('FORBIDDEN');

    // Ownership: student2's PEV-02 is absent from student1's list; student2 sees only PEV-02; PATCH/DELETE return 404 identical to unknown id
    const list1 = await request(app).get('/api/private-evs').set('Authorization', student1Token);
    expect(list1.status).toBe(200);
    expect((list1.body as PrivateEvDto[]).map((x) => x.id)).not.toContain('PEV-02');

    const list2 = await request(app).get('/api/private-evs').set('Authorization', student2Token);
    expect(list2.status).toBe(200);
    expect((list2.body as PrivateEvDto[]).map((x) => x.id)).toEqual(['PEV-02']);

    const patchOther = await request(app)
      .patch('/api/private-evs/PEV-02')
      .set('Authorization', student1Token)
      .send({ label: 'Hijack' });
    const patchUnknown = await request(app)
      .patch('/api/private-evs/DOES_NOT_EXIST')
      .set('Authorization', student1Token)
      .send({ label: 'Missing' });
    expect(patchOther.status).toBe(404);
    expect(patchUnknown.status).toBe(404);
    expect(patchOther.body).toEqual(patchUnknown.body);

    const delOther = await request(app)
      .delete('/api/private-evs/PEV-02')
      .set('Authorization', student1Token);
    const delUnknown = await request(app)
      .delete('/api/private-evs/DOES_NOT_EXIST')
      .set('Authorization', student1Token);
    expect(delOther.status).toBe(404);
    expect(delUnknown.status).toBe(404);
    expect(delOther.body).toEqual(delUnknown.body);

    const patchOther2 = await request(app)
      .patch('/api/private-evs/PEV-01')
      .set('Authorization', student2Token)
      .send({ label: 'Hijack2' });
    expect(patchOther2.status).toBe(404);
    expect(patchOther2.body).toEqual(patchUnknown.body);
  });
});
