import { Router } from 'express';
import {
  getEmployees, getEmployee, createEmployee, updateEmployee, deleteEmployee,
  getDepartments, createDepartment, updateDepartment, deleteDepartment,
  getPositions, createPosition, updatePosition, deletePosition,
  getAttendance, markAttendance, updateAttendance, deleteAttendance,
  getLeaveTypes, createLeaveType, updateLeaveType, deleteLeaveType, getLeaveBalances,
  getLeaveRequests, createLeaveRequest, updateLeaveRequest, deleteLeaveRequest, approveLeaveRequest,
  getPayrolls, generatePayroll, updatePayrollStatus,
  getMyHrProfile, updateMyHrProfile, getMyAttendance, createEmployeeCheckin,
  getShiftTypes, createShiftType, updateShiftType, deleteShiftType, getShiftAssignments, assignShift, updateShiftAssignment, deleteShiftAssignment, getShiftRoster, markShiftAutoAttendance,
  getLeaveAllocations, createLeaveAllocation, updateLeaveAllocation, deleteLeaveAllocation, getLeaveLedger, getLeavePolicies, createLeavePolicy, updateLeavePolicy, deleteLeavePolicy,
  getSalaryComponents, createSalaryComponent, updateSalaryComponent, deleteSalaryComponent, getSalaryStructures, createSalaryStructure, updateSalaryStructure, deleteSalaryStructure, assignSalaryStructure,
  getPayrollEntries, generatePayrollEntry, updatePayrollEntryStatus,
  getSalarySlips, getMySalarySlips, getSalarySlip,
  getLifecycleEvents, createLifecycleEvent, updateLifecycleEvent, deleteLifecycleEvent, updateLifecycleEventStatus,
  getHrDashboard,
} from '../controllers/hr.controller';
import { authenticate, authorize, requireModuleAccess } from '../middleware/auth';

const router = Router();
router.use(authenticate);

const hrRoles = ['SUPER_ADMIN', 'ADMIN', 'HR_MANAGER', 'HR_OFFICER'];
const payrollRoles = ['SUPER_ADMIN', 'ADMIN', 'HR_MANAGER', 'PAYROLL_OFFICER'];
const managerRoles = ['SUPER_ADMIN', 'ADMIN', 'HR_MANAGER', 'HR_OFFICER', 'MANAGER'];

router.get('/dashboard', authorize(...hrRoles, 'PAYROLL_OFFICER', 'MANAGER', 'EMPLOYEE'), getHrDashboard);

router.route('/me').get(getMyHrProfile).patch(updateMyHrProfile);
router.get('/me/attendance', getMyAttendance);
router.post('/me/checkins', createEmployeeCheckin);
router.get('/me/salary-slips', getMySalarySlips);

router.use(requireModuleAccess('hr'));

router.route('/employees').get(authorize(...hrRoles, 'PAYROLL_OFFICER', 'MANAGER'), getEmployees).post(authorize(...hrRoles), createEmployee);
router.route('/employees/:id').get(authorize(...hrRoles, 'PAYROLL_OFFICER', 'MANAGER'), getEmployee).put(authorize(...hrRoles), updateEmployee).delete(authorize(...hrRoles), deleteEmployee);

router.route('/departments').get(getDepartments).post(authorize(...hrRoles), createDepartment);
router.route('/departments/:id').put(authorize(...hrRoles), updateDepartment).delete(authorize(...hrRoles), deleteDepartment);

router.route('/positions').get(getPositions).post(authorize(...hrRoles), createPosition);
router.route('/positions/:id').put(authorize(...hrRoles), updatePosition).delete(authorize(...hrRoles), deletePosition);

router.route('/attendance').get(authorize(...hrRoles, 'MANAGER'), getAttendance).post(authorize(...hrRoles), markAttendance);
router.route('/attendance/:id').put(authorize(...hrRoles), updateAttendance).delete(authorize(...hrRoles), deleteAttendance);

router.route('/shift-types').get(authorize(...hrRoles), getShiftTypes).post(authorize(...hrRoles), createShiftType);
router.route('/shift-types/:id').put(authorize(...hrRoles), updateShiftType).delete(authorize(...hrRoles), deleteShiftType);

