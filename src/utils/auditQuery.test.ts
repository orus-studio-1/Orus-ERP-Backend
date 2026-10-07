import { DocumentType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { bareEntityTypesByModule, moduleAuditWhere, prefixAliasesByModule } from './auditQuery';

describe('audit module filter', () => {
  it('maps every DocumentType value to a module so backfilled legacy rows can be filtered', () => {
    const mapped = new Set(Object.values(bareEntityTypesByModule).flat());
    const unmapped = Object.values(DocumentType).filter((type) => !mapped.has(type));
    expect(unmapped, `Add these DocumentType values to bareEntityTypesByModule: ${unmapped.join(', ')}`).toEqual([]);
  });

  it('does not list one entity type under two modules', () => {
    const all = Object.values(bareEntityTypesByModule).flat();
    expect(all.filter((type, index) => all.indexOf(type) !== index)).toEqual([]);
  });

  it('matches the automatic MODULE: prefix and the module\'s bare business-event types', () => {
    const where = moduleAuditWhere('hr');
    expect(where.OR[0]).toEqual({ entityType: { startsWith: 'HR:' } });
    expect(where.OR).toContainEqual({ entityType: { in: expect.arrayContaining(['EMPLOYEE', 'SALARY_SLIP']) } });
  });

  it('falls back to the prefix match for a module with no bare types', () => {
    expect(moduleAuditWhere('crm').OR).toEqual([{ entityType: { startsWith: 'CRM:' } }, { entityType: 'crm' }]);
  });

  it('finds the automatic rows of routers mounted under another name than their module', () => {
    const invoicing = moduleAuditWhere('invoicing').OR.map((clause: any) => clause.entityType?.startsWith);
    expect(invoicing).toEqual(expect.arrayContaining(['INVOICING:', 'INVOICES:', 'PAYMENTS:', 'DELIVERY-NOTES:']));
    expect(moduleAuditWhere('inventory').OR).toContainEqual({ entityType: { startsWith: 'PRODUCTS:' } });
    expect(moduleAuditWhere('sales').OR).toContainEqual({ entityType: { startsWith: 'SALES-ORDERS:' } });
  });

  it('gives every router mounted in index.ts a module filter that can find its automatic rows', () => {
    const modules = ['ACCESS', 'ACCOUNTING', 'CRM', 'CUSTOMERS', 'HR', 'INVENTORY', 'INVOICING', 'MANUFACTURING', 'PROCUREMENT', 'PROJECTS', 'SALES', 'SUPPLIERS'];
    const aliased = new Set(Object.values(prefixAliasesByModule).flat().map((prefix) => prefix.toLowerCase()));
    const noAuditModule = new Set(['auth', 'platform', 'dashboard', 'notifications']);
    const index = fs.readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8');
    const mounts = [...new Set([...index.matchAll(/app\.use\('\/api\/([a-z-]+)'/g)].map((match) => match[1]))];
    const orphans = mounts.filter((mount) => !noAuditModule.has(mount) && !modules.includes(mount.toUpperCase()) && !aliased.has(mount));
    expect(orphans, `Map these routers to a module in prefixAliasesByModule: ${orphans.join(', ')}`).toEqual([]);
  });
});
