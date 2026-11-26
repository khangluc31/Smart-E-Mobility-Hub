// Database consistency invariant checker (T-33, NFR-09 / NFR-27).
// Usage: npm run check-consistency -w backend
// Runs 5 read-only Postgres invariant checks via Prisma, prints PASS/FAIL, and exits 1 on failure.

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

interface InvariantResult {
  name: string;
  passed: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const results: InvariantResult[] = [];

  try {
    // 1. Every rental_vehicle with parkingSpaceId != null references a FLEET space at the same hubId
    //    with status = 'OCCUPIED', and no two vehicles share a parkingSpaceId.
    const parkedVehicles = await prisma.rentalVehicle.findMany({
      where: { parkingSpaceId: { not: null } },
      select: {
        id: true,
        hubId: true,
        parkingSpaceId: true,
        parkingSpace: {
          select: { id: true, hubId: true, pool: true, status: true },
        },
      },
    });
    const badParked: string[] = [];
    const seenSpaces = new Set<string>();
    const dupSpaces: string[] = [];
    for (const v of parkedVehicles) {
      const spaceId = v.parkingSpaceId;
      if (!spaceId) continue;
      if (seenSpaces.has(spaceId)) dupSpaces.push(spaceId);
      seenSpaces.add(spaceId);
      const sp = v.parkingSpace;
      if (!sp || sp.pool !== 'FLEET' || sp.hubId !== v.hubId || sp.status !== 'OCCUPIED') {
        badParked.push(
          `${v.id}(hub=${v.hubId},space=${spaceId},pool=${sp?.pool ?? 'missing'},spaceHub=${sp?.hubId ?? 'missing'},status=${sp?.status ?? 'missing'})`,
        );
      }
    }
    results.push({
      name: '1. Parked rental vehicles -> unique OCCUPIED FLEET spaces at same Hub',
      passed: badParked.length === 0 && dupSpaces.length === 0,
      detail: `checked=${parkedVehicles.length} invalid=${badParked.length} duplicates=${dupSpaces.length}`,
    });

    // 2. Every CONFIRMED/ACTIVE vehicle_reservation points to a vehicle in RESERVED/IN_USE status
    //    respectively, and no user has > 1 CONFIRMED/ACTIVE vehicle reservation.
    const openVehicleRes = await prisma.vehicleReservation.findMany({
      where: { status: { in: ['CONFIRMED', 'ACTIVE'] } },
      select: {
        id: true,
        userId: true,
        status: true,
        rentalVehicleId: true,
        rentalVehicle: { select: { status: true } },
      },
    });
    const badResStatus: string[] = [];
    const perUserCount = new Map<string, number>();
    for (const r of openVehicleRes) {
      const expected = r.status === 'CONFIRMED' ? 'RESERVED' : 'IN_USE';
      if (r.rentalVehicle.status !== expected) {
        badResStatus.push(`${r.id}(${r.status}->${r.rentalVehicle.status})`);
      }
      perUserCount.set(r.userId, (perUserCount.get(r.userId) ?? 0) + 1);
    }
    const multiUsers = Array.from(perUserCount.entries()).filter(([, c]) => c > 1);
    results.push({
      name: '2. Open vehicle reservations match vehicle status & <= 1 per user (BR-01)',
      passed: badResStatus.length === 0 && multiUsers.length === 0,
      detail: `open=${openVehicleRes.length} mismatched=${badResStatus.length} multiUserViolations=${multiUsers.length}`,
    });

    // 3. Every CHARGING charging_request has a non-null chargingPointId whose point has
    //    status = 'CHARGING', and every CHARGING point has a matching CHARGING request.
    const [activeChargingReqs, activeChargingPoints] = await Promise.all([
      prisma.chargingRequest.findMany({
        where: { status: 'CHARGING' },
        select: {
          id: true,
          chargingPointId: true,
          chargingPoint: { select: { id: true, status: true } },
        },
      }),
      prisma.chargingPoint.findMany({
        where: { status: 'CHARGING' },
        select: { id: true },
      }),
    ]);
    const badChargingReqs = activeChargingReqs.filter(
      (req) => !req.chargingPointId || req.chargingPoint?.status !== 'CHARGING',
    );
    const reqPointIds = new Set(
      activeChargingReqs
        .map((req) => req.chargingPointId)
        .filter((id): id is string => typeof id === 'string'),
    );
    const orphanChargingPoints = activeChargingPoints.filter((pt) => !reqPointIds.has(pt.id));
    results.push({
      name: '3. CHARGING requests <-> CHARGING points 1:1 consistency',
      passed: badChargingReqs.length === 0 && orphanChargingPoints.length === 0,
      detail: `activeReqs=${activeChargingReqs.length} activePoints=${activeChargingPoints.length} badReqs=${badChargingReqs.length} orphanPoints=${orphanChargingPoints.length}`,
    });

    // 4. Zero duplicate dedupeKey across OPEN/ACKNOWLEDGED alerts, and zero duplicate
    //    (resourceType, resourceId) across non-RESOLVED incidents.
    const [openAlerts, openIncidents] = await Promise.all([
      prisma.alert.findMany({
        where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        select: { id: true, dedupeKey: true },
      }),
      prisma.incident.findMany({
        where: { status: { not: 'RESOLVED' } },
        select: { id: true, resourceType: true, resourceId: true },
      }),
    ]);
    const alertKeys = new Set<string>();
    let dupAlerts = 0;
    for (const a of openAlerts) {
      if (alertKeys.has(a.dedupeKey)) dupAlerts += 1;
      alertKeys.add(a.dedupeKey);
    }
    const incidentKeys = new Set<string>();
    let dupIncidents = 0;
    for (const inc of openIncidents) {
      const k = `${inc.resourceType}:${inc.resourceId}`;
      if (incidentKeys.has(k)) dupIncidents += 1;
      incidentKeys.add(k);
    }
    results.push({
      name: '4. Zero duplicate open/acknowledged alerts & open incidents',
      passed: dupAlerts === 0 && dupIncidents === 0,
      detail: `openAlerts=${openAlerts.length} dupAlerts=${dupAlerts} openIncidents=${openIncidents.length} dupIncidents=${dupIncidents}`,
    });

    // 5. Append-only trigger audit_log_no_update exists on audit_log in pg_trigger.
    const triggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
      SELECT t.tgname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'audit_log'
        AND t.tgname = 'audit_log_no_update'
        AND NOT t.tgisinternal
    `;
    results.push({
      name: '5. Append-only trigger audit_log_no_update exists on audit_log',
      passed: triggers.length === 1,
      detail: triggers.length === 1 ? 'trigger present' : `found=${triggers.length}`,
    });
  } finally {
    await prisma.$disconnect();
  }

  let failed = 0;
  for (const r of results) {
    console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
    if (!r.passed) failed += 1;
  }

  if (failed > 0) {
    console.error(`Consistency check failed: ${failed}/${results.length} invariants failed.`);
    process.exit(1);
  }

  console.log(`Consistency check passed: ${results.length}/${results.length} invariants passed.`);
}

main().catch((err: unknown) => {
  console.error('FAIL  check-consistency crashed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