router.route('/shift-assignments').get(authorize(...hrRoles), getShiftAssignments).post(authorize(...hrRoles), assignShift);
router.route('/shift-assignments/:id').put(authorize(...hrRoles), updateShiftAssignment).delete(authorize(...hrRoles), deleteShiftAssignment);
router.get('/shift-roster', authorize(...hrRoles, 'MANAGER'), getShiftRoster);
router.post('/shift-auto-attendance', authorize(...hrRoles), markShiftAutoAttendance);

router.route('/leave-types').get(getLeaveTypes).post(authorize(...hrRoles), createLeaveType);
router.route('/leave-types/:id').put(authorize(...hrRoles), updateLeaveType).delete(authorize(...hrRoles), deleteLeaveType);

router.get('/leave-balances', authorize(...hrRoles, 'MANAGER', 'EMPLOYEE'), getLeaveBalances);
router.route('/leave-policies').get(authorize(...hrRoles), getLeavePolicies).post(authorize(...hrRoles), createLeavePolicy);
router.route('/leave-policies/:id').put(authorize(...hrRoles), updateLeavePolicy).delete(authorize(...hrRoles), deleteLeavePolicy);

router.route('/leave-allocations').get(authorize(...hrRoles, 'MANAGER'), getLeaveAllocations).post(authorize(...hrRoles), createLeaveAllocation);
router.route('/leave-allocations/:id').put(authorize(...hrRoles), updateLeaveAllocation).delete(authorize(...hrRoles), deleteLeaveAllocation);
router.get('/leave-ledger', authorize(...hrRoles, 'MANAGER'), getLeaveLedger);

router.route('/leave-requests').get(authorize(...managerRoles, 'EMPLOYEE'), getLeaveRequests).post(createLeaveRequest);
router.route('/leave-requests/:id').put(authorize(...managerRoles, 'EMPLOYEE'), updateLeaveRequest).delete(authorize(...managerRoles, 'EMPLOYEE'), deleteLeaveRequest);
router.put('/leave-requests/:id/approve', authorize(...managerRoles), approveLeaveRequest);
router.patch('/leave-requests/:id/approve', authorize(...managerRoles), approveLeaveRequest);

router.route('/payroll').get(authorize(...payrollRoles), getPayrolls).post(authorize(...payrollRoles), generatePayroll);
router.put('/payroll/:id/status', authorize(...payrollRoles), updatePayrollStatus);

router.route('/salary-components').get(authorize(...payrollRoles), getSalaryComponents).post(authorize(...payrollRoles), createSalaryComponent);
router.route('/salary-components/:id').put(authorize(...payrollRoles), updateSalaryComponent).delete(authorize(...payrollRoles), deleteSalaryComponent);

router.route('/salary-structures').get(authorize(...payrollRoles), getSalaryStructures).post(authorize(...payrollRoles), createSalaryStructure);
router.route('/salary-structures/:id').put(authorize(...payrollRoles), updateSalaryStructure).delete(authorize(...payrollRoles), deleteSalaryStructure);
router.post('/salary-structure-assignments', authorize(...payrollRoles), assignSalaryStructure);

router.route('/payroll-entries').get(authorize(...payrollRoles), getPayrollEntries).post(authorize(...payrollRoles), generatePayrollEntry);
router.patch('/payroll-entries/:id/status', authorize(...payrollRoles), updatePayrollEntryStatus);
router.get('/salary-slips', authorize(...payrollRoles), getSalarySlips);
router.get('/salary-slips/:id', getSalarySlip);

router.route('/lifecycle-events').get(authorize(...hrRoles), getLifecycleEvents).post(authorize(...hrRoles), createLifecycleEvent);
router.route('/lifecycle-events/:id').put(authorize(...hrRoles), updateLifecycleEvent).delete(authorize(...hrRoles), deleteLifecycleEvent);
router.patch('/lifecycle-events/:id/status', authorize(...hrRoles), updateLifecycleEventStatus);

export default router;
