import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/prisma', async () => {
  const { Prisma } = await import('@prisma/client');
  const delegates = Object.fromEntries(
    Prisma.dmmf.datamodel.models.map((model) => [model.name.charAt(0).toLowerCase() + model.name.slice(1), { findUnique: () => null, findFirst: () => null }]),
  );
  return { default: delegates };
});

import { auditDelegateFor, documentOperations } from '../middleware/platform';

// Record-level mutation routes (an :id in the path) must resolve to a Prisma model so the audit row
// can carry a "before" snapshot. A route that does not is listed here on purpose (it acts on a
// composite/body key, a non-model resource, or an action, not on one record by id). Anything new
// that is not resolvable fails this test instead of silently losing its "before" value.
const knownUnresolved = new Set<string>([
  'platform:approvals',
  'accounting:journal-templates',
]);

const rootModules = new Set(['customers', 'suppliers', 'projects', 'invoices', 'delivery-notes']);
const skipModules = new Set(['auth', 'notifications', 'dashboard']);
const mountOf = (file: string) => file.replace('.routes.ts', '').replace('invoicing-extras', 'invoicing');

function recordResources(source: string, moduleName: string) {
  const found = new Set<string>();
  const isRoot = rootModules.has(moduleName);
  const add = (resource: string) => found.add(`${moduleName}:${resource}`);

  if (isRoot) {
    for (const match of source.matchAll(/router\.(?:put|patch|delete)\('\/:[A-Za-z]+'/g)) { void match; add('request'); }
    for (const match of source.matchAll(/router\.route\('\/:[A-Za-z]+'\)([^;]*);/g)) if (/\.(put|patch|delete)\(/.test(match[1])) add('request');
    for (const match of source.matchAll(/router\.post\('\/:[A-Za-z]+\/([a-z-]+)'/g)) if (documentOperations.has(match[1])) add('request');
    return found;
  }
  for (const match of source.matchAll(/router\.(?:put|patch|delete)\('\/([a-z0-9-]+)\/:[A-Za-z]+/g)) add(match[1]);
  for (const match of source.matchAll(/router\.route\('\/([a-z0-9-]+)\/:[A-Za-z]+'\)([^;]*);/g)) if (/\.(put|patch|delete)\(/.test(match[2])) add(match[1]);
  for (const match of source.matchAll(/router\.post\('\/([a-z0-9-]+)\/:[A-Za-z]+\/([a-z-]+)'/g)) if (documentOperations.has(match[2])) add(match[1]);
  return found;
}

describe('audit "before" snapshot coverage', () => {
  const routesDir = path.join(__dirname);
  const records = new Set<string>();
  for (const file of fs.readdirSync(routesDir).filter((name) => name.endsWith('.routes.ts'))) {
    const moduleName = mountOf(file);
    if (skipModules.has(moduleName)) continue;
    for (const key of recordResources(fs.readFileSync(path.join(routesDir, file), 'utf8'), moduleName)) records.add(key);
  }

  it('finds the record routes it is meant to check', () => {
    expect(records.size).toBeGreaterThan(60);
    expect(records.has('hr:employees')).toBe(true);
  });

  it('resolves every record-level mutation route to a Prisma model', () => {
    const unresolved = [...records].filter((key) => {
      const [moduleName, resource] = key.split(':');
      return !auditDelegateFor(moduleName, resource) && !knownUnresolved.has(key);
    });
    expect(unresolved, `Add a model mapping in auditDelegates (src/middleware/platform.ts) or list these in knownUnresolved: ${unresolved.join(', ')}`).toEqual([]);
  });

  it('keeps the known-unresolved list honest', () => {
    const stale = [...knownUnresolved].filter((key) => {
      const [moduleName, resource] = key.split(':');
      return !records.has(key) || Boolean(auditDelegateFor(moduleName, resource));
    });
    expect(stale, `These no longer need to be in knownUnresolved: ${stale.join(', ')}`).toEqual([]);
  });
});
