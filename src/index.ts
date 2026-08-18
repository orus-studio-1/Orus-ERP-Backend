import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
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
import { runDueSubscriptionsJob } from './controllers/invoicingExtras.controller';
import prisma from './lib/prisma';

const app = express();

app.use(helmet());
const normalizeOrigin = (value: string) => value.trim().replace(/\/$/, '');
const configuredOrigins = [process.env.FRONTEND_URL, process.env.CORS_ORIGINS]
  .filter(Boolean)
  .flatMap((value) => String(value).split(','))
  .map(normalizeOrigin)
  .filter(Boolean);
const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://localhost:8081',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8081',
  'https://erp-frontend-green.vercel.app',
  ...configuredOrigins,
]);

app.use(cors({
  origin: (origin, callback) => {
    const isLocalDevelopmentOrigin = (() => {
      if (process.env.NODE_ENV === 'production' || !origin) return false;
      try {
        const hostname = new URL(origin).hostname;
        return hostname === 'localhost' || hostname === '127.0.0.1';
      } catch { return false; }
    })();
    if (!origin || allowedOrigins.has(normalizeOrigin(origin)) || isLocalDevelopmentOrigin) {
      return callback(null, true);
    }
    return callback(new Error('Origin is not allowed by CORS'));
  },
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

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

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`Orus ERP Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});

if (process.env.ENABLE_RECURRING_INVOICE_SCHEDULER === 'true') {
  setInterval(() => {
    runDueSubscriptionsJob().catch((err) => console.error('Recurring invoice scheduler failed', err));
  }, 60 * 60 * 1000);
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
