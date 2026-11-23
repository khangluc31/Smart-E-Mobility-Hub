// Pure seed data definitions (ARCHITECTURE §5.3, SPEC §1, NFR-18).
// No Prisma or DB imports: adding a 6th Hub is a single new entry in `hubs`.

import type { PrivateEvType, Role, VehicleClass } from '../src/types/enums';

export interface HubSeedRow {
  id: string;
  code: string;
  name: string;
  location: string;
  rentalVehicles: number;
  fleetMotoSpaces: number;
  publicMotoSpaces: number;
  publicCarSpaces: number;
  motoChargingPoints: number;
  carChargingPoints: number;
  minAvailable: number;
  maxAvailable: number;
}

export interface AccountSeedRow {
  id: string;
  identifier: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface PrivateEvSeedRow {
  id: string;
  ownerId: string;
  type: PrivateEvType;
  vehicleClass: VehicleClass;
  label: string;
  batteryCapacityKwh: number;
  batteryPct: number;
}

export interface SeedData {
  hubs: readonly HubSeedRow[];
  accounts: readonly AccountSeedRow[];
  privateEvs: readonly PrivateEvSeedRow[];
}

export const HUBS: readonly HubSeedRow[] = [
  {
    id: 'metro',
    code: 'MET',
    name: 'Metro Station Hub',
    location: 'Central Station, Platform 2',
    rentalVehicles: 90,
    fleetMotoSpaces: 110,
    publicMotoSpaces: 40,
    publicCarSpaces: 10,
    motoChargingPoints: 12,
    carChargingPoints: 4,
    minAvailable: 15,
    maxAvailable: 100,
  },
  {
    id: 'dorm',
    code: 'DRM',
    name: 'Dormitory Hub',
    location: 'West Campus Dormitory B',
    rentalVehicles: 70,
    fleetMotoSpaces: 85,
    publicMotoSpaces: 40,
    publicCarSpaces: 8,
    motoChargingPoints: 10,
    carChargingPoints: 2,
    minAvailable: 10,
    maxAvailable: 75,
  },
  {
    id: 'campus-a',
    code: 'CPA',
    name: 'Campus A Hub',
    location: 'Engineering Faculty, Lot A',
    rentalVehicles: 50,
    fleetMotoSpaces: 65,
    publicMotoSpaces: 30,
    publicCarSpaces: 8,
    motoChargingPoints: 8,
    carChargingPoints: 3,
    minAvailable: 10,
    maxAvailable: 60,
  },
  {
    id: 'campus-b',
    code: 'CPB',
    name: 'Campus B Hub',
    location: 'Science Faculty, Lot B',
    rentalVehicles: 50,
    fleetMotoSpaces: 65,
    publicMotoSpaces: 30,
    publicCarSpaces: 8,
    motoChargingPoints: 8,
    carChargingPoints: 3,
    minAvailable: 10,
    maxAvailable: 60,
  },
  {
    id: 'service',
    code: 'SVC',
    name: 'Service Area Hub',
    location: 'Maintenance Depot, South Gate',
    rentalVehicles: 40,
    fleetMotoSpaces: 55,
    publicMotoSpaces: 25,
    publicCarSpaces: 6,
    motoChargingPoints: 7,
    carChargingPoints: 3,
    minAvailable: 8,
    maxAvailable: 50,
  },
];

const OPERATOR_ACCOUNTS: AccountSeedRow[] = Array.from({ length: 2 }, (_, idx) => {
  const n = idx + 1;
  return {
    id: `u-operator${n}`,
    identifier: `operator${n}`,
    displayName: `Operator ${n}`,
    role: 'OPERATOR',
    mustChangePassword: false,
  };
});

const STUDENT_ACCOUNTS: AccountSeedRow[] = Array.from({ length: 20 }, (_, idx) => {
  const n = idx + 1;
  return {
    id: `u-student${n}`,
    identifier: `student${n}`,
    displayName: `Student ${n}`,
    role: 'STUDENT',
    mustChangePassword: false,
  };
});

export const ACCOUNTS: readonly AccountSeedRow[] = [...OPERATOR_ACCOUNTS, ...STUDENT_ACCOUNTS];

export const PRIVATE_EVS: readonly PrivateEvSeedRow[] = [
  {
    id: 'PEV-01',
    ownerId: 'u-student1',
    type: 'CAR',
    vehicleClass: 'CAR',
    label: "Student 1's car",
    batteryCapacityKwh: 42,
    batteryPct: 65,
  },
  {
    id: 'PEV-02',
    ownerId: 'u-student2',
    type: 'CAR',
    vehicleClass: 'CAR',
    label: "Student 2's car",
    batteryCapacityKwh: 38,
    batteryPct: 45,
  },
  {
    id: 'PEV-03',
    ownerId: 'u-student3',
    type: 'E_MOTORCYCLE',
    vehicleClass: 'MOTORCYCLE',
    label: "Student 3's e-motorcycle",
    batteryCapacityKwh: 3.2,
    batteryPct: 75,
  },
  {
    id: 'PEV-04',
    ownerId: 'u-student4',
    type: 'E_MOTORCYCLE',
    vehicleClass: 'MOTORCYCLE',
    label: "Student 4's e-motorcycle",
    batteryCapacityKwh: 2.8,
    batteryPct: 55,
  },
  {
    id: 'PEV-05',
    ownerId: 'u-student5',
    type: 'E_MOTORCYCLE',
    vehicleClass: 'MOTORCYCLE',
    label: "Student 5's e-motorcycle",
    batteryCapacityKwh: 3.0,
    batteryPct: 35,
  },
];

export const SEED_DATA: SeedData = {
  hubs: HUBS,
  accounts: ACCOUNTS,
  privateEvs: PRIVATE_EVS,
};

export const seedData: SeedData = SEED_DATA;
export default SEED_DATA;
