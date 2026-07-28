import { AsyncLocalStorage } from 'async_hooks';

type TenantContext = { companyId?: string | null };

const tenantStorage = new AsyncLocalStorage<TenantContext>();

export const tenantModels = new Set([
  'Account',
  'FiscalYear',
  'JournalEntry',
  'NumberingSeries',
  'Category',
  'Unit',
  'Product',
  'Warehouse',
  'StockLevel',
  'StockMovement',
  'StockLedgerEntry',
  'InventoryValuationLayer',
  'StockReservation',
  'StockEntry',
  'Batch',
  'SerialNumber',
  'PriceList',
  'ItemPrice',
  'PricingRule',
  'Department',
  'Position',
  'Customer',
  'Supplier',
  'Quotation',
  'SalesOrder',
  'SalesInvoice',
  'DeliveryNote',
  'TaxTemplate',
  'Payment',
  'PaymentEntry',
  'CreditNote',
  'GeneralLedgerEntry',
  'Budget',
  'BankStatementLine',
  'PrintFormat',
  'SubscriptionTemplate',
  'AuditLog',
  'PurchaseOrder',
  'PurchaseInvoice',
  'BuyingSettings',
  'PaymentTermsTemplate',
  'SupplierItem',
  'MaterialRequest',
  'RequestForQuotation',
  'SupplierQuotation',
  'BlanketPurchaseOrder',
  'PurchaseReceipt',
  'QualityInspection',
  'LandedCostVoucher',
  'SupplierPayment',
  'SupplierCommunicationLog',
  'Lead',
  'Contact',
  'Opportunity',
  'Activity',
  'CrmOrganization',
  'CrmAssignmentRule',
  'LeadImportBatch',
  'CrmSavedView',
]);
const normalizedTenantModels = new Set(Array.from(tenantModels).map((model) => model.toLowerCase()));

const readOperations = new Set(['findMany', 'findFirst', 'findUnique', 'count', 'aggregate', 'groupBy']);

export function runWithTenant<T>(companyId: string | null | undefined, callback: () => T) {
  return tenantStorage.run({ companyId }, callback);
}

export function currentCompanyId() {
  return tenantStorage.getStore()?.companyId || null;
}

export function tenantWhere(companyId: string | null | undefined) {
  return companyId ? { companyId } : {};
}

export function applyTenantToPrismaArgs(model: string | undefined, operation: string, args: any) {
  const companyId = currentCompanyId();
  if (!companyId || !model || !normalizedTenantModels.has(model.toLowerCase())) return args;

  if (readOperations.has(operation)) {
    return { ...args, where: { ...(args?.where || {}), companyId } };
  }

  if (operation === 'create') {
    return { ...args, data: { ...(args?.data || {}), companyId: args?.data?.companyId || companyId } };
  }

  if (operation === 'createMany') {
    const data = Array.isArray(args?.data) ? args.data : [];
    return { ...args, data: data.map((row: any) => ({ ...row, companyId: row.companyId || companyId })) };
  }

  if (['update', 'delete', 'updateMany', 'deleteMany'].includes(operation)) {
    return { ...args, where: { ...(args?.where || {}), companyId } };
  }

  if (operation === 'upsert') {
    return {
      ...args,
      where: { ...(args?.where || {}), companyId },
      create: { ...(args?.create || {}), companyId: args?.create?.companyId || companyId },
    };
  }

  return args;
}
