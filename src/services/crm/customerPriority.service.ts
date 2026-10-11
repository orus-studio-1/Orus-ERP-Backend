import prisma from '../../lib/prisma';

// How much a customer is worth to the business, worked out from the deals that brought them in and
// what has been billed to them since. Everything is read from the CRM and invoicing tables, nothing
// is stored: the tiers are recomputed on every call, so they always match the current data.
//
// - wonDeals / wonValue: opportunities of this customer that were won.
// - source / daysToConvert / convertedAt: the lead the customer came from (the first opportunity linked
//   to a lead), and how long the lead took to convert. Empty for customers created directly in the ERP.
// - billedSinceConversion: submitted invoices dated on or after the conversion (all invoices when the
//   customer has no lead), counted before tax (subtotal less the invoice discount).
// - repeatBusiness: what was billed beyond the value of the won deals.
// - score: wonValue + repeatBusiness, i.e. whichever is larger of the won deals and the real billing.
// - tier: A for the top 20% of customers by score, B for the next 30%, C for the rest. Customers with no
//   deals and no billing have no tier.
// Amounts are added as they are; opportunities and invoices in different currencies are not converted.
export type CustomerTier = 'A' | 'B' | 'C';

export type CustomerPriority = {
  tier: CustomerTier | null;
  score: number;
  wonDeals: number;
  wonValue: number;
  source: string | null;
  daysToConvert: number | null;
  convertedAt: string | null;
  leadId: string | null;
  billedSinceConversion: number;
  repeatBusiness: number;
  overdueAmount: number;
  overdueInvoices: number;
};

const DAY = 86400000;

export const emptyPriority = (): CustomerPriority => ({
  tier: null, score: 0, wonDeals: 0, wonValue: 0, source: null, daysToConvert: null, convertedAt: null, leadId: null,
  billedSinceConversion: 0, repeatBusiness: 0, overdueAmount: 0, overdueInvoices: 0,
});

export const tierRank = (tier: CustomerTier | null) => (tier === 'A' ? 0 : tier === 'B' ? 1 : tier === 'C' ? 2 : 3);

export function assignTiers(scores: { id: string; score: number }[]) {
  const ranked = scores.filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
  const topA = Math.ceil(ranked.length * 0.2);
  const topB = topA + Math.ceil(ranked.length * 0.3);
  const tiers = new Map<string, CustomerTier>();
  ranked.forEach((row, index) => tiers.set(row.id, index < topA ? 'A' : index < topB ? 'B' : 'C'));
  return tiers;
}

export async function computeCustomerPriority(): Promise<Map<string, CustomerPriority>> {
  const [won, linked, invoices, customers] = await Promise.all([
    prisma.opportunity.groupBy({ by: ['customerId'], where: { customerId: { not: null }, stage: 'CLOSED_WON' }, _count: { _all: true }, _sum: { value: true } }),
    prisma.opportunity.findMany({
      where: { customerId: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { customerId: true, leadId: true, createdAt: true, lead: { select: { source: true, createdAt: true } } },
    }),
    prisma.salesInvoice.findMany({ where: { status: 'SUBMITTED' }, select: { customerId: true, date: true, dueDate: true, subtotal: true, discount: true, outstandingAmount: true } }),
    prisma.customer.findMany({ select: { id: true } }),
  ]);

  const result = new Map<string, CustomerPriority>(customers.map((customer) => [customer.id, emptyPriority()]));
  for (const row of won) {
    const entry = result.get(row.customerId as string);
    if (!entry) continue;
    entry.wonDeals = row._count._all;
    entry.wonValue = Number(row._sum.value || 0);
  }
  // The first opportunity that came from a lead is the conversion of this customer.
  for (const opp of linked) {
    const entry = result.get(opp.customerId as string);
    if (!entry || entry.convertedAt || !opp.leadId || !opp.lead) continue;
    entry.leadId = opp.leadId;
    entry.source = opp.lead.source;
    entry.convertedAt = opp.createdAt.toISOString();
    entry.daysToConvert = Math.max(0, Math.floor((opp.createdAt.getTime() - opp.lead.createdAt.getTime()) / DAY));
  }
  const now = Date.now();
  for (const invoice of invoices) {
    const entry = result.get(invoice.customerId);
    if (!entry) continue;
    // Billing is counted before tax, like the value of a deal, so GST does not look like extra business.
    const beforeTax = Math.max(0, Number(invoice.subtotal || 0) - Number(invoice.discount || 0));
    if (!entry.convertedAt || invoice.date.getTime() >= new Date(entry.convertedAt).getTime()) entry.billedSinceConversion += beforeTax;
    const outstanding = Number(invoice.outstandingAmount || 0);
    if (outstanding > 0 && invoice.dueDate && invoice.dueDate.getTime() < now) {
      entry.overdueAmount += outstanding;
      entry.overdueInvoices += 1;
    }
  }
  for (const entry of result.values()) {
    entry.repeatBusiness = Math.max(0, entry.billedSinceConversion - entry.wonValue);
    entry.score = entry.wonValue + entry.repeatBusiness;
  }
  const tiers = assignTiers([...result.entries()].map(([id, entry]) => ({ id, score: entry.score })));
  for (const [id, entry] of result) entry.tier = tiers.get(id) ?? null;
  return result;
}

// ---- Contacts ----------------------------------------------------------------------------------
// A contact's tier is about the money that person brought in: the value of the won opportunities that
// name them as the contact. Tiers follow the same rule as customers (top 20% A, next 30% B, rest C;
// no tier without a won deal).
export type ContactPriority = {
  tier: CustomerTier | null;
  score: number;
  wonDeals: number;
  wonValue: number;
  lastWonAt: string | null;
};

export const emptyContactPriority = (): ContactPriority => ({ tier: null, score: 0, wonDeals: 0, wonValue: 0, lastWonAt: null });

export async function computeContactPriority(): Promise<Map<string, ContactPriority>> {
  const [won, contacts] = await Promise.all([
    prisma.opportunity.groupBy({ by: ['contactId'], where: { contactId: { not: null }, stage: 'CLOSED_WON' }, _count: { _all: true }, _sum: { value: true }, _max: { wonAt: true } }),
    prisma.contact.findMany({ select: { id: true } }),
  ]);
  const result = new Map<string, ContactPriority>(contacts.map((contact) => [contact.id, emptyContactPriority()]));
  for (const row of won) {
    const entry = result.get(row.contactId as string);
    if (!entry) continue;
    entry.wonDeals = row._count._all;
    entry.wonValue = Number(row._sum.value || 0);
    entry.score = entry.wonValue;
    entry.lastWonAt = row._max.wonAt ? row._max.wonAt.toISOString() : null;
  }
  const tiers = assignTiers([...result.entries()].map(([id, entry]) => ({ id, score: entry.score })));
  for (const [id, entry] of result) entry.tier = tiers.get(id) ?? null;
  return result;
}
