import prisma from '../lib/prisma';
import { ensureCompanyDefaultRoles } from '../utils/accessControl';

async function main() {
  console.log('Running tenant and company reconciliation...');

  const companies = await prisma.company.findMany({
    include: { tenant: true, users: true },
  });

  console.log(`Found ${companies.length} companies.`);

  for (const company of companies) {
    let tenantId = company.tenantId;

    if (!tenantId || !company.tenant) {
      console.log(`Creating Tenant for company "${company.name}" (slug: ${company.slug})...`);
      const tenant = await prisma.tenant.upsert({
        where: { slug: company.slug },
        update: { name: company.name, baseCurrency: company.currency || 'INR' },
        create: { name: company.name, slug: company.slug, baseCurrency: company.currency || 'INR' },
      });
      tenantId = tenant.id;

      await prisma.company.update({
        where: { id: company.id },
        data: { tenantId },
      });
    }

    // Ensure main branch
    let mainBranch = await prisma.branch.findFirst({ where: { companyId: company.id } });
    if (!mainBranch) {
      mainBranch = await prisma.branch.create({
        data: {
          tenantId,
          companyId: company.id,
          code: 'MAIN',
          name: 'Main Branch',
        },
      });
    } else if (!mainBranch.tenantId && tenantId) {
      await prisma.branch.update({
        where: { id: mainBranch.id },
        data: { tenantId },
      });
    }

    // Ensure company default roles
    await ensureCompanyDefaultRoles(company.id).catch((err) =>
      console.warn(`Role init for company ${company.id}:`, err?.message)
    );

    // Link users
    const users = await prisma.user.findMany({ where: { companyId: company.id } });
    for (const user of users) {
      if (tenantId) {
        await prisma.tenantMembership.upsert({
          where: { tenantId_userId: { tenantId, userId: user.id } },
          update: { isActive: true },
          create: { tenantId, userId: user.id, isOwner: user.role === 'SUPER_ADMIN', isActive: true },
        }).catch(() => null);

        await prisma.companyMembership.upsert({
          where: { companyId_userId: { companyId: company.id, userId: user.id } },
          update: { tenantId, isActive: true, defaultBranchId: mainBranch?.id },
          create: { tenantId, companyId: company.id, userId: user.id, defaultBranchId: mainBranch?.id, isActive: true },
        }).catch(() => null);
      }
    }
  }

  console.log('Reconciliation complete.');
}

main()
  .catch((e) => {
    console.error('Reconciliation error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
