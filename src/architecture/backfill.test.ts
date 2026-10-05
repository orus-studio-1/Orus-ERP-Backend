import fs from 'fs';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

dotenv.config();

// Runs the real migration SQL against throw-away tables in a private schema, so it needs a reachable
// Postgres (DATABASE_URL) but never touches real data. Without one the tests are skipped.
const migrations = path.resolve(__dirname, '../../prisma/migrations');
const backfillSql = fs.readFileSync(path.join(migrations, '20261004210000_platform_audit_log_backfill/migration.sql'), 'utf8');
const actorSql = fs.readFileSync(path.join(migrations, '20261005100000_platform_audit_log_actor_snapshot/migration.sql'), 'utf8');

const SCHEMA = `backfill_test_${process.pid}`;
const T1 = '0198aaaa-0000-7000-8000-000000000001';
let client: pg.Client | undefined;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const candidate = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
  try { await candidate.connect(); client = candidate; } catch { return; }
  await client.query(`CREATE SCHEMA "${SCHEMA}"`);
  await client.query(`SET search_path TO "${SCHEMA}"`);
  await client.query(`
    CREATE TABLE "Company" (id text PRIMARY KEY, "tenantId" uuid);
    CREATE TABLE "AuditLog" (id text PRIMARY KEY, "companyId" text, "actorId" text, "actorEmail" text, "actorRole" text, "entityType" text, "entityId" text, action text, "statusBefore" text, "statusAfter" text, message text, diff jsonb, "createdAt" timestamptz DEFAULT now());
    CREATE TABLE "AccessAuditLog" (id text PRIMARY KEY, "companyId" text, "actorId" text, "targetUserId" text, "targetRoleId" text, action text, message text, before jsonb, after jsonb, "createdAt" timestamptz DEFAULT now());
    CREATE TABLE "ProcurementAuditEvent" (id text PRIMARY KEY, "companyId" text, "actorId" text, "entityType" text, "entityId" text, action text, "rfqId" text, message text, before jsonb, after jsonb, "createdAt" timestamptz DEFAULT now());
    CREATE TABLE "PlatformAuditLog" (id uuid PRIMARY KEY, "tenantId" uuid, "companyId" text, "userId" text, "entityType" text NOT NULL, "entityId" text, action text NOT NULL, before jsonb, after jsonb, diff jsonb, "statusBefore" text, "statusAfter" text, message text, "targetUserId" text, "targetRoleId" text, "rfqId" text, "createdAt" timestamptz DEFAULT now());
    INSERT INTO "Company" VALUES ('c1', '${T1}');
    INSERT INTO "AuditLog" (id, "companyId", "actorId", "actorEmail", "actorRole", "entityType", "entityId", action, "statusBefore", "statusAfter") VALUES ('a1', 'c1', 'gone_user', 'ghost@old.test', 'ACCOUNTANT', 'SALES_INVOICE', 'inv1', 'SUBMIT', 'DRAFT', 'SUBMITTED');
    INSERT INTO "AccessAuditLog" (id, "companyId", "actorId", "targetUserId", "targetRoleId", action, before, after) VALUES ('x1', 'c1', 'admin1', 'u9', 'r9', 'ROLE_CHANGED', '{"r":1}', '{"r":2}');
    INSERT INTO "ProcurementAuditEvent" (id, "companyId", "actorId", "entityType", "entityId", action, "rfqId") VALUES ('p1', 'c1', 'buyer1', 'RFQ', 'rfq1', 'SEND', 'rfq1');
  `);
});

afterAll(async () => {
  if (!client) return;
  await client.query(`DROP SCHEMA "${SCHEMA}" CASCADE`);
  await client.end();
});

describe('legacy audit backfill', () => {
  // The first migration creates the rows; the second one adds the actor columns and fills them.
  const runMigrations = async () => {
    await client!.query(backfillSql);
    await client!.query(`ALTER TABLE "PlatformAuditLog" ADD COLUMN IF NOT EXISTS "actorEmail" text, ADD COLUMN IF NOT EXISTS "actorRole" text`);
    await client!.query(actorSql);
  };
  const rows = async () => (await client!.query(`SELECT * FROM "PlatformAuditLog" ORDER BY "entityType"`)).rows;

  it('copies every legacy table into PlatformAuditLog with the tenant resolved from the company', async (ctx) => {
    if (!client) return ctx.skip();
    await runMigrations();
    const all = await rows();
    expect(all).toHaveLength(3);
    expect(all.every((row) => row.tenantId === T1 && row.companyId === 'c1')).toBe(true);
    const byType = Object.fromEntries(all.map((row) => [row.entityType, row]));
    expect(byType.SALES_INVOICE).toMatchObject({ userId: 'gone_user', action: 'SUBMIT', statusBefore: 'DRAFT', statusAfter: 'SUBMITTED' });
    expect(byType.ACCESS).toMatchObject({ userId: 'admin1', entityId: 'r9', targetUserId: 'u9', targetRoleId: 'r9', before: { r: 1 }, after: { r: 2 } });
    expect(byType.RFQ).toMatchObject({ userId: 'buyer1', rfqId: 'rfq1', action: 'SEND' });
  });

  it('keeps the actor email and role of legacy invoice rows', async (ctx) => {
    if (!client) return ctx.skip();
    const row = (await rows()).find((r) => r.entityType === 'SALES_INVOICE');
    expect(row).toMatchObject({ actorEmail: 'ghost@old.test', actorRole: 'ACCOUNTANT' });
  });

  it('is safe to run again: no duplicates', async (ctx) => {
    if (!client) return ctx.skip();
    await runMigrations();
    expect(await rows()).toHaveLength(3);
  });
});
