// Demo data for every CRM feature, for manual testing on a LOCAL database.
//
//   node prisma/seed-crm-demo.js            add (or refresh) the demo data
//   node prisma/seed-crm-demo.js --remove   delete only the demo data
//   node prisma/seed-crm-demo.js --company some-slug   use another company (default: orus-demo)
//
// Every row it creates has an id starting with "demo_crm_", so a re-run replaces the demo data and
// never touches real rows. It refuses to run against a database that is not on localhost.
// Rows are written straight to the database (not through the API), so they do not create audit rows.
const crypto = require('crypto');
const dotenv = require('dotenv');
const pg = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

dotenv.config();

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const slug = args.includes('--company') ? args[args.indexOf('--company') + 1] : 'orus-demo';
const P = 'demo_crm_';
const DEMO_CAPTURE_TOKEN = 'demo-crm-capture-token';

const url = process.env.DATABASE_URL || '';
const host = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
  console.error(`Refusing to seed: DATABASE_URL host is "${host || 'unknown'}", not localhost.`);
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg(new pg.Pool({ connectionString: url })) });
const day = 86400000;
const at = (days, hours = 0) => new Date(Date.now() + days * day + hours * 3600000);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const email = (value) => String(value || '').trim().toLowerCase() || null;
const phone = (value) => { const digits = String(value || '').replace(/\D/g, ''); return digits ? `+${digits}` : null; };

async function wipe() {
  const where = { id: { startsWith: P } };
  const steps = [
    ['crmPhone', where], ['activityAttendee', where], ['activity', where], ['crmCommunication', where], ['crmLeadEvent', where],
    ['opportunityStageHistory', where], ['opportunityItem', where], ['opportunity', where], ['contact', where],
    ['leadImportRow', where], ['lead', where], ['leadImportBatch', where], ['crmOrganization', where],
    ['crmAssignmentRule', where], ['crmScopeRule', where], ['crmSavedView', where], ['crmLostReason', where],
    ['crmEmailTemplate', where], ['crmCaptureToken', where], ['numberingSeries', where], ['crmTerritory', where],
  ];
  for (const [model, filter] of steps) await prisma[model].deleteMany({ where: filter });
}

