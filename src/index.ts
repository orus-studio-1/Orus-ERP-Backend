import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be configured with at least 32 characters');
}

import authRoutes from './routes/auth.routes';
import accountingRoutes from './routes/accounting.routes';
import inventoryRoutes from './routes/inventory.routes';
import hrRoutes from './routes/hr.routes';
import crmRoutes from './routes/crm.routes';
import salesRoutes from './routes/sales.routes';
import invoicingRoutes from './routes/invoicing.routes';
import invoicingExtrasRoutes from './routes/invoicing-extras.routes';
import invoicesRoutes from './routes/invoices.routes';
import paymentsRoutes from './routes/payments.routes';
import productsRoutes from './routes/products.routes';
import salesOrdersRoutes from './routes/sales-orders.routes';
import deliveryNotesRoutes from './routes/delivery-notes.routes';
import procurementRoutes from './routes/procurement.routes';
import projectsRoutes from './routes/projects.routes';
import customersRoutes from './routes/customers.routes';
import suppliersRoutes from './routes/suppliers.routes';
import dashboardRoutes from './routes/dashboard.routes';
import accessRoutes from './routes/access.routes';
import notificationRoutes from './routes/notifications.routes';
import platformRoutes from './routes/platform.routes';
import manufacturingRoutes from './routes/manufacturing.routes';
import { idempotency, mutationAudit, requestContext } from './middleware/platform';
import { runDueSubscriptionsJob } from './controllers/invoicingExtras.controller';
import prisma from './lib/prisma';
import { buildCorsOptions } from './config/cors';
import { workOne } from './services/platform/job.service';
import { processCrmReminders } from './services/crm/jobs';
import { processSalesExpiry } from './services/sales/jobs';
import { processInventoryMonitoring } from './services/inventory/jobs';
import { processProcurementMonitoring } from './services/procurement/jobs';
import { markExpiredBills } from './services/eway/ewayBill.service';
import { runEInvoiceSweep } from './services/einvoice/einvoiceJobs';

const app = express();
app.set('trust proxy', 1);

app.use(helmet());

app.use(cors(buildCorsOptions()));

app.use(morgan('dev'));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// Express 5 leaves req.body undefined for a request that sends no body (a POST with only an id in the URL,
// like creating a delivery or an invoice from a sales order), so handlers reading req.body.items crashed.
app.use((req, _res, next) => { req.body ??= {}; next(); });
app.use(requestContext);
app.use(mutationAudit);

app.use('/api/auth', authRoutes);
app.use('/api/access', accessRoutes);
app.use('/api/accounting', accountingRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/hr', hrRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/invoicing', invoicingRoutes);
app.use('/api/invoicing', invoicingExtrasRoutes);
app.use('/api/invoices', invoicesRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/sales-orders', salesOrdersRoutes);
app.use('/api/delivery-notes', deliveryNotesRoutes);
app.use('/api/procurement', procurementRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationRoutes);
// Compatibility for clients configured with a legacy base URL ending in /api.
// The canonical route remains /api/v1/platform.
app.use('/api/platform', platformRoutes);
app.use('/api/manufacturing', manufacturingRoutes);

// Versioned API is canonical. Legacy /api mounts remain during client migration.
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/access', accessRoutes);
app.use('/api/v1/accounting', accountingRoutes);
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api/v1/hr', hrRoutes);
app.use('/api/v1/crm', crmRoutes);
app.use('/api/v1/sales', salesRoutes);
app.use('/api/v1/invoicing', invoicingRoutes);
app.use('/api/v1/invoicing', invoicingExtrasRoutes);
app.use('/api/v1/invoices', invoicesRoutes);
app.use('/api/v1/payments', paymentsRoutes);
app.use('/api/v1/products', productsRoutes);
app.use('/api/v1/sales-orders', salesOrdersRoutes);
app.use('/api/v1/delivery-notes', deliveryNotesRoutes);
app.use('/api/v1/procurement', procurementRoutes);
app.use('/api/v1/projects', projectsRoutes);
app.use('/api/v1/customers', customersRoutes);
app.use('/api/v1/suppliers', suppliersRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/platform', platformRoutes);
app.use('/api/v1/manufacturing', manufacturingRoutes);

app.get('/health', (req, res) => {
  prisma.$queryRaw`SELECT 1`
    .then(() => res.json({ status: 'OK', database: 'OK', timestamp: new Date(), version: '1.0.0' }))
    .catch(() => res.status(503).json({ status: 'DEGRADED', database: 'UNAVAILABLE', timestamp: new Date(), version: '1.0.0' }));
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled request error:', err);
  if (res.headersSent) return;
  res.status(err?.message === 'Origin is not allowed by CORS' ? 403 : 500).json({
    success: false,
    message: err?.message === 'Origin is not allowed by CORS' ? err.message : 'Internal server error',
  });
});

const PORT = Number(process.env.PORT || 5000);
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`Orus ERP Server running at http://${HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  const detail = err.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use. Stop the existing process or set a different PORT.`
    : err.code === 'EACCES' || err.code === 'EPERM'
      ? `Cannot bind to ${HOST}:${PORT}. Check host permissions or use HOST=127.0.0.1.`
      : err.message;
  console.error(`HTTP server failed to start: ${detail}`);
  process.exitCode = 1;
});

if (process.env.ENABLE_RECURRING_INVOICE_SCHEDULER === 'true') {
  setInterval(() => {
    runDueSubscriptionsJob().catch((err) => console.error('Recurring invoice scheduler failed', err));
  }, 60 * 60 * 1000);
}

if (process.env.ENABLE_BACKGROUND_WORKER !== 'false') {
  setInterval(() => workOne().catch((err) => console.error('Background job worker failed', err)), 5_000);
  setInterval(() => processCrmReminders().catch((err) => console.error('CRM reminder worker failed', err)), 60_000);
  setInterval(() => processSalesExpiry().catch((err) => console.error('Sales expiry worker failed', err)), 60_000);
  setInterval(() => processInventoryMonitoring().catch((err) => console.error('Inventory monitoring worker failed', err)), 60 * 60 * 1000);
  setInterval(() => markExpiredBills().catch((err) => console.error('E-way bill expiry sweep failed', err)), 60 * 60 * 1000);
  setInterval(() => runEInvoiceSweep().catch((err) => console.error('E-invoice sweep failed', err)), 60 * 60 * 1000);
  setInterval(() => processProcurementMonitoring().catch((err) => console.error('Procurement monitoring worker failed', err)), 60 * 60 * 1000);
}

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received; closing HTTP server`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('uncaughtException');
});

export default app;
