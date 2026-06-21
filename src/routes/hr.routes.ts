import { Router } from 'express';
import {
  getEmployees, getEmployee, createEmployee, updateEmployee, deleteEmployee,
  getDepartments, createDepartment, updateDepartment, deleteDepartment,
  getPositions, createPosition, deletePosition,
  getAttendance, markAttendance,
  getLeaveTypes, createLeaveType,
  getLeaveRequests, createLeaveRequest, approveLeaveRequest,
  getPayrolls, generatePayroll, updatePayrollStatus,
} from '../controllers/hr.controller';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.route('/employees').get(getEmployees).post(createEmployee);
router.route('/employees/:id').get(getEmployee).put(updateEmployee).delete(deleteEmployee);

router.route('/departments').get(getDepartments).post(createDepartment);
router.route('/departments/:id').put(updateDepartment).delete(deleteDepartment);

router.route('/positions').get(getPositions).post(createPosition);
router.delete('/positions/:id', deletePosition);

router.route('/attendance').get(getAttendance).post(markAttendance);

router.route('/leave-types').get(getLeaveTypes).post(createLeaveType);

router.route('/leave-requests').get(getLeaveRequests).post(createLeaveRequest);
router.put('/leave-requests/:id/approve', approveLeaveRequest);

router.route('/payroll').get(getPayrolls).post(generatePayroll);
router.put('/payroll/:id/status', updatePayrollStatus);

export default router;
