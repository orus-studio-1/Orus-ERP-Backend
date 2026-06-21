import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { success, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';

export const getDashboardStats = async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    const [
      totalRevenue,
      totalExpenses,
      pendingInvoicesData,
      activeCustomers,
      activeEmployees,
      openLeads,
      pendingTasks,
      lowStockProducts,
      recentInvoices,
      recentLeads,
      monthlyRevenue,
    ] = await Promise.all([
      prisma.salesInvoice.aggregate({
        where: { status: 'PAID' },
        _sum: { total: true },
      }),
      prisma.purchaseInvoice.aggregate({
        where: { status: 'PAID' },
        _sum: { total: true },
      }),
      prisma.salesInvoice.aggregate({
        where: { status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] } },
        _sum: { total: true },
        _count: true,
      }),
      prisma.customer.count({ where: { isActive: true } }),
      prisma.employee.count({ where: { status: 'ACTIVE' } }),
      prisma.lead.count({ where: { status: { in: ['NEW', 'CONTACTED', 'QUALIFIED'] } } }),
      prisma.task.count({ where: { status: { in: ['TODO', 'IN_PROGRESS'] } } }),
      prisma.product.findMany({
        where: { isActive: true },
        include: { stockLevels: true },
        take: 50,
      }),
      prisma.salesInvoice.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: { customer: { select: { name: true } } },
      }),
      prisma.lead.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: { id: true, firstName: true, lastName: true, company: true, status: true, createdAt: true },
      }),
      prisma.$queryRaw`
        SELECT
          DATE_TRUNC('month', "createdAt") as month,
          SUM(total) as revenue
        FROM "SalesInvoice"
        WHERE status = 'PAID' AND "createdAt" >= ${startOfYear}
        GROUP BY DATE_TRUNC('month', "createdAt")
        ORDER BY month ASC
      `,
    ]);

    const lowStock = lowStockProducts.filter(p => {
      const totalQty = p.stockLevels.reduce((sum, sl) => sum + sl.quantity, 0);
      return totalQty <= p.minStockLevel;
    }).slice(0, 10);

    return success(res, {
      revenue: {
        total: totalRevenue._sum.total || 0,
        thisMonth: 0,
      },
      expenses: {
        total: totalExpenses._sum.total || 0,
      },
      pendingInvoices: {
        count: pendingInvoicesData._count,
        amount: pendingInvoicesData._sum.total || 0,
      },
      activeCustomers,
      activeEmployees,
      openLeads,
      pendingTasks,
      lowStock: lowStock.map(p => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        currentStock: p.stockLevels.reduce((sum, sl) => sum + sl.quantity, 0),
        minStockLevel: p.minStockLevel,
      })),
      recentInvoices,
      recentLeads,
      monthlyRevenue,
    });
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

