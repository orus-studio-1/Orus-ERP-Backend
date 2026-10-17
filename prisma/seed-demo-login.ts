// A login for trying the web and mobile apps against a LOCAL database: one extra SUPER_ADMIN in the
// demo company. It does not touch any existing user.
//
//   npx ts-node --transpile-only prisma/seed-demo-login.ts
//   npx ts-node --transpile-only prisma/seed-demo-login.ts --company some-slug   (default: orus-demo)
//
// Sign in with DEMO_EMAIL / DEMO_PASSWORD below and the company slug (default orus-demo).
// Running it again resets that user's password to DEMO_PASSWORD. It refuses to run unless
// DATABASE_URL points at localhost, so these test credentials can never be created on a shared database.
import 'dotenv/config';
import argon2 from 'argon2';
import prisma from '../src/lib/prisma';
import { ensureCompanyDefaultRoles } from '../src/utils/accessControl';
import { generateEmployeeId } from '../src/utils/generate';
import { runWithTenant } from '../src/utils/tenant';

export const DEMO_EMAIL = 'demo.admin@orus-demo.test';
export const DEMO_PASSWORD = 'Orus-Demo#2026-x7Qk';

const args = process.argv.slice(2);
const slug = args.includes('--company') ? args[args.indexOf('--company') + 1] : 'orus-demo';
const host = (() => { try { return new URL(process.env.DATABASE_URL || '').hostname; } catch { return ''; } })();
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(`Refusing to seed: DATABASE_URL host is "${host || 'unknown'}", not localhost.`);
  process.exit(1);
}

async function main() {
  const company = await prisma.company.findUnique({ where: { slug } });
  if (!company) throw new Error(`Company "${slug}" not found`);
  const branch = await prisma.branch.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: 'asc' } });
  const password = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: { password, isActive: true, failedLoginCount: 0, lockedUntil: null, companyId: company.id, passwordChangedAt: new Date() },
    create: { email: DEMO_EMAIL, password, firstName: 'Demo', lastName: 'Admin', role: 'SUPER_ADMIN', companyId: company.id, passwordChangedAt: new Date() },
  });
  await prisma.tenantMembership.upsert({
    where: { tenantId_userId: { tenantId: company.tenantId, userId: user.id } },
    update: {},
    create: { tenantId: company.tenantId, userId: user.id, isOwner: false },
  });
  await prisma.companyMembership.upsert({
    where: { companyId_userId: { companyId: company.id, userId: user.id } },
    update: {},
    create: { tenantId: company.tenantId, companyId: company.id, userId: user.id, defaultBranchId: branch?.id },
  });
  const roles = await ensureCompanyDefaultRoles(company.id);
  await prisma.userAccessRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: roles.SUPER_ADMIN.id } },
    update: {},
    create: { userId: user.id, roleId: roles.SUPER_ADMIN.id, assignedById: user.id },
  });
  const hasEmployee = await prisma.employee.findUnique({ where: { userId: user.id } });
  if (!hasEmployee) {
    await runWithTenant({ tenantId: company.tenantId, companyId: company.id, branchId: branch?.id, userId: user.id }, async () => {
      await prisma.employee.create({ data: { employeeId: await generateEmployeeId(), userId: user.id, hireDate: new Date(), salary: 0, salaryType: 'MONTHLY', status: 'ACTIVE', companyEmail: DEMO_EMAIL } as any });
    });
  }
  console.log(`Demo login ready for "${company.name}" (slug ${company.slug}). Email and password are at the top of prisma/seed-demo-login.ts.`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => process.exit());
