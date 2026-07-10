import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';

dotenv.config();

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
import { runDueSubscriptionsJob } from './controllers/invoicingExtras.controller';

const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', authRoutes);
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

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date(), version: '1.0.0' });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Orus ERP Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
});

if (process.env.ENABLE_RECURRING_INVOICE_SCHEDULER === 'true') {
  setInterval(() => {
    runDueSubscriptionsJob().catch((err) => console.error('Recurring invoice scheduler failed', err));
  }, 60 * 60 * 1000);
}

export default app;
