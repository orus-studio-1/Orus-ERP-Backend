import prisma from '../lib/prisma';
import { currentCompanyId } from './tenant';

function tenantPrefix() {
  return (currentCompanyId() || 'GLOBAL').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
}

export async function generateInvoiceNo(): Promise<string> {
  const count = await prisma.salesInvoice.count();
  return `${tenantPrefix()}-INV-${String(count + 1).padStart(6, '0')}`;
}

export async function generateOrderNo(): Promise<string> {
  const count = await prisma.salesOrder.count();
  return `${tenantPrefix()}-SO-${String(count + 1).padStart(6, '0')}`;
}

export async function generatePONo(): Promise<string> {
  const count = await prisma.purchaseOrder.count();
  return `${tenantPrefix()}-PO-${String(count + 1).padStart(6, '0')}`;
}

export async function generateQuotationNo(): Promise<string> {
  const count = await prisma.quotation.count();
  return `${tenantPrefix()}-QT-${String(count + 1).padStart(6, '0')}`;
}

export async function generateCustomerNo(): Promise<string> {
  const count = await prisma.customer.count();
  return `${tenantPrefix()}-CUST-${String(count + 1).padStart(5, '0')}`;
}

export async function generateSupplierNo(): Promise<string> {
  const count = await prisma.supplier.count();
  return `${tenantPrefix()}-SUPP-${String(count + 1).padStart(5, '0')}`;
}

export async function generateEmployeeId(): Promise<string> {
  const count = await prisma.employee.count();
  return `${tenantPrefix()}-EMP-${String(count + 1).padStart(5, '0')}`;
}

export async function generateJournalNo(): Promise<string> {
  const count = await prisma.journalEntry.count();
  return `${tenantPrefix()}-JE-${String(count + 1).padStart(6, '0')}`;
}

export async function generatePaymentNo(): Promise<string> {
  const count = await prisma.payment.count();
  return `${tenantPrefix()}-PAY-${String(count + 1).padStart(6, '0')}`;
}

export async function generatePurchaseInvoiceNo(): Promise<string> {
  const count = await prisma.purchaseInvoice.count();
  return `${tenantPrefix()}-PINV-${String(count + 1).padStart(6, '0')}`;
}
