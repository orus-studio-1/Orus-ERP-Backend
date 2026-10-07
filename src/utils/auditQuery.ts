// Business-event rows are written with a bare entityType (e.g. SALES_INVOICE, RFQ, ACCESS) instead
// of the automatic MODULE:RESOURCE prefix, so the module filter has to know which module owns them.
// Every DocumentType value (legacy AuditLog rows are backfilled with it as the entityType) must be
// listed here, otherwise those rows can never be found by the module filter; auditQuery.test.ts
// fails when a new DocumentType is added without being mapped.
export const bareEntityTypesByModule: Record<string, string[]> = {
  INVOICING: ['SALES_INVOICE', 'DELIVERY_NOTE', 'CREDIT_NOTE', 'PAYMENT_ENTRY', 'PAYMENT'],
  PROCUREMENT: ['RFQ', 'REQUEST_FOR_QUOTATION', 'SUPPLIER_QUOTATION', 'PURCHASE_ORDER', 'PURCHASE_INVOICE', 'PURCHASE_RECEIPT', 'MATERIAL_REQUEST', 'LANDED_COST_VOUCHER', 'BLANKET_PURCHASE_ORDER', 'QUALITY_INSPECTION', 'BUYING_SETTINGS', 'SUPPLIER_PAYMENT'],
  SALES: ['QUOTATION', 'SALES_ORDER'],
  INVENTORY: ['STOCK_ENTRY'],
  HR: ['EMPLOYEE', 'ATTENDANCE', 'LEAVE_APPLICATION', 'PAYROLL_ENTRY', 'SALARY_SLIP', 'EMPLOYEE_LIFECYCLE'],
  ACCOUNTING: ['JOURNAL_ENTRY'],
  CUSTOMERS: ['CUSTOMER'],
  SUPPLIERS: ['SUPPLIER'],
  ACCESS: ['ACCESS'],
};

// The automatic row is named after the first URL segment, so a router mounted under another name
// (/api/invoices, /api/payments, /api/delivery-notes, /api/products, /api/sales-orders) writes
// INVOICES:..., PAYMENTS:... and so on. Those prefixes belong to the module that owns the router.
// auditQuery.test.ts checks every mount in index.ts is either a module option or listed here.
export const prefixAliasesByModule: Record<string, string[]> = {
  INVOICING: ['INVOICES', 'PAYMENTS', 'DELIVERY-NOTES'],
  INVENTORY: ['PRODUCTS'],
  SALES: ['SALES-ORDERS'],
};

export function moduleAuditWhere(moduleName: string) {
  const upper = moduleName.toUpperCase();
  const bareTypes = bareEntityTypesByModule[upper] || [];
  const prefixes = [upper, ...(prefixAliasesByModule[upper] || [])];
  return {
    OR: [
      ...prefixes.map((prefix) => ({ entityType: { startsWith: `${prefix}:` } })),
      { entityType: moduleName.toLowerCase() },
      ...(bareTypes.length ? [{ entityType: { in: bareTypes } }] : []),
    ],
  };
}
