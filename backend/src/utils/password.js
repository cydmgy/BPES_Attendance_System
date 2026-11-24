// Default student password (teachers use the same rule with the last 4 of their employee ID): surname + last 4 of the LRN, lowercase, accents and non-letters removed.
// "Surname, First M." takes the text before the comma; without a comma the first word is the surname.
function defaultStudentPassword(fullName, studentId) {
  const name = String(fullName || '').trim();
  const surname = (name.includes(',') ? name.split(',')[0] : name.split(/\s+/)[0])
    .normalize('NFD').toLowerCase().replace(/[^a-z]/g, '');
  const id = String(studentId || '').trim();
  if (id.length < 4 || !surname) throw new Error('Cannot build a default password from this name and student ID');
  return surname + id.slice(-4);
}

// Teacher IDs can look like "T-2025-014": keep letters and digits only, so the last 4 are "5014".
const defaultTeacherPassword = (fullName, employeeId) =>
  defaultStudentPassword(fullName, String(employeeId || '').toLowerCase().replace(/[^a-z0-9]/g, ''));

module.exports = { defaultStudentPassword, defaultTeacherPassword };
