// Business-event rows are written with a bare entityType (e.g. SALES_INVOICE, RFQ, ACCESS) instead
// of the automatic MODULE:RESOURCE prefix, so the module filter has to know which module owns them.
export const bareEntityTypesByModule: Record<string, string[]> = {
  INVOICING: ['SALES_INVOICE', 'DELIVERY_NOTE', 'CREDIT_NOTE', 'PAYMENT_ENTRY'],
  PROCUREMENT: ['RFQ', 'REQUEST_FOR_QUOTATION', 'SUPPLIER_QUOTATION', 'PURCHASE_ORDER', 'PURCHASE_INVOICE', 'PURCHASE_RECEIPT', 'MATERIAL_REQUEST', 'LANDED_COST_VOUCHER'],
  SALES: ['QUOTATION', 'SALES_ORDER'],
  INVENTORY: ['STOCK_ENTRY'],
  ACCESS: ['ACCESS'],
};

export function moduleAuditWhere(moduleName: string) {
  const upper = moduleName.toUpperCase();
  const bareTypes = bareEntityTypesByModule[upper] || [];
  return {
    OR: [
      { entityType: { startsWith: `${upper}:` } },
      { entityType: moduleName.toLowerCase() },
      ...(bareTypes.length ? [{ entityType: { in: bareTypes } }] : []),
    ],
  };
}
