import { PrismaClient, Prisma } from '@prisma/client';
import { notFound } from './errors';

export const db = new PrismaClient();

export type Tx = Prisma.TransactionClient;
export type DbClient = typeof db | Tx;

// Lockable rows (ARCHITECTURE §4.1). The map is the ONLY source of table names —
// lockRow never interpolates caller input into SQL.
const LOCKABLE_TABLES = {
  rental_vehicle: 'rental_vehicle',
  parking_space: 'parking_space',
  charging_point: 'charging_point',
  vehicle_reservation: 'vehicle_reservation',
  parking_reservation: 'parking_reservation',
  charging_request: 'charging_request',
  redistribution_task: 'redistribution_task',
  incident: 'incident',
  private_ev: 'private_ev',
} as const;

export type LockableTable = keyof typeof LOCKABLE_TABLES;

// SELECT ... FOR UPDATE on one row inside a transaction (D-03, BR-10). Must be
// called with a Tx (a lock outside a transaction would release immediately).
// The id is a bound parameter; the table name comes only from the fixed map.
export async function lockRow(tx: Tx, table: LockableTable, id: string): Promise<void> {
  const tableName = LOCKABLE_TABLES[table];
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "${tableName}" WHERE id = $1 FOR UPDATE`,
    id,
  );
  if (rows.length === 0) throw notFound(table);
}
