import { Request, Response } from 'express';
import prisma from '../lib/prisma';
import { success, paginated, error } from '../utils/response';
import { handlePrismaError } from '../utils/prismaError';
import { AuthRequest } from '../middleware/auth';

// ---- PROJECTS ----
export const getProjects = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const { status, search } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (search) where.name = { contains: search, mode: 'insensitive' };

    const [items, total] = await Promise.all([
      prisma.project.findMany({
        where,
        include: {
          members: { include: { project: false } },
          _count: { select: { tasks: true, milestones: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.project.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getProject = async (req: Request, res: Response) => {
  try {
    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: {
        tasks: { include: { assignee: { select: { firstName: true, lastName: true } } }, orderBy: { createdAt: 'desc' } },
        milestones: { orderBy: { dueDate: 'asc' } },
        documents: true,
        members: true,
      },
    });
    if (!project) return error(res, 'Project not found', 404);
    return success(res, project);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createProject = async (req: Request, res: Response) => {
  try {
    const { name, description, status, priority, startDate, endDate, budget } = req.body;
    const project = await prisma.project.create({
      data: {
        name, description, status, priority,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        budget,
      },
    });
    return success(res, project, 'Project created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateProject = async (req: Request, res: Response) => {
  try {
    const project = await prisma.project.update({ where: { id: req.params.id }, data: req.body });
    return success(res, project, 'Project updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteProject = async (req: Request, res: Response) => {
  try {
    await prisma.project.delete({ where: { id: req.params.id } });
    return success(res, null, 'Project deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const addProjectMember = async (req: Request, res: Response) => {
  try {
    const { userId, role } = req.body;
    const member = await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: req.params.id, userId } },
      update: { role },
      create: { projectId: req.params.id, userId, role },
    });
    return success(res, member, 'Member added');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const removeProjectMember = async (req: Request, res: Response) => {
  try {
    await prisma.projectMember.delete({
      where: { projectId_userId: { projectId: req.params.id, userId: req.params.userId } },
    });
    return success(res, null, 'Member removed');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- TASKS ----
export const getTasks = async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;
    const { projectId, status, assigneeId, priority } = req.query as any;
    const where: any = { parentId: null };
    if (projectId) where.projectId = projectId;
    if (status) where.status = status;
    if (assigneeId) where.assigneeId = assigneeId;
    if (priority) where.priority = priority;

    const [items, total] = await Promise.all([
      prisma.task.findMany({
        where,
        include: {
          assignee: { select: { firstName: true, lastName: true, avatar: true } },
          creator: { select: { firstName: true, lastName: true } },
          subtasks: { include: { assignee: { select: { firstName: true, lastName: true } } } },
          _count: { select: { comments: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.task.count({ where }),
    ]);
    return paginated(res, items, total, page, limit);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const getTask = async (req: Request, res: Response) => {
  try {
    const task = await prisma.task.findUnique({
      where: { id: req.params.id },
      include: {
        assignee: { select: { firstName: true, lastName: true, avatar: true } },
        creator: { select: { firstName: true, lastName: true } },
        project: { select: { name: true } },
        subtasks: true,
        comments: {
          include: { user: { select: { firstName: true, lastName: true, avatar: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!task) return error(res, 'Task not found', 404);
    return success(res, task);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createTask = async (req: AuthRequest, res: Response) => {
  try {
    const task = await prisma.task.create({
      data: { ...req.body, creatorId: req.body.creatorId || req.user!.id },
      include: {
        assignee: { select: { firstName: true, lastName: true } },
        creator: { select: { firstName: true, lastName: true } },
      },
    });
    return success(res, task, 'Task created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateTask = async (req: Request, res: Response) => {
  try {
    const data: any = { ...req.body };
    if (req.body.status === 'DONE' && !req.body.completedAt) data.completedAt = new Date();
    const task = await prisma.task.update({ where: { id: req.params.id }, data });
    return success(res, task, 'Task updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteTask = async (req: Request, res: Response) => {
  try {
    await prisma.task.delete({ where: { id: req.params.id } });
    return success(res, null, 'Task deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- MILESTONES ----
export const getMilestones = async (req: Request, res: Response) => {
  try {
    const { projectId } = req.query as any;
    const where: any = {};
    if (projectId) where.projectId = projectId;
    const milestones = await prisma.milestone.findMany({
      where,
      include: { project: { select: { name: true } } },
      orderBy: { dueDate: 'asc' },
    });
    return success(res, milestones);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createMilestone = async (req: Request, res: Response) => {
  try {
    const m = await prisma.milestone.create({ data: req.body });
    return success(res, m, 'Milestone created', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const updateMilestone = async (req: Request, res: Response) => {
  try {
    const m = await prisma.milestone.update({ where: { id: req.params.id }, data: req.body });
    return success(res, m, 'Milestone updated');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteMilestone = async (req: Request, res: Response) => {
  try {
    await prisma.milestone.delete({ where: { id: req.params.id } });
    return success(res, null, 'Milestone deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

// ---- COMMENTS ----
export const getComments = async (req: Request, res: Response) => {
  try {
    const { taskId } = req.query as any;
    const comments = await prisma.comment.findMany({
      where: { taskId },
      include: { user: { select: { firstName: true, lastName: true, avatar: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return success(res, comments);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const createComment = async (req: AuthRequest, res: Response) => {
  try {
    const comment = await prisma.comment.create({
      data: { ...req.body, userId: req.body.userId || req.user!.id },
      include: { user: { select: { firstName: true, lastName: true, avatar: true } } },
    });
    return success(res, comment, 'Comment added', 201);
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

export const deleteComment = async (req: Request, res: Response) => {
  try {
    await prisma.comment.delete({ where: { id: req.params.id } });
    return success(res, null, 'Comment deleted');
  } catch (err: any) {
    return handlePrismaError(res, err);
  }
};

