// Pure demand profile for the What-if Simulation Engine (ARCHITECTURE §12.3).
// Data + pure helpers only — zero Prisma or DB imports.

export interface HubDemandRates {
  rentalPerHour: number;
  parkingPerHour: number;
  chargingPerHour: number;
}

const BASE_RATES_BY_HUB: Record<string, HubDemandRates> = {
  metro: { rentalPerHour: 10, parkingPerHour: 4, chargingPerHour: 4 },
  dorm: { rentalPerHour: 6, parkingPerHour: 3, chargingPerHour: 3 },
  'campus-a': { rentalPerHour: 5, parkingPerHour: 3, chargingPerHour: 2.5 },
  'campus-b': { rentalPerHour: 5, parkingPerHour: 3, chargingPerHour: 2.5 },
  service: { rentalPerHour: 2, parkingPerHour: 1.5, chargingPerHour: 1.5 },
};

const DEFAULT_RATES: HubDemandRates = {
  rentalPerHour: 4,
  parkingPerHour: 2,
  chargingPerHour: 2,
};

const DESTINATION_WEIGHTS: Record<string, number> = {
  metro: 0.3,
  dorm: 0.25,
  'campus-a': 0.2,
  'campus-b': 0.18,
  service: 0.07,
};

export const TRIP_DURATION_MIN_RANGE = { min: 5, max: 20 } as const;
export const PARKING_STAY_MIN_RANGE = { min: 120, max: 240 } as const;

/**
 * Hourly multiplier for a Hub at hour-of-day `hour` (0..23).
 * Metro peaks at 07:00–09:00 and 16:00–18:00 (ARCHITECTURE §12.3).
 */
export function hourlyMultiplier(hubId: string, hourOfDay: number): number {
  const h = ((hourOfDay % 24) + 24) % 24;
  if (hubId === 'metro' && ((h >= 7 && h < 9) || (h >= 16 && h < 18))) {
    return 2.0;
  }
  if (h >= 7 && h < 19) {
    return 1.1;
  }
  return 0.4;
}

export function getHourlyDemand(hubId: string, hourOfDay: number): HubDemandRates {
  const base = BASE_RATES_BY_HUB[hubId] ?? DEFAULT_RATES;
  const mult = hourlyMultiplier(hubId, hourOfDay);
  return {
    rentalPerHour: base.rentalPerHour * mult,
    parkingPerHour: base.parkingPerHour * mult,
    chargingPerHour: base.chargingPerHour * mult,
  };
}

/**
 * Picks a destination Hub different from `originHubId` (if another Hub exists) using seeded `rand`.
 */
export function pickDestinationHub(
  originHubId: string,
  allHubIds: readonly string[],
  rand: () => number,
): string {
  const candidates = allHubIds.filter((id) => id !== originHubId);
  if (candidates.length === 0) return originHubId;

  let totalWeight = 0;
  const weights = candidates.map((id) => {
    const w = DESTINATION_WEIGHTS[id] ?? 0.15;
    totalWeight += w;
    return w;
  });

  let roll = rand() * totalWeight;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i]!;
    if (roll <= 0) return candidates[i]!;
  }
  return candidates[candidates.length - 1]!;
}
