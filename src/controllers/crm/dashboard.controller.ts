import { Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { success } from '../../utils/response';
import { handlePrismaError } from '../../utils/prismaError';

export const getCrmDashboard = async (_req: Request, res: Response) => {
  try {
    const [leads, opportunities, activities] = await Promise.all([
      prisma.lead.groupBy({ by: ['status'], _count: { id: true } }),
      prisma.opportunity.findMany({ select: { stage: true, value: true, probability: true, expectedClose: true } }),
      prisma.activity.findMany({
        where: { status: { in: ['PLANNED', 'IN_PROGRESS'] } },
        include: { lead: { select: { title: true } }, opportunity: { select: { title: true } } },
        orderBy: { dueDate: 'asc' },
        take: 10,
      }),
    ]);

    const leadCounts = Object.fromEntries(leads.map((row) => [row.status, row._count.id]));
    const pipeline = opportunities.reduce((acc: any, opp) => {
      const row = acc[opp.stage] || { count: 0, value: 0, weightedValue: 0 };
      row.count += 1;
      row.value += Number(opp.value || 0);
      row.weightedValue += Number(opp.value || 0) * (Number(opp.probability || 0) / 100);
      acc[opp.stage] = row;
      return acc;
    }, {});
    const won = pipeline.CLOSED_WON?.count || 0;
    const lost = pipeline.CLOSED_LOST?.count || 0;
    const converted = leadCounts.CONVERTED || 0;
    const totalLeads = Object.values(leadCounts).reduce((sum: number, value: any) => sum + Number(value || 0), 0);

    return success(res, {
      leadCounts,
      totalLeads,
      conversionRate: totalLeads ? Math.round((converted / totalLeads) * 100) : 0,
      winRate: won + lost ? Math.round((won / (won + lost)) * 100) : 0,
      pipeline,
      openPipelineValue: Object.entries(pipeline)
        .filter(([stage]) => !['CLOSED_WON', 'CLOSED_LOST'].includes(stage))
        .reduce((sum, [, row]: any) => sum + row.value, 0),
      upcomingActivities: activities,
    });
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};
