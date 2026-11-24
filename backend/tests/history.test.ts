import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { db } from '../src/core/db';
import { config } from '../src/core/config';
import { RESERVATION_STATUSES } from '../src/types/enums';
import type { HistoryItem, HistoryPage } from '../src/types/reservations';
import { createTestApp, resetDb, loginAs } from './helpers';

const app = createTestApp();

function isoAt(baseMs: number, offsetSec: number): Date {
  return new Date(baseMs + offsetSec * 1_000);
}

function compareDesc(
  a: { at: string; item: { id: string } },
  b: { at: string; item: { id: string } },
): number {
  const timeDiff = Date.parse(b.at) - Date.parse(a.at);
  if (timeDiff !== 0) return timeDiff;
  if (b.item.id > a.item.id) return 1;
  if (b.item.id < a.item.id) return -1;
  return 0;
}

async function clearReservations(): Promise<void> {
  await db.vehicleReservation.deleteMany();
  await db.parkingReservation.deleteMany();
  await db.chargingRequest.deleteMany({ where: { ownerId: { not: null } } });
}

describe('T-15 GET /api/me/history', () => {
  let student1Token: string;
  let student2Token: string;
  let operatorToken: string;

  beforeEach(async () => {
    await resetDb();
    await clearReservations();
    student1Token = loginAs('student1');
    student2Token = loginAs('student2');
    operatorToken = loginAs('operator1');
  });

  it("FR-10 AC-1 history returns only the caller's rows, newest first, with full DTOs", async () => {
    const baseMs = Date.now() - 3_600_000;

    // Seed rows across statuses for student1 (max one CONFIRMED/ACTIVE vehicleReservation per user)
    // and rows for student2 that must never appear.
    const vCompletedCharging = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-M-004', // has CHARGING request CR-M-001 -> charging: true
        hubId: 'metro',
        status: 'COMPLETED',
        createdAt: isoAt(baseMs, 10),
        expiresAt: isoAt(baseMs, 910),
        pickedUpAt: isoAt(baseMs, 60),
        returnedAt: isoAt(baseMs, 300),
        returnHubId: 'dorm',
        startBatteryPct: 55,
        endBatteryPct: 50,
        endReason: 'RETURNED',
      },
    });

    const pCancelled = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'MET-P-M-01',
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        privateEvId: 'PEV-03',
        windowStart: isoAt(baseMs, 1_000),
        windowEnd: isoAt(baseMs, 4_600),
        status: 'CANCELLED',
        expiresAt: isoAt(baseMs, 1_900),
        createdAt: isoAt(baseMs, 20),
      },
    });

    const vExpired = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-M-005', // has QUEUED request CR-M-002 -> charging: false (D-18)
        hubId: 'metro',
        status: 'EXPIRED',
        createdAt: isoAt(baseMs, 30),
        expiresAt: isoAt(baseMs, 930),
        endReason: 'EXPIRED',
      },
    });

    const pExpired = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'DOR-P-C-01',
        hubId: 'dorm',
        vehicleClass: 'CAR',
        privateEvId: 'PEV-01',
        windowStart: isoAt(baseMs, 2_000),
        windowEnd: isoAt(baseMs, 5_600),
        status: 'EXPIRED',
        expiresAt: isoAt(baseMs, 2_900),
        bookingGroupId: 'bg-001',
        createdAt: isoAt(baseMs, 40),
      },
    });

    const vCancelled = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-D-001',
        hubId: 'dorm',
        status: 'CANCELLED',
        createdAt: isoAt(baseMs, 50),
        expiresAt: isoAt(baseMs, 950),
        endReason: 'CANCELLED',
      },
    });

    const pCompleted = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'CPA-P-M-01',
        hubId: 'campus-a',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 3_000),
        windowEnd: isoAt(baseMs, 6_600),
        status: 'COMPLETED',
        claimedAt: isoAt(baseMs, 3_060),
        expiresAt: isoAt(baseMs, 3_900),
        createdAt: isoAt(baseMs, 60),
      },
    });

    const vConfirmed = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-M-001',
        hubId: 'metro',
        status: 'CONFIRMED',
        createdAt: isoAt(baseMs, 70),
        expiresAt: isoAt(baseMs, 970),
      },
    });

    const pActive = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'CPB-P-C-01',
        hubId: 'campus-b',
        vehicleClass: 'CAR',
        privateEvId: 'PEV-01',
        windowStart: isoAt(baseMs, 4_000),
        windowEnd: isoAt(baseMs, 7_600),
        status: 'ACTIVE',
        claimedAt: isoAt(baseMs, 4_050),
        expiresAt: isoAt(baseMs, 4_900),
        createdAt: isoAt(baseMs, 80),
      },
    });

    // Other student's rows
    const otherV = await db.vehicleReservation.create({
      data: {
        userId: 'student2',
        rentalVehicleId: 'RV-A-001',
        hubId: 'campus-a',
        status: 'COMPLETED',
        createdAt: isoAt(baseMs, 90),
        expiresAt: isoAt(baseMs, 990),
      },
    });

    const otherP = await db.parkingReservation.create({
      data: {
        userId: 'student2',
        parkingSpaceId: 'DOR-P-M-01',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        privateEvId: 'PEV-02',
        windowStart: isoAt(baseMs, 5_000),
        windowEnd: isoAt(baseMs, 8_600),
        status: 'CONFIRMED',
        expiresAt: isoAt(baseMs, 5_900),
        createdAt: isoAt(baseMs, 100),
      },
    });

    const res = await request(app)
      .get('/api/me/history')
      .set('Authorization', student1Token);

    expect(res.status).toBe(200);
    const body = res.body as HistoryPage;
    expect(body.nextCursor).toBeNull();
    expect(body.items).toHaveLength(8);

    // Must never contain student2's records
    const returnedIds = body.items.map((entry) => entry.item.id);
    expect(returnedIds).not.toContain(otherV.id);
    expect(returnedIds).not.toContain(otherP.id);

    // Order: newest first by createdAt
    expect(returnedIds).toEqual([
      pActive.id,
      vConfirmed.id,
      pCompleted.id,
      vCancelled.id,
      pExpired.id,
      vExpired.id,
      pCancelled.id,
      vCompletedCharging.id,
    ]);

    // Check full ParkingReservation DTO shape (newest item: pActive)
    const first = body.items[0]!;
    expect(first.kind).toBe('parking');
    expect(first.at).toBe(pActive.createdAt.toISOString());
    if (first.kind === 'parking') {
      expect(first.item).toMatchObject({
        id: pActive.id,
        status: 'ACTIVE',
        hubId: 'campus-b',
        parkingSpaceId: 'CPB-P-C-01',
        vehicleClass: 'CAR',
        privateEvId: 'PEV-01',
        windowStart: pActive.windowStart.toISOString(),
        windowEnd: pActive.windowEnd.toISOString(),
        expiresAt: pActive.expiresAt.toISOString(),
        claimedAt: pActive.claimedAt!.toISOString(),
        bookingGroupId: null,
      });
      expect(typeof first.item.serverNow).toBe('string');
      expect(Number.isNaN(Date.parse(first.item.serverNow))).toBe(false);
      // No unexpected extra userId field leaked if DTO matches CONTRACTS §1
      expect(Object.keys(first.item).sort()).toEqual(
        [
          'bookingGroupId',
          'claimedAt',
          'expiresAt',
          'hubId',
          'id',
          'parkingSpaceId',
          'privateEvId',
          'serverNow',
          'status',
          'vehicleClass',
          'windowEnd',
          'windowStart',
        ].sort(),
      );
    }

    // Check full VehicleReservation DTO shape (vCompletedCharging — last item)
    const last = body.items[7]!;
    expect(last.kind).toBe('vehicle');
    expect(last.at).toBe(vCompletedCharging.createdAt.toISOString());
    if (last.kind === 'vehicle') {
      expect(last.item).toMatchObject({
        id: vCompletedCharging.id,
        status: 'COMPLETED',
        hubId: 'metro',
        createdAt: vCompletedCharging.createdAt.toISOString(),
        expiresAt: vCompletedCharging.expiresAt.toISOString(),
        pickedUpAt: vCompletedCharging.pickedUpAt!.toISOString(),
        returnedAt: vCompletedCharging.returnedAt!.toISOString(),
        returnHubId: 'dorm',
        startBatteryPct: 55,
        endBatteryPct: 50,
        endReason: 'RETURNED',
        vehicle: {
          id: 'RV-M-004',
          hubId: 'metro',
          type: 'E_MOTORCYCLE',
          vehicleClass: 'MOTORCYCLE',
          status: 'AVAILABLE',
          batteryPct: 50,
          charging: true,
        },
      });
      expect(typeof last.item.serverNow).toBe('string');
      expect(Number.isNaN(Date.parse(last.item.serverNow))).toBe(false);
      expect(Object.keys(last.item).sort()).toEqual(
        [
          'createdAt',
          'endBatteryPct',
          'endReason',
          'expiresAt',
          'hubId',
          'id',
          'pickedUpAt',
          'returnHubId',
          'returnedAt',
          'serverNow',
          'startBatteryPct',
          'status',
          'vehicle',
        ].sort(),
      );
    }

    // Check D-18 charging flag is false when vehicle is only QUEUED (RV-M-005)
    const vExpiredEntry = body.items.find((entry) => entry.item.id === vExpired.id);
    expect(vExpiredEntry?.kind).toBe('vehicle');
    if (vExpiredEntry?.kind === 'vehicle') {
      expect(vExpiredEntry.item.vehicle.charging).toBe(false);
    }

    // Passing ?userId=student2 must be ignored (UC-07 E1)
    const spoofRes = await request(app)
      .get('/api/me/history?userId=student2')
      .set('Authorization', student1Token);
    expect(spoofRes.status).toBe(200);
    const spoofBody = spoofRes.body as HistoryPage;
    expect(spoofBody.items.map((e) => e.item.id)).toEqual(returnedIds);

    // Calling as student2 returns only student2's rows
    const s2Res = await request(app)
      .get('/api/me/history?userId=student1')
      .set('Authorization', student2Token);
    expect(s2Res.status).toBe(200);
    expect((s2Res.body as HistoryPage).items.map((e) => e.item.id)).toEqual([
      otherP.id,
      otherV.id,
    ]);
  });

  it('T-15 AC-1 returns empty page when caller has no history', async () => {
    const res = await request(app)
      .get('/api/me/history')
      .set('Authorization', student1Token);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it('FR-10 AC-2 type filter', async () => {
    const baseMs = Date.now() - 600_000;

    const v1 = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-M-001',
        hubId: 'metro',
        status: 'COMPLETED',
        createdAt: isoAt(baseMs, 10),
        expiresAt: isoAt(baseMs, 910),
      },
    });
    const p1 = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'MET-P-M-01',
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 100),
        windowEnd: isoAt(baseMs, 3_700),
        status: 'COMPLETED',
        expiresAt: isoAt(baseMs, 1_000),
        createdAt: isoAt(baseMs, 20),
      },
    });
    const v2 = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-D-001',
        hubId: 'dorm',
        status: 'CANCELLED',
        createdAt: isoAt(baseMs, 30),
        expiresAt: isoAt(baseMs, 930),
      },
    });

    // type=vehicle
    const vehRes = await request(app)
      .get('/api/me/history?type=vehicle')
      .set('Authorization', student1Token);
    expect(vehRes.status).toBe(200);
    const vehBody = vehRes.body as HistoryPage;
    expect(vehBody.items.every((e) => e.kind === 'vehicle')).toBe(true);
    expect(vehBody.items.map((e) => e.item.id)).toEqual([v2.id, v1.id]);
    expect(vehBody.nextCursor).toBeNull();

    // type=parking
    const prkRes = await request(app)
      .get('/api/me/history?type=parking')
      .set('Authorization', student1Token);
    expect(prkRes.status).toBe(200);
    const prkBody = prkRes.body as HistoryPage;
    expect(prkBody.items.every((e) => e.kind === 'parking')).toBe(true);
    expect(prkBody.items.map((e) => e.item.id)).toEqual([p1.id]);
    expect(prkBody.nextCursor).toBeNull();

    // type=charging
    const chgRes = await request(app)
      .get('/api/me/history?type=charging')
      .set('Authorization', student1Token);
    expect(chgRes.status).toBe(200);
    expect(chgRes.body).toEqual({ items: [], nextCursor: null });

    // type=all and omitted default
    const allRes = await request(app)
      .get('/api/me/history?type=all')
      .set('Authorization', student1Token);
    const defRes = await request(app)
      .get('/api/me/history')
      .set('Authorization', student1Token);
    expect(allRes.status).toBe(200);
    expect(defRes.status).toBe(200);
    expect((allRes.body as HistoryPage).items.map((e) => e.item.id)).toEqual([
      v2.id,
      p1.id,
      v1.id,
    ]);
    expect((defRes.body as HistoryPage).items.map((e) => e.item.id)).toEqual([
      v2.id,
      p1.id,
      v1.id,
    ]);
  });

  it('FR-10 AC-3 status filter', async () => {
    const baseMs = Date.now() - 600_000;

    // Create one vehicle + one parking row for COMPLETED, CANCELLED, EXPIRED, CONFIRMED.
    const vCompleted = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-M-001',
        hubId: 'metro',
        status: 'COMPLETED',
        createdAt: isoAt(baseMs, 10),
        expiresAt: isoAt(baseMs, 910),
      },
    });
    const pCompleted = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'MET-P-M-01',
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 100),
        windowEnd: isoAt(baseMs, 3_700),
        status: 'COMPLETED',
        expiresAt: isoAt(baseMs, 1_000),
        createdAt: isoAt(baseMs, 20),
      },
    });
    const vCancelled = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-M-002',
        hubId: 'metro',
        status: 'CANCELLED',
        createdAt: isoAt(baseMs, 30),
        expiresAt: isoAt(baseMs, 930),
      },
    });
    const pCancelled = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'MET-P-M-02',
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 100),
        windowEnd: isoAt(baseMs, 3_700),
        status: 'CANCELLED',
        expiresAt: isoAt(baseMs, 1_000),
        createdAt: isoAt(baseMs, 40),
      },
    });
    const vExpired = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-D-001',
        hubId: 'dorm',
        status: 'EXPIRED',
        createdAt: isoAt(baseMs, 50),
        expiresAt: isoAt(baseMs, 950),
      },
    });
    const pExpired = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'DOR-P-M-01',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 100),
        windowEnd: isoAt(baseMs, 3_700),
        status: 'EXPIRED',
        expiresAt: isoAt(baseMs, 1_000),
        createdAt: isoAt(baseMs, 60),
      },
    });
    const vLive = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-A-001',
        hubId: 'campus-a',
        status: 'CONFIRMED',
        createdAt: isoAt(baseMs, 70),
        expiresAt: isoAt(baseMs, 970),
      },
    });
    const pConfirmed = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'CPA-P-M-01',
        hubId: 'campus-a',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 100),
        windowEnd: isoAt(baseMs, 3_700),
        status: 'CONFIRMED',
        expiresAt: isoAt(baseMs, 1_000),
        createdAt: isoAt(baseMs, 80),
      },
    });

    const expectedByStatus: Record<string, string[]> = {
      COMPLETED: [pCompleted.id, vCompleted.id],
      CANCELLED: [pCancelled.id, vCancelled.id],
      EXPIRED: [pExpired.id, vExpired.id],
      CONFIRMED: [pConfirmed.id, vLive.id],
      ACTIVE: [],
    };

    for (const status of RESERVATION_STATUSES) {
      const res = await request(app)
        .get(`/api/me/history?status=${status}`)
        .set('Authorization', student1Token);
      expect(res.status).toBe(200);
      const body = res.body as HistoryPage;
      expect(body.items.every((e) => e.item.status === status)).toBe(true);
      expect(body.items.map((e) => e.item.id)).toEqual(expectedByStatus[status]);
    }

    // Now promote the CONFIRMED vehicle + add an ACTIVE parking row to test status=ACTIVE across both kinds
    await db.vehicleReservation.update({
      where: { id: vLive.id },
      data: { status: 'ACTIVE', pickedUpAt: isoAt(baseMs, 75) },
    });
    const pActive = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'CPB-P-M-01',
        hubId: 'campus-b',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 100),
        windowEnd: isoAt(baseMs, 3_700),
        status: 'ACTIVE',
        claimedAt: isoAt(baseMs, 110),
        expiresAt: isoAt(baseMs, 1_000),
        createdAt: isoAt(baseMs, 90),
      },
    });

    const activeRes = await request(app)
      .get('/api/me/history?status=ACTIVE')
      .set('Authorization', student1Token);
    expect(activeRes.status).toBe(200);
    const activeBody = activeRes.body as HistoryPage;
    expect(activeBody.items.every((e) => e.item.status === 'ACTIVE')).toBe(true);
    expect(activeBody.items.map((e) => e.item.id)).toEqual([pActive.id, vLive.id]);

    // Combined type + status filter
    const comboRes = await request(app)
      .get('/api/me/history?type=parking&status=COMPLETED')
      .set('Authorization', student1Token);
    expect(comboRes.status).toBe(200);
    expect((comboRes.body as HistoryPage).items.map((e) => e.item.id)).toEqual([
      pCompleted.id,
    ]);
  });

  it('FR-10 AC-4 merged pagination with a createdAt tie across kinds', async () => {
    const baseMs = Date.now() - 1_200_000;

    // 3 vehicle + 3 parking interleaved in time, PLUS 1 vehicle/parking pair with the SAME createdAt
    // placed at a limit=2 page boundary (indices 1 and 2 of 8 items).
    const tieTime = isoAt(baseMs, 70);

    const p1 = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'MET-P-M-01',
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 100),
        windowEnd: isoAt(baseMs, 3_700),
        status: 'COMPLETED',
        expiresAt: isoAt(baseMs, 1_000),
        createdAt: isoAt(baseMs, 10),
      },
    });
    const v1 = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-M-001',
        hubId: 'metro',
        status: 'COMPLETED',
        createdAt: isoAt(baseMs, 20),
        expiresAt: isoAt(baseMs, 920),
      },
    });
    const p2 = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'MET-P-M-02',
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 100),
        windowEnd: isoAt(baseMs, 3_700),
        status: 'CANCELLED',
        expiresAt: isoAt(baseMs, 1_000),
        createdAt: isoAt(baseMs, 30),
      },
    });
    const v2 = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-M-002',
        hubId: 'metro',
        status: 'CANCELLED',
        createdAt: isoAt(baseMs, 40),
        expiresAt: isoAt(baseMs, 940),
      },
    });
    const p3 = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'DOR-P-M-01',
        hubId: 'dorm',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 100),
        windowEnd: isoAt(baseMs, 3_700),
        status: 'EXPIRED',
        expiresAt: isoAt(baseMs, 1_000),
        createdAt: isoAt(baseMs, 50),
      },
    });
    const v3 = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-D-001',
        hubId: 'dorm',
        status: 'EXPIRED',
        createdAt: isoAt(baseMs, 60),
        expiresAt: isoAt(baseMs, 960),
      },
    });

    // Tied pair across vehicle and parking at tieTime
    const vTie = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-A-001',
        hubId: 'campus-a',
        status: 'COMPLETED',
        createdAt: tieTime,
        expiresAt: isoAt(baseMs, 970),
      },
    });
    const pTie = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'CPA-P-M-01',
        hubId: 'campus-a',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 100),
        windowEnd: isoAt(baseMs, 3_700),
        status: 'COMPLETED',
        expiresAt: isoAt(baseMs, 1_000),
        createdAt: tieTime,
      },
    });

    const pTop = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'CPB-P-M-01',
        hubId: 'campus-b',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 100),
        windowEnd: isoAt(baseMs, 3_700),
        status: 'CONFIRMED',
        expiresAt: isoAt(baseMs, 1_000),
        createdAt: isoAt(baseMs, 80),
      },
    });
    // Wait: let's remove pTop or keep 8 items? Let's keep exact 3V + 3P + 1 tie pair = 8 items,
    // and ensure the tie pair sits across a limit=2 boundary by removing pTop and adding vTop? No,
    // with 8 items (p1, v1, p2, v2, p3, v3, vTie, pTie) wait:
    // index 0,1 = tie pair (same page for limit=2). If we instead put tie pair at t=60 (between pTop at 80 and v3/p3...):
    // Let's check: with pTop deleted, wait — we already created pTop! Let's make 1V + 1P interleaved + tie at index 1,2:
    // Let's keep pTop at 80, and delete p1 (so we have 8 items: pTop(80), tiePair(70), v3(60), p3(50), v2(40), p2(30), v1(20) = 3V + 4P? Wait).
    // Cleaner: delete pTop so we have exact 4V + 4P, OR test 6-item (3V+3P) and 8-item (with tie across boundary) cleanly!
    await db.parkingReservation.delete({ where: { id: pTop.id } });

    // Full list baseline
    const fullRes = await request(app)
      .get('/api/me/history')
      .set('Authorization', student1Token);
    expect(fullRes.status).toBe(200);
    const fullBody = fullRes.body as HistoryPage;
    expect(fullBody.nextCursor).toBeNull();
    expect(fullBody.items).toHaveLength(8);

    // Expected order: createdAt DESC, id DESC
    const expectedSorted = [...fullBody.items].sort(compareDesc);
    expect(fullBody.items.map((e) => `${e.kind}:${e.item.id}`)).toEqual(
      expectedSorted.map((e) => `${e.kind}:${e.item.id}`),
    );
    // Verify the tie pair shares identical `at`
    expect(vTie.createdAt.toISOString()).toBe(pTie.createdAt.toISOString());

    // Page through with limit=2 → pages of 2, 2, 2, 2
    const collectedLimit2: HistoryItem[] = [];
    const pageSizes2: number[] = [];
    let cursor2: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const qs = cursor2 ? `?limit=2&cursor=${encodeURIComponent(cursor2)}` : '?limit=2';
      const pageRes = await request(app)
        .get(`/api/me/history${qs}`)
        .set('Authorization', student1Token);
      expect(pageRes.status).toBe(200);
      const page = pageRes.body as HistoryPage;
      pageSizes2.push(page.items.length);
      collectedLimit2.push(...page.items);
      cursor2 = page.nextCursor;
      if (cursor2 === null) break;
    }
    expect(cursor2).toBeNull();
    expect(pageSizes2).toEqual([2, 2, 2, 2]);
    expect(collectedLimit2.map((e) => `${e.kind}:${e.item.id}`)).toEqual(
      fullBody.items.map((e) => `${e.kind}:${e.item.id}`),
    );
    expect(new Set(collectedLimit2.map((e) => `${e.kind}:${e.item.id}`)).size).toBe(8);

    // Page through with limit=1 (forces split between the tied pair across pages 1 & 2)
    const collectedLimit1: HistoryItem[] = [];
    const pageSizes1: number[] = [];
    let cursor1: string | null = null;
    for (let guard = 0; guard < 15; guard++) {
      const qs = cursor1 ? `?limit=1&cursor=${encodeURIComponent(cursor1)}` : '?limit=1';
      const pageRes = await request(app)
        .get(`/api/me/history${qs}`)
        .set('Authorization', student1Token);
      expect(pageRes.status).toBe(200);
      const page = pageRes.body as HistoryPage;
      pageSizes1.push(page.items.length);
      collectedLimit1.push(...page.items);
      cursor1 = page.nextCursor;
      if (cursor1 === null) break;
    }
    expect(cursor1).toBeNull();
    expect(pageSizes1).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(collectedLimit1.map((e) => `${e.kind}:${e.item.id}`)).toEqual(
      fullBody.items.map((e) => `${e.kind}:${e.item.id}`),
    );
    expect(new Set(collectedLimit1.map((e) => `${e.kind}:${e.item.id}`)).size).toBe(8);

    // Verify 3V + 3P strict interleaved subset (pages of 2, 2, 2) by filtering out nothing on a fresh 6-row check:
    await db.vehicleReservation.delete({ where: { id: vTie.id } });
    await db.parkingReservation.delete({ where: { id: pTie.id } });
    const sixPages: number[] = [];
    const sixItems: HistoryItem[] = [];
    let c6: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const qs = c6 ? `?limit=2&cursor=${encodeURIComponent(c6)}` : '?limit=2';
      const pageRes = await request(app)
        .get(`/api/me/history${qs}`)
        .set('Authorization', student1Token);
      expect(pageRes.status).toBe(200);
      const page = pageRes.body as HistoryPage;
      sixPages.push(page.items.length);
      sixItems.push(...page.items);
      c6 = page.nextCursor;
      if (c6 === null) break;
    }
    expect(c6).toBeNull();
    expect(sixPages).toEqual([2, 2, 2]);
    expect(sixItems.map((e) => e.item.id)).toEqual([v3.id, p3.id, v2.id, p2.id, v1.id, p1.id]);

    // Also place a tie pair right across a limit=2 boundary: newest(t=90), tieA(t=70), tieB(t=70), oldest(t=50)
    await clearReservations();
    const newest = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'MET-P-M-01',
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 100),
        windowEnd: isoAt(baseMs, 3_700),
        status: 'COMPLETED',
        expiresAt: isoAt(baseMs, 1_000),
        createdAt: isoAt(baseMs, 90),
      },
    });
    const tieVBoundary = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-M-001',
        hubId: 'metro',
        status: 'COMPLETED',
        createdAt: tieTime,
        expiresAt: isoAt(baseMs, 970),
      },
    });
    const tiePBoundary = await db.parkingReservation.create({
      data: {
        userId: 'student1',
        parkingSpaceId: 'MET-P-M-02',
        hubId: 'metro',
        vehicleClass: 'MOTORCYCLE',
        windowStart: isoAt(baseMs, 100),
        windowEnd: isoAt(baseMs, 3_700),
        status: 'COMPLETED',
        expiresAt: isoAt(baseMs, 1_000),
        createdAt: tieTime,
      },
    });
    const oldest = await db.vehicleReservation.create({
      data: {
        userId: 'student1',
        rentalVehicleId: 'RV-M-002',
        hubId: 'metro',
        status: 'COMPLETED',
        createdAt: isoAt(baseMs, 50),
        expiresAt: isoAt(baseMs, 950),
      },
    });

    const pBoundary1 = await request(app)
      .get('/api/me/history?limit=2')
      .set('Authorization', student1Token);
    expect(pBoundary1.status).toBe(200);
    const b1 = pBoundary1.body as HistoryPage;
    expect(b1.items).toHaveLength(2);
    expect(b1.items[0]!.item.id).toBe(newest.id);
    expect(b1.nextCursor).not.toBeNull();

    const pBoundary2 = await request(app)
      .get(`/api/me/history?limit=2&cursor=${encodeURIComponent(b1.nextCursor!)}`)
      .set('Authorization', student1Token);
    expect(pBoundary2.status).toBe(200);
    const b2 = pBoundary2.body as HistoryPage;
    expect(b2.items).toHaveLength(2);
    expect(b2.items[1]!.item.id).toBe(oldest.id);
    expect(b2.nextCursor).toBeNull();

    const combinedBoundary = [...b1.items, ...b2.items];
    expect(combinedBoundary.map((e) => e.item.id)).toEqual(
      [...combinedBoundary].sort(compareDesc).map((e) => e.item.id),
    );
    expect(new Set(combinedBoundary.map((e) => e.item.id))).toEqual(
      new Set([newest.id, tieVBoundary.id, tiePBoundary.id, oldest.id]),
    );
  });

  it('T-15 AC-4 respects LIST_LIMIT_DEFAULT and LIST_LIMIT_MAX boundaries', async () => {
    const baseMs = Date.now() - 600_000;
    const total = config.LIST_LIMIT_DEFAULT + 1;
    await db.vehicleReservation.createMany({
      data: Array.from({ length: total }, (_, idx) => ({
        userId: 'student1',
        rentalVehicleId: 'RV-M-001',
        hubId: 'metro',
        status: 'COMPLETED' as const,
        createdAt: isoAt(baseMs, idx + 1),
        expiresAt: isoAt(baseMs, idx + 901),
      })),
    });

    const page1Res = await request(app)
      .get('/api/me/history')
      .set('Authorization', student1Token);
    expect(page1Res.status).toBe(200);
    const page1 = page1Res.body as HistoryPage;
    expect(page1.items).toHaveLength(config.LIST_LIMIT_DEFAULT);
    expect(page1.nextCursor).not.toBeNull();

    const page2Res = await request(app)
      .get(`/api/me/history?cursor=${encodeURIComponent(page1.nextCursor!)}`)
      .set('Authorization', student1Token);
    expect(page2Res.status).toBe(200);
    const page2 = page2Res.body as HistoryPage;
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const maxRes = await request(app)
      .get(`/api/me/history?limit=${config.LIST_LIMIT_MAX}`)
      .set('Authorization', student1Token);
    expect(maxRes.status).toBe(200);
    const maxBody = maxRes.body as HistoryPage;
    expect(maxBody.items).toHaveLength(total);
    expect(maxBody.nextCursor).toBeNull();
  });

  it('FR-10 AC-5 validation', async () => {
    const cases: Array<{ query: string; field: string }> = [
      { query: 'type=bus', field: 'type' },
      { query: 'status=DONE', field: 'status' },
      { query: 'limit=0', field: 'limit' },
      { query: `limit=${config.LIST_LIMIT_MAX + 1}`, field: 'limit' },
      { query: 'limit=-1', field: 'limit' },
      { query: 'limit=abc', field: 'limit' },
      { query: 'cursor=not-valid!', field: 'cursor' },
      { query: 'cursor=e30', field: 'cursor' },
      { query: 'cursor=', field: 'cursor' },
    ];

    for (const c of cases) {
      const res = await request(app)
        .get(`/api/me/history?${c.query}`)
        .set('Authorization', student1Token);
      expect(res.status, `expected 400 for ?${c.query}`).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(typeof res.body.error.message).toBe('string');
      expect(Array.isArray(res.body.error.nextActions)).toBe(true);
      expect(res.body.error.nextActions.length).toBeGreaterThanOrEqual(1);
      expect(res.body.error.details?.field).toBe(c.field);
    }
  });

  it('FR-61 AC-6 operator gets 403', async () => {
    const res = await request(app)
      .get('/api/me/history')
      .set('Authorization', operatorToken);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('FR-61 AC-6 unauthenticated request gets 401', async () => {
    const noAuth = await request(app).get('/api/me/history');
    expect(noAuth.status).toBe(401);

    const badAuth = await request(app)
      .get('/api/me/history')
      .set('Authorization', 'Bearer invalid.token.here');
    expect(badAuth.status).toBe(401);
  });
});
