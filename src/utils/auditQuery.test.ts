import { DocumentType } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { bareEntityTypesByModule, moduleAuditWhere } from './auditQuery';

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
});
