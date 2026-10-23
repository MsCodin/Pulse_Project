const express = require('express');
const c = require('./controller');
const HttpError = require('./utils/HttpError');

const router = express.Router();

const methodNotAllowed = (allowed) => (req, res, next) => {
  res.set('Allow', allowed.join(', '));
  next(new HttpError(405, `${req.method} is not allowed here. Allowed: ${allowed.join(', ')}`));
};

function register(collectionPath, itemPath, ctrl) {
  const can = (op) => ctrl.allow.includes(op);
  if (collectionPath) {
    const collection = router.route(collectionPath);
    if (can('list')) collection.get(ctrl.list);
    if (can('create')) collection.post(ctrl.create);
    collection.all(methodNotAllowed([can('list') && 'GET', can('create') && 'POST'].filter(Boolean)));
  }
  if (itemPath) {
    const item = router.route(itemPath);
    if (can('read')) item.get(ctrl.read);
    if (can('update')) item.put(ctrl.update).patch(ctrl.patch);
    if (can('delete')) item.delete(ctrl.remove);
    item.all(methodNotAllowed([can('read') && 'GET', can('update') && 'PUT', can('update') && 'PATCH', can('delete') && 'DELETE'].filter(Boolean)));
  }
}
const crudl = (path, ctrl) => register(path, `${path}/:id`, ctrl);
const nested = (path, ctrl) => register(path, null, ctrl);

router.post('/users/:id/deactivate', c.users.deactivate);
crudl('/users', c.users);
nested('/users/:user_ID/roles', c.userRoles);
crudl('/user-roles', c.userRoles);
crudl('/login-attempts', c.loginAttempts);
crudl('/zones', c.zones);
nested('/zones/:zone_ID/sites', c.sites);
nested('/zones/:zone_ID/shifts', c.shifts);
nested('/zones/:zone_ID/priority-rules', c.zonePriorityRules);
nested('/zones/:zone_ID/incidents', c.incidents);
crudl('/sites', c.sites);

router.get('/responders/nearest', c.responders.nearest);
crudl('/responders', c.responders);
nested('/responders/:responder_ID/skills', c.responderSkills);
nested('/responders/:responder_ID/locations', c.responderLocations);
nested('/responders/:responder_ID/assignments', c.assignments);
nested('/responders/:responder_ID/shift-assignments', c.shiftAssignments);
crudl('/responder-locations', c.responderLocations);
crudl('/skills', c.skills);
crudl('/responder-skills', c.responderSkills);
crudl('/equipment-types', c.equipmentTypes);
crudl('/equipment', c.equipment);
nested('/equipment/:equipment_ID/allocations', c.equipmentAllocations);
nested('/equipment/:equipment_ID/faults', c.equipmentFaults);
nested('/equipment/:equipment_ID/maintenance-logs', c.equipmentMaintenanceLogs);
crudl('/equipment-allocations', c.equipmentAllocations);
crudl('/equipment-faults', c.equipmentFaults);
crudl('/equipment-maintenance-logs', c.equipmentMaintenanceLogs);

crudl('/shifts', c.shifts);
nested('/shifts/:shift_ID/assignments', c.shiftAssignments);
register('/shifts/:shift_ID/skill-cover', '/shifts/:shift_ID/skill-cover/:skill_ID', c.shiftSkillCovers);
crudl('/shift-assignments', c.shiftAssignments);
crudl('/bookings', c.bookings);

crudl('/incident-categories', c.incidentCategories);
register('/incident-categories/:incident_category_ID/skills', '/incident-categories/:incident_category_ID/skills/:skill_ID', c.categoryRequiredSkills);
register('/incident-categories/:incident_category_ID/equipment', '/incident-categories/:incident_category_ID/equipment/:equipment_type_ID', c.categoryRequiredEquipment);

router.patch('/incidents/:id/status', c.incidents.changeStatus);
crudl('/incidents', c.incidents);
nested('/incidents/:incident_ID/calls', c.calls);
nested('/incidents/:incident_ID/assignments', c.assignments);
nested('/incidents/:incident_ID/status-logs', c.statusLogs);
nested('/incidents/:incident_ID/notes', c.incidentNotes);
nested('/incidents/:incident_ID/attachments', c.incidentAttachments);
nested('/incidents/:incident_ID/escalations', c.escalations);
nested('/incidents/:incident_ID/work-orders', c.workOrders);
nested('/incidents/:incident_ID/equipment-faults', c.equipmentFaults);

crudl('/calls', c.calls);
nested('/calls/:call_ID/callbacks', c.callbackRequests);
crudl('/callback-requests', c.callbackRequests);

router.patch('/assignments/:id/status', c.assignments.changeStatus);
crudl('/assignments', c.assignments);
crudl('/status-logs', c.statusLogs);
crudl('/incident-notes', c.incidentNotes);
crudl('/incident-attachments', c.incidentAttachments);
crudl('/escalations', c.escalations);

crudl('/work-orders', c.workOrders);
register('/work-orders/:work_order_ID/equipment', '/work-orders/:work_order_ID/equipment/:equipment_type_ID', c.workOrderEquipment);
register('/work-orders/:work_order_ID/skills', '/work-orders/:work_order_ID/skills/:skill_ID', c.workOrderSkills);
nested('/work-orders/:work_order_ID/approvals', c.workOrderApprovals);
crudl('/work-order-approvals', c.workOrderApprovals);

crudl('/notifications', c.notifications);
crudl('/zone-priority-rules', c.zonePriorityRules);
crudl('/audit-logs', c.auditLogs);
crudl('/pattern-flags', c.patternFlags);
crudl('/saved-reports', c.savedReports);
crudl('/system-settings', c.systemSettings);

crudl('/simulation-runs', c.simulationRuns);

module.exports = router;