async function main() {
  const company = await prisma.company.findUnique({ where: { slug } });
  if (!company) throw new Error(`Company "${slug}" not found`);
  const user = (await prisma.user.findFirst({ where: { companyId: company.id, role: 'SUPER_ADMIN' }, orderBy: { createdAt: 'asc' } }))
    || (await prisma.user.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: 'asc' } }));
  if (!user) throw new Error(`Company "${slug}" has no user`);
  const branch = await prisma.branch.findFirst({ where: { companyId: company.id }, orderBy: { createdAt: 'asc' } });
  const companyId = company.id;
  const U = user.id;
  const branchId = branch ? branch.id : undefined;

  await wipe();
  if (remove) { console.log('Demo CRM data removed.'); return; }

  const counts = {};
  // Convert (lead to customer) allocates a customer number from this company's series, but
  // Customer.customerNo is unique across the whole database. A fresh series starts at 1 and can hit
  // numbers another company already uses (CUST26-2700001...). Start this company's series high so
  // Convert works. If the series already exists (e.g. from an earlier try) it is only moved forward.
  const FIRST_SAFE_NUMBER = 100;
  const customerSeries = await prisma.numberingSeries.findFirst({ where: { companyId, documentType: 'CUSTOMER', name: 'Default', isActive: true, isDefault: true } });
  if (customerSeries) {
    if (customerSeries.current < FIRST_SAFE_NUMBER) await prisma.numberingSeries.update({ where: { id: customerSeries.id }, data: { current: FIRST_SAFE_NUMBER } });
  } else {
    await prisma.numberingSeries.create({ data: { id: `${P}series_customer`, tenantId: company.tenantId, companyId, branchId, documentType: 'CUSTOMER', name: 'Default', pattern: '{PREFIX}{FY}{BRANCH}{SEQ}', prefix: 'CUST', digits: 5, current: FIRST_SAFE_NUMBER, resetPeriod: 'FISCAL_YEAR', isDefault: true, isActive: true } });
  }
  const add = async (model, data) => { const r = await prisma[model].createMany({ data, skipDuplicates: true }); counts[model] = (counts[model] || 0) + r.count; };

  // ---- Lost reasons (leads, opportunities, or both) -------------------------------------------------
  await add('crmLostReason', [
    { id: `${P}lr1`, companyId, name: 'Price too high', category: 'Commercial', appliesTo: 'BOTH', sortOrder: 10 },
    { id: `${P}lr2`, companyId, name: 'Chose a competitor', category: 'Competition', appliesTo: 'BOTH', sortOrder: 20 },
    { id: `${P}lr3`, companyId, name: 'No budget', category: 'Commercial', appliesTo: 'BOTH', sortOrder: 30 },
    { id: `${P}lr4`, companyId, name: 'No response', category: 'Engagement', appliesTo: 'LEAD', sortOrder: 40 },
    { id: `${P}lr5`, companyId, name: 'Not a fit', category: 'Fit', appliesTo: 'LEAD', sortOrder: 50 },
    { id: `${P}lr6`, companyId, name: 'Project postponed', category: 'Timing', appliesTo: 'OPPORTUNITY', sortOrder: 60 },
  ]);

  // ---- Territories (the managed list the territory dropdowns read) ----------------------------------
  await add('crmTerritory', ['West', 'North', 'South', 'East'].map((name, i) => ({ id: `${P}ter_${name.toLowerCase()}`, companyId, name, sortOrder: (i + 1) * 10 })));

  // ---- Organizations ---------------------------------------------------------------------------------
  const orgs = [
    ['acme', 'Acme Industries', 'Manufacturing', 'Mumbai', 'Maharashtra', 'India', 'acme-industries.example'],
    ['globex', 'Globex Traders', 'Wholesale', 'Delhi', 'Delhi', 'India', 'globex-traders.example'],
    ['initech', 'Initech Software', 'IT Services', 'Bengaluru', 'Karnataka', 'India', 'initech-software.example'],
    ['umbrella', 'Umbrella Pharma', 'Healthcare', 'Hyderabad', 'Telangana', 'India', 'umbrella-pharma.example'],
    ['stark', 'Stark Fabrication', 'Engineering', 'Pune', 'Maharashtra', 'India', 'stark-fabrication.example'],
    ['wayne', 'Wayne Logistics', 'Logistics', 'Ahmedabad', 'Gujarat', 'India', 'wayne-logistics.example'],
  ];
  await add('crmOrganization', orgs.map(([k, name, industry, city, state, country, domain], i) => ({
    id: `${P}org_${k}`, companyId, name, industry, website: `https://www.${domain}`, email: `info@${domain}`,
    phone: `+91 22 4000 ${1000 + i}`, address: `${10 + i}, Business Park Road`, city, state, country, zip: `40000${i}`, ownerId: U,
    notes: 'Demo organization', territory: ['Mumbai', 'Pune', 'Ahmedabad'].includes(city) ? 'West' : ['Delhi'].includes(city) ? 'North' : 'South',
  })));
  const org = (k) => `${P}org_${k}`;

  // ---- Import batch (for the Imports page) -----------------------------------------------------------
  const batchId = `${P}batch1`;
  await add('leadImportBatch', [{
    id: batchId, companyId, fileName: 'demo-leads-q3.csv', status: 'COMPLETED', totalRows: 6, createdRows: 3, skippedRows: 1,
    failedRows: 1, duplicateRows: 1, importedById: U, startedAt: at(-12), completedAt: at(-12, 0.1), errorSummary: '1 row failed validation',
  }]);

  // ---- Leads -----------------------------------------------------------------------------------------
  // [key, first, last, company, source, status, priority, city, value, createdDaysAgo, assigned, extra]
  const leadRows = [
    ['c1', 'Rohan', 'Mehta', 'Acme Industries', 'REFERRAL', 'CONVERTED', 'HIGH', 'Mumbai', 15000, 50, true, { org: 'acme' }],
    ['c2', 'Priya', 'Nair', 'Globex Traders', 'WEBSITE', 'CONVERTED', 'MEDIUM', 'Delhi', 32000, 46, true, { org: 'globex' }],
    ['c3', 'Arjun', 'Rao', 'Initech Software', 'ADVERTISEMENT', 'CONVERTED', 'HIGH', 'Bengaluru', 54000, 40, true, { org: 'initech' }],
    ['c4', 'Sneha', 'Kulkarni', 'Umbrella Pharma', 'EMAIL', 'CONVERTED', 'MEDIUM', 'Hyderabad', 21000, 36, true, { org: 'umbrella' }],
    ['c5', 'Vikram', 'Singh', 'Stark Fabrication', 'PHONE', 'CONVERTED', 'URGENT', 'Pune', 88000, 33, true, { org: 'stark' }],
    ['c6', 'Neha', 'Patel', 'Wayne Logistics', 'INDIA_MART', 'CONVERTED', 'HIGH', 'Ahmedabad', 46000, 30, true, { org: 'wayne' }],
    ['n1', 'Aarav', 'Sharma', 'Sharma Textiles', 'WEBSITE', 'LEAD', 'MEDIUM', 'Mumbai', 9000, 1, false, {}],
    ['n2', 'Isha', 'Gupta', 'Gupta Foods', 'FACEBOOK_LEAD_ADS', 'LEAD', 'LOW', 'Delhi', 4000, 2, false, { campaign: 'Diwali Offer' }],
    ['n3', 'Kabir', 'Malhotra', 'Malhotra Motors', 'INDIA_MART', 'REPLIED', 'HIGH', 'Chennai', 26000, 3, true, { campaign: 'IndiaMART Q3' }],
    // duplicate pair: same email and phone, to try duplicate check and merge
    ['d1', 'Dev', 'Anand', 'Anand Steel', 'WEBSITE', 'LEAD', 'MEDIUM', 'Pune', 12000, 4, true, { email: 'dev.anand@anand-steel.example', phone: '+91 98200 11111' }],
    ['d2', 'Dev', 'Anand', 'Anand Steel', 'WHATSAPP', 'LEAD', 'MEDIUM', 'Pune', 12000, 1, false, { email: 'dev.anand@anand-steel.example', phone: '+91 98200 11111' }],
    ['k1', 'Meera', 'Iyer', 'Iyer Exports', 'SOCIAL_MEDIA', 'OPEN', 'MEDIUM', 'Chennai', 18000, 12, true, { contacted: 3 }],
    ['k2', 'Rahul', 'Desai', 'Desai Chemicals', 'REFERRAL', 'OPEN', 'HIGH', 'Ahmedabad', 39000, 9, true, { contacted: 2 }],
    ['k3', 'Pooja', 'Bhatt', 'Bhatt Interiors', 'CSV_IMPORT', 'REPLIED', 'LOW', 'Mumbai', 7000, 11, true, { batch: 1, contacted: 4 }],
    ['q1', 'Sanjay', 'Verma', 'Verma Electricals', 'EMAIL', 'INTERESTED', 'HIGH', 'Delhi', 61000, 20, true, { contacted: 5, qualified: 4 }],
    ['q2', 'Anita', 'Joshi', 'Joshi Packaging', 'WEBSITE', 'OPPORTUNITY', 'MEDIUM', 'Pune', 28000, 18, true, { contacted: 6, qualified: 5 }],
    ['q3', 'Manish', 'Kapoor', 'Kapoor Auto', 'PHONE', 'QUOTATION', 'URGENT', 'Bengaluru', 75000, 14, true, { contacted: 4, qualified: 3 }],
    ['u1', 'Tara', 'Menon', 'Menon Crafts', 'CSV_IMPORT', 'UNQUALIFIED', 'LOW', 'Kochi', 2000, 25, true, { batch: 2, lost: 'Not a fit' }],
    ['u2', 'Gaurav', 'Saxena', 'Saxena Traders', 'ADVERTISEMENT', 'LOST_QUOTATION', 'LOW', 'Lucknow', 3500, 28, true, { lost: 'No budget' }],
    ['u3', 'Divya', 'Reddy', 'Reddy Foods', 'CSV_IMPORT', 'DO_NOT_CONTACT', 'LOW', 'Hyderabad', 1500, 35, true, { batch: 3 }],
  ];
  const lostIds = { 'Not a fit': `${P}lr5`, 'No budget': `${P}lr3`, 'No response': `${P}lr4` };
  const leadId = (k) => `${P}lead_${k}`;
  await add('lead', leadRows.map(([k, first, last, comp, source, status, priority, city, value, ago, assigned, x]) => {
    const em = x.email || `${first}.${last}@${comp.toLowerCase().replace(/[^a-z]+/g, '-')}.example`.toLowerCase();
    const ph = x.phone || `+91 98${String(10000000 + leadRows.findIndex((r) => r[0] === k) * 7311).padStart(8, '0')}`;
    return {
      id: leadId(k), companyId, title: `${first} ${last} - ${comp}`, firstName: first, lastName: last, email: em, phone: ph,
      normalizedEmail: email(em), normalizedPhone: String(ph).replace(/\D/g, '') || null,
      company: comp, city, country: 'India',
      organizationId: x.org ? org(x.org) : undefined, source, status, priority, value, score: { URGENT: 90, HIGH: 70, MEDIUM: 45, LOW: 20 }[priority],
      tags: ['demo', source.toLowerCase().replace(/_/g, '-')], branchId, territory: ['Mumbai', 'Pune', 'Ahmedabad'].includes(city) ? 'West' : ['Delhi', 'Lucknow'].includes(city) ? 'North' : 'South',
      productInterest: ['ERP Suite', 'CRM', 'Inventory', 'Billing'][leadRows.findIndex((r) => r[0] === k) % 4], campaign: x.campaign || undefined,
      lostReason: x.lost, lostReasonId: x.lost ? lostIds[x.lost] : undefined, notes: 'Demo lead', createdById: U,
      assignedToId: assigned ? U : undefined, importBatchId: x.batch ? batchId : undefined, importRowNo: x.batch,
      lastContactedAt: x.contacted ? at(-x.contacted) : undefined, qualifiedAt: x.qualified ? at(-x.qualified) : (status === 'CONVERTED' ? at(-ago + 5) : undefined),
      createdAt: at(-ago), updatedAt: at(-Math.max(1, ago - 3)),
    };
  }));

  // Phone numbers: the lead's own number is primary; a few leads also have a WhatsApp or work number.
  // n2's second number is k2's primary number, to try duplicate detection on a secondary number.
  const leadPhone = (k) => { const x = leadRows.find((r) => r[0] === k); return x[11].phone || `+91 98${String(10000000 + leadRows.indexOf(x) * 7311).padStart(8, '0')}`; };
  const extraPhones = { c1: ['+91 98765 40001', 'WHATSAPP'], c3: ['+91 22 4000 3003', 'WORK'], d1: ['+91 98200 33333', 'WORK'], k1: ['+91 98765 40002', 'WHATSAPP'], q1: ['+91 11 4000 7007', 'WORK'], n3: ['+91 98765 40003', 'WHATSAPP'], n2: [leadPhone('k2'), 'OTHER'] };
  const phoneRows = [];
  for (const [k] of leadRows) {
    const main = leadPhone(k);
    phoneRows.push({ id: `${P}ph_${k}_1`, companyId, leadId: leadId(k), number: main, normalized: String(main).replace(/\D/g, ''), type: 'MOBILE', isPrimary: true });
    if (extraPhones[k]) phoneRows.push({ id: `${P}ph_${k}_2`, companyId, leadId: leadId(k), number: extraPhones[k][0], normalized: String(extraPhones[k][0]).replace(/\D/g, ''), type: extraPhones[k][1], isPrimary: false });
  }
  await add('crmPhone', phoneRows);

  await add('leadImportRow', [
    { id: `${P}row1`, batchId, rowNo: 1, status: 'CREATED', rawData: { name: 'Pooja Bhatt', company: 'Bhatt Interiors' }, leadId: leadId('k3') },
    { id: `${P}row2`, batchId, rowNo: 2, status: 'CREATED', rawData: { name: 'Tara Menon', company: 'Menon Crafts' }, leadId: leadId('u1') },
    { id: `${P}row3`, batchId, rowNo: 3, status: 'CREATED', rawData: { name: 'Divya Reddy', company: 'Reddy Foods' }, leadId: leadId('u3') },
    { id: `${P}row4`, batchId, rowNo: 4, status: 'DUPLICATE', rawData: { name: 'Dev Anand', email: 'dev.anand@anand-steel.example' }, duplicateLeadId: leadId('d1'), error: 'Duplicate of an existing lead' },
    { id: `${P}row5`, batchId, rowNo: 5, status: 'FAILED', rawData: { name: '', email: 'not-an-email' }, error: 'First name is required' },
    { id: `${P}row6`, batchId, rowNo: 6, status: 'SKIPPED', rawData: { name: 'Empty Row' }, error: 'Row skipped' },
  ]);

  // ---- Contacts ---------------------------------------------------------------------------------------
  const contactRows = [
    ['c1', 'Rohan', 'Mehta', 'acme', 'Purchase Head', 'c1'], ['c2', 'Priya', 'Nair', 'globex', 'Procurement Manager', 'c2'],
    ['c3', 'Arjun', 'Rao', 'initech', 'CTO', 'c3'], ['c4', 'Sneha', 'Kulkarni', 'umbrella', 'Operations Lead', 'c4'],
    ['c5', 'Vikram', 'Singh', 'stark', 'Managing Director', 'c5'], ['c6', 'Neha', 'Patel', 'wayne', 'Logistics Head', 'c6'],
    ['x1', 'Karan', 'Bose', 'acme', 'Finance Controller', null], ['x2', 'Lata', 'Shetty', 'initech', 'IT Manager', null],
  ];
  await add('contact', contactRows.map(([k, first, last, o, position, lead], i) => ({
    id: `${P}contact_${k}`, companyId, firstName: first, lastName: last, email: `${first}.${last}@${orgs.find((r) => r[0] === o)[6]}`.toLowerCase(),
    phone: `+91 22 5000 ${2000 + i}`, mobile: `+91 99000 ${10000 + i}`, company: orgs.find((r) => r[0] === o)[1], leadId: lead ? leadId(lead) : undefined,
    organizationId: org(o), position, city: orgs.find((r) => r[0] === o)[3], country: 'India', notes: 'Demo contact',
  })));
  const contact = (k) => `${P}contact_${k}`;
  const digits = (value) => String(value).replace(/\D/g, '');
  await add('crmPhone', [
    ...contactRows.flatMap(([k], i) => [
      { id: `${P}ph_contact_${k}_1`, companyId, contactId: contact(k), number: `+91 99000 ${10000 + i}`, normalized: digits(`+91 99000 ${10000 + i}`), type: 'MOBILE', isPrimary: true },
      { id: `${P}ph_contact_${k}_2`, companyId, contactId: contact(k), number: `+91 22 5000 ${2000 + i}`, normalized: digits(`+91 22 5000 ${2000 + i}`), type: 'WORK', isPrimary: false },
    ]),
    ...orgs.map(([k], i) => ({ id: `${P}ph_org_${k}`, companyId, organizationId: org(k), number: `+91 22 4000 ${1000 + i}`, normalized: digits(`+91 22 4000 ${1000 + i}`), type: 'WORK', isPrimary: true })),
  ]);

  // ---- Opportunities (every stage), items, stage history ----------------------------------------------
  // [key, title, stage, value, probability, org, contact, lead, expectedCloseDays, forecast, extra]
  const oppRows = [
    ['o1', 'Acme - ERP rollout', 'PROSPECTING', 15000, 10, 'acme', 'c1', 'c1', 60, 'PIPELINE', {}],
    ['o2', 'Globex - Inventory and billing', 'QUALIFICATION', 32000, 25, 'globex', 'c2', 'c2', 45, 'PIPELINE', {}],
    ['o3', 'Initech - CRM licences', 'PROPOSAL', 54000, 50, 'initech', 'c3', 'c3', 25, 'BEST_CASE', {}],
    ['o4', 'Umbrella - Compliance module', 'PROPOSAL', 21000, 50, 'umbrella', 'c4', 'c4', 18, 'BEST_CASE', {}],
    ['o5', 'Stark - Shop floor ERP', 'NEGOTIATION', 88000, 75, 'stark', 'c5', 'c5', 9, 'COMMIT', { competitor: 'Zoho' }],
    ['o6', 'Wayne - Fleet and warehouse', 'NEGOTIATION', 46000, 75, 'wayne', 'c6', 'c6', 5, 'COMMIT', {}],
    ['o7', 'Acme - Support renewal', 'CLOSED_WON', 65000, 100, 'acme', 'x1', null, -10, 'CLOSED', { won: 10 }],
    ['o8', 'Initech - Add-on users', 'CLOSED_WON', 27500, 100, 'initech', 'x2', null, -20, 'CLOSED', { won: 20 }],
    ['o9', 'Globex - Custom reports', 'CLOSED_LOST', 39000, 0, 'globex', 'c2', null, -15, 'CLOSED', { lost: 15, reason: 'Price too high', reasonId: `${P}lr1` }],
    ['o10', 'Stark - Training package', 'CLOSED_LOST', 12000, 0, 'stark', 'c5', null, -30, 'CLOSED', { lost: 30, reason: 'Chose a competitor', reasonId: `${P}lr2`, competitor: 'Odoo' }],
  ];
  await add('opportunity', oppRows.map(([k, title, stage, value, probability, o, c, lead, closeDays, forecast, x]) => ({
    id: `${P}opp_${k}`, companyId, branchId, title, leadId: lead ? leadId(lead) : undefined, contactId: contact(c), organizationId: org(o),
    value, currency: 'USD', stage, probability, expectedClose: at(closeDays), forecastCategory: forecast, competitor: x.competitor, ownerId: U,
    lostReasonId: x.reasonId, lostReason: x.reason, wonAt: x.won ? at(-x.won) : undefined, lostAt: x.lost ? at(-x.lost) : undefined, notes: 'Demo opportunity',
    createdAt: at(-(Math.abs(closeDays) + 30)),
  })));
  const itemCatalog = [['ERP-LIC', 'ERP user licence', 12, 100], ['IMPL', 'Implementation services', 40, 60], ['SUPPORT', 'Annual support', 1, 1500]];
  await add('opportunityItem', oppRows.flatMap(([k, , , value], i) => [
    { id: `${P}item_${k}_1`, opportunityId: `${P}opp_${k}`, itemCode: itemCatalog[0][0], description: itemCatalog[0][1], quantity: itemCatalog[0][2], rate: itemCatalog[0][3], discount: i % 3 ? 5 : 0, taxRate: 18, amount: itemCatalog[0][2] * itemCatalog[0][3] * 1.18 },
    { id: `${P}item_${k}_2`, opportunityId: `${P}opp_${k}`, itemCode: itemCatalog[1][0], description: itemCatalog[1][1], quantity: itemCatalog[1][2], rate: itemCatalog[1][3], discount: 0, taxRate: 18, amount: itemCatalog[1][2] * itemCatalog[1][3] * 1.18 },
  ]));
  const stageOrder = ['PROSPECTING', 'QUALIFICATION', 'PROPOSAL', 'NEGOTIATION'];
  const stageProb = { PROSPECTING: 10, QUALIFICATION: 25, PROPOSAL: 50, NEGOTIATION: 75, CLOSED_WON: 100, CLOSED_LOST: 0 };
  const history = [];
  oppRows.forEach(([k, , stage, , , , , , closeDays]) => {
    const path = stage === 'CLOSED_WON' ? [...stageOrder, 'CLOSED_WON'] : stage === 'CLOSED_LOST' ? [...stageOrder.slice(0, 3), 'CLOSED_LOST'] : stageOrder.slice(0, stageOrder.indexOf(stage) + 1);
    const start = -(Math.abs(closeDays) + 30);
    path.forEach((to, i) => history.push({
      id: `${P}hist_${k}_${i}`, companyId, opportunityId: `${P}opp_${k}`, fromStage: i ? path[i - 1] : null, toStage: to, probability: stageProb[to],
      changedById: U, reason: i ? 'Moved forward' : 'Opportunity created', changedAt: at(start + i * 7),
    }));
  });
  await add('opportunityStageHistory', history);

  // ---- Activities (today, overdue, upcoming, completed, recurring) ------------------------------------
  const act = (k, type, subject, status, dueDays, dueHours, links, x = {}) => ({
    id: `${P}act_${k}`, companyId, branchId, type, subject, description: x.description || `${subject} (demo)`, status,
    dueDate: dueDays === null ? undefined : at(dueDays, dueHours), completedAt: status === 'COMPLETED' ? at(dueDays, dueHours) : undefined,
    outcome: x.outcome, reminderAt: x.reminder, recurrenceRule: x.rule, recurrenceEnd: x.ruleEnd, userId: U, ...links,
  });
  await add('activity', [
    act('a1', 'CALL', 'Intro call with new website lead', 'PLANNED', 0, 2, { leadId: leadId('n1') }, { reminder: at(0, 1) }),
    act('a2', 'MEETING', 'Proposal walkthrough - Initech', 'PLANNED', 0, 5, { opportunityId: `${P}opp_o3`, contactId: contact('c3'), organizationId: org('initech') }),
    act('a3', 'TASK', 'Send revised quote to Stark', 'IN_PROGRESS', 0, 6, { opportunityId: `${P}opp_o5`, contactId: contact('c5') }),
    act('a4', 'FOLLOW_UP', 'Follow up on IndiaMART enquiry', 'OPEN', -1, 0, { leadId: leadId('n3') }),
    act('a5', 'CALL', 'Callback - Desai Chemicals', 'OPEN', -3, 0, { leadId: leadId('k2') }),
    act('a6', 'EMAIL', 'Share brochure with Verma Electricals', 'OPEN', -6, 0, { leadId: leadId('q1') }),
    act('a7', 'MEETING', 'Contract review - Wayne', 'PLANNED', 2, 4, { opportunityId: `${P}opp_o6`, contactId: contact('c6'), organizationId: org('wayne') }),
    act('a8', 'CALL', 'Qualification call - Kapoor Auto', 'PLANNED', 3, 3, { leadId: leadId('q3') }, { reminder: at(3, 2) }),
    act('a9', 'TASK', 'Prepare demo environment', 'PLANNED', 5, 8, { opportunityId: `${P}opp_o4` }),
    act('a10', 'MEETING', 'Quarterly review - Acme', 'PLANNED', 9, 5, { organizationId: org('acme'), contactId: contact('x1') }),
    act('a11', 'CALL', 'Discovery call - Acme', 'COMPLETED', -40, 3, { leadId: leadId('c1'), organizationId: org('acme') }, { outcome: 'Interested, asked for a proposal' }),
    act('a12', 'EMAIL', 'Proposal sent - Globex', 'COMPLETED', -26, 2, { opportunityId: `${P}opp_o2`, contactId: contact('c2') }, { outcome: 'Awaiting feedback' }),
    act('a13', 'MEETING', 'On-site visit - Stark', 'COMPLETED', -12, 4, { opportunityId: `${P}opp_o5`, organizationId: org('stark') }, { outcome: 'Requirements confirmed' }),
    act('a14', 'NOTE', 'Customer prefers quarterly billing', 'COMPLETED', -8, 1, { opportunityId: `${P}opp_o7`, organizationId: org('acme') }),
    act('a15', 'FOLLOW_UP', 'Weekly pipeline sync', 'PLANNED', 1, 3, { organizationId: org('initech') }, { rule: 'WEEKLY', ruleEnd: at(60) }),
    act('a16', 'CALL', 'Call cancelled - prospect travelling', 'CANCELLED', -2, 2, { leadId: leadId('k1') }),
  ]);
  await add('activityAttendee', [
    { id: `${P}att1`, activityId: `${P}act_a2`, userId: U, name: `${user.firstName} ${user.lastName}`, email: user.email, response: 'ACCEPTED' },
    { id: `${P}att2`, activityId: `${P}act_a2`, name: 'Arjun Rao', email: 'arjun.rao@initech-software.example', response: 'PENDING' },
    { id: `${P}att3`, activityId: `${P}act_a10`, name: 'Karan Bose', email: 'karan.bose@acme-industries.example', response: 'ACCEPTED' },
  ]);

  // ---- Lead timeline events ---------------------------------------------------------------------------
  const ev = (leadKey, i, type, subject, ago, data) => ({ id: `${P}ev_${leadKey}_${i}`, companyId, leadId: leadId(leadKey), type, actorId: U, subject, data, occurredAt: at(-ago) });
  await add('crmLeadEvent', [
    ev('c1', 1, 'CREATED', 'Lead created', 50, { source: 'REFERRAL' }), ev('c1', 2, 'ASSIGNMENT', 'Lead assigned', 49, { to: U }),
    ev('c1', 3, 'STATUS_CHANGE', 'Status changed to QUALIFIED', 44, { from: 'CONTACTED', to: 'QUALIFIED' }),
    ev('c1', 4, 'CONVERSION', 'Lead converted to opportunity', 42, { opportunityId: `${P}opp_o1` }),
    ev('q1', 1, 'CREATED', 'Lead created', 20, { source: 'EMAIL' }), ev('q1', 2, 'STATUS_CHANGE', 'Status changed to CONTACTED', 15, { from: 'NEW', to: 'CONTACTED' }),
    ev('q1', 3, 'NOTE', 'Asked for pricing and a demo', 12, { note: 'Asked for pricing and a demo' }), ev('q1', 4, 'STATUS_CHANGE', 'Status changed to QUALIFIED', 4, { from: 'CONTACTED', to: 'QUALIFIED' }),
    ev('d1', 1, 'CREATED', 'Lead created', 4, { source: 'WEBSITE' }), ev('d2', 1, 'CREATED', 'Lead created via WhatsApp', 1, { source: 'WHATSAPP' }),
    ev('k3', 1, 'IMPORT', 'Imported from demo-leads-q3.csv', 11, { batchId }), ev('u2', 1, 'STATUS_CHANGE', 'Marked unqualified: No budget', 20, { reason: 'No budget' }),
  ]);

  // ---- Assignment rules, scope, saved views -----------------------------------------------------------
  await add('crmAssignmentRule', [
    { id: `${P}rule1`, companyId, name: 'IndiaMART leads', priority: 10, source: 'INDIA_MART', assignToId: U },
    { id: `${P}rule2`, companyId, name: 'Mumbai and West territory', priority: 20, city: 'Mumbai', territory: 'West', assignToId: U },
    { id: `${P}rule3`, companyId, name: 'High value deals (50,000+)', priority: 30, minValue: 50000, assignToId: U },
    { id: `${P}rule4`, companyId, name: 'Facebook campaigns (paused)', priority: 40, isActive: false, source: 'FACEBOOK_LEAD_ADS', assignToId: U },
  ]);
  await add('crmScopeRule', [
    { id: `${P}scope1`, companyId, userId: U, entity: 'LEAD', scope: 'ALL' },
    { id: `${P}scope2`, companyId, userId: U, entity: 'OPPORTUNITY', scope: 'ALL' },
  ]);
  await add('crmSavedView', [
    { id: `${P}view1`, companyId, userId: U, name: 'New leads', entity: 'LEAD', filters: { status: 'NEW' }, isDefault: true },
    { id: `${P}view2`, companyId, userId: U, name: 'Hot leads', entity: 'LEAD', filters: { priority: 'HIGH' } },
    { id: `${P}view3`, companyId, userId: U, name: 'Closing this month', entity: 'OPPORTUNITY', filters: { stage: 'NEGOTIATION' } },
  ]);

  // ---- Email templates and communications -------------------------------------------------------------
  await add('crmEmailTemplate', [
    { id: `${P}tpl1`, companyId, name: 'Welcome new lead', subject: 'Thanks for reaching out, {{firstName}}', bodyHtml: '<p>Hi {{firstName}},</p><p>Thanks for your interest. We will call you shortly.</p>', bodyText: 'Hi {{firstName}}, thanks for your interest. We will call you shortly.', createdById: U },
    { id: `${P}tpl2`, companyId, name: 'Follow up after demo', subject: 'Following up on our demo', bodyHtml: '<p>Hi {{firstName}},</p><p>Do you have any questions after the demo?</p>', bodyText: 'Hi {{firstName}}, do you have any questions after the demo?', createdById: U },
    { id: `${P}tpl3`, companyId, name: 'Proposal sent', subject: 'Your proposal from Orus', bodyHtml: '<p>Hi {{firstName}},</p><p>Please find the proposal attached.</p>', bodyText: 'Hi {{firstName}}, please find the proposal attached.', createdById: U },
  ]);
  await add('crmCommunication', [
    { id: `${P}com1`, companyId, leadId: leadId('c1'), channel: 'EMAIL', direction: 'OUTBOUND', provider: 'demo', externalId: 'demo-mail-1', threadId: 'demo-thread-1', fromAddress: user.email, toAddress: 'rohan.mehta@acme-industries.example', subject: 'Welcome to Orus', body: 'Thanks for your interest.', status: 'DELIVERED', sentById: U, sentAt: at(-49), deliveredAt: at(-49) },
    { id: `${P}com2`, companyId, leadId: leadId('c1'), channel: 'EMAIL', direction: 'INBOUND', provider: 'demo', externalId: 'demo-mail-2', threadId: 'demo-thread-1', fromAddress: 'rohan.mehta@acme-industries.example', toAddress: user.email, subject: 'Re: Welcome to Orus', body: 'Please share the pricing.', status: 'RECEIVED', sentAt: at(-48) },
    { id: `${P}com3`, companyId, leadId: leadId('q1'), channel: 'EMAIL', direction: 'OUTBOUND', provider: 'demo', externalId: 'demo-mail-3', fromAddress: user.email, toAddress: 'sanjay.verma@verma-electricals.example', subject: 'Brochure', body: 'Brochure attached.', status: 'READ', sentById: U, sentAt: at(-6), deliveredAt: at(-6), readAt: at(-5) },
    { id: `${P}com4`, companyId, leadId: leadId('n3'), channel: 'WHATSAPP', direction: 'OUTBOUND', provider: 'demo', externalId: 'demo-wa-1', toAddress: '+919800000013', body: 'Hi Kabir, thanks for your IndiaMART enquiry.', status: 'SENT', sentById: U, sentAt: at(-2) },
    { id: `${P}com5`, companyId, leadId: leadId('d2'), channel: 'WHATSAPP', direction: 'INBOUND', provider: 'demo', externalId: 'demo-wa-2', fromAddress: '+919820011111', toAddress: '+919000000000', body: 'Can I get a callback?', status: 'RECEIVED', sentAt: at(-1) },
    { id: `${P}com6`, companyId, opportunityId: `${P}opp_o3`, contactId: contact('c3'), channel: 'EMAIL', direction: 'OUTBOUND', provider: 'demo', externalId: 'demo-mail-4', fromAddress: user.email, toAddress: 'arjun.rao@initech-software.example', subject: 'Proposal', body: 'Proposal attached.', status: 'FAILED', error: 'Mailbox unavailable (demo)', sentById: U },
    { id: `${P}com7`, companyId, leadId: leadId('k1'), channel: 'EMAIL', direction: 'OUTBOUND', provider: 'demo', externalId: 'demo-mail-5', fromAddress: user.email, toAddress: 'meera.iyer@iyer-exports.example', subject: 'Intro', body: 'Introduction.', status: 'QUEUED', sentById: U },
  ]);

  // ---- Capture token (to try the public capture endpoints) --------------------------------------------
  await add('crmCaptureToken', [
    { id: `${P}tok1`, companyId, name: 'Demo website form', tokenHash: sha256(DEMO_CAPTURE_TOKEN), source: 'WEBSITE', createdById: U },
  ]);

  console.log(`Seeded CRM demo data into "${company.name}" (${company.slug}), owner ${user.email}`);
  console.table(counts);
  console.log(`\nCapture token for the public endpoints: ${DEMO_CAPTURE_TOKEN}`);
  console.log('  POST /api/v1/crm/capture/web-to-lead   header: x-capture-token');
  console.log(`Customer numbers for Convert start after ${FIRST_SAFE_NUMBER} (no clash with other companies).`);
  console.log('Not seeded: integration accounts (they hold credentials) and export jobs.');
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => prisma.$disconnect());
