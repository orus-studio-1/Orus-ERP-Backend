// Hourly sweep for the e-invoice reporting window. Runs outside a request, so each company is handled inside its own
// tenant context. Two jobs:
//  1. warn (once per level) when a document that must be reported has used 50% / 80% (the rule version's points) of
//     its window, and when the window has passed;
//  2. one reminder a day when e-invoices are FAILED, or were exported more than `followUpDays` ago with no result.
import prisma from '../../lib/prisma';
import { runWithTenant } from '../../utils/tenant';
import { unreportedReport } from './einvoice.service';
import { windowProgress } from './einvoiceRules.service';

async function notifyUsers(companyId: string, input: { type: string; title: string; message: string; link: string }) {
  const users = await prisma.user.findMany({ where: { companyId, isActive: true }, select: { id: true } });
  if (users.length) await prisma.notification.createMany({ data: users.map((user) => ({ companyId, userId: user.id, ...input })) });
}

async function sweepCompany(companyId: string) {
  const sent = { warnings: 0, followUps: 0 };
  const report: any = await unreportedReport(prisma, 60);
  for (const row of report.items || []) {
    if (!row.deadline) continue;
    const state = windowProgress(new Date(), new Date(row.date), new Date(row.deadline), row.warnAtPercents || []);
    const levels = [...state.crossed, ...(state.breached ? [100] : [])];
    for (const level of levels) {
      const sourceKey = `${row.sourceType}:${row.sourceId}`;
      const already = await prisma.eInvoiceWarning.findFirst({ where: { sourceKey, level } });
      if (already) continue;
      await prisma.eInvoiceWarning.create({ data: { sourceKey, level } });
      const days = Math.max(0, Math.ceil(state.msLeft / 86400000));
      await notifyUsers(companyId, {
        type: 'EINVOICE_WINDOW',
        title: level >= 100 ? `E-invoice window missed: ${row.docNo}` : `E-invoice window ${level}% used: ${row.docNo}`,
        message: level >= 100 ? `${row.docNo} (${row.customer || 'customer'}) was not reported within the allowed days. Ask the CA how to correct it.` : `${row.docNo} (${row.customer || 'customer'}) still has no IRN. ${days} day(s) left to report it.`,
        link: '/invoicing/einvoice/unreported',
      });
      sent.warnings += 1;
    }
  }

  const config = await prisma.eInvoiceConfig.findFirst({});
  const followUpDays = config?.followUpDays ?? 2;
  const staleBefore = new Date(Date.now() - followUpDays * 86400000);
  const [failed, waiting] = await Promise.all([
    prisma.eInvoice.count({ where: { status: 'FAILED' } }),
    prisma.eInvoice.count({ where: { status: 'EXPORTED', exportedAt: { lt: staleBefore } } }),
  ]);
  if (failed || waiting) {
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const today = await prisma.notification.findFirst({ where: { companyId, type: 'EINVOICE_FOLLOW_UP', createdAt: { gte: since } } });
    if (!today) {
      await notifyUsers(companyId, {
        type: 'EINVOICE_FOLLOW_UP', title: 'E-invoices need attention',
        message: `${failed} rejected by the portal, ${waiting} exported more than ${followUpDays} day(s) ago with no result recorded.`, link: '/invoicing/einvoice',
      });
      sent.followUps += 1;
    }
  }
  return sent;
}

export async function runEInvoiceSweep() {
  const companies = await prisma.company.findMany({ select: { id: true, tenantId: true } });
  const total = { warnings: 0, followUps: 0 };
  for (const company of companies) {
    try {
      const result = await runWithTenant({ companyId: company.id, tenantId: company.tenantId }, () => sweepCompany(company.id));
      total.warnings += result.warnings; total.followUps += result.followUps;
    } catch (err) {
      console.error(`E-invoice sweep failed for company ${company.id}`, err);
    }
  }
  return total;
}
