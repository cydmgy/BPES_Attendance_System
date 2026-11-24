// Default student password (teachers use the same rule with the last 4 of their id): surname + last 4 of the LRN, lowercase, accents and non-letters removed.
// "Surname, First M." takes the text before the comma; without a comma the first word is the surname.
function defaultStudentPassword(fullName, studentId) {
  const name = String(fullName || '').trim();
  const surname = (name.includes(',') ? name.split(',')[0] : name.split(/\s+/)[0])
    .normalize('NFD').toLowerCase().replace(/[^a-z]/g, '');
  const id = String(studentId || '').trim();
  if (id.length < 4 || !surname) throw new Error('Cannot build a default password from this name and student ID');
  return surname + id.slice(-4);
}

module.exports = { defaultStudentPassword, defaultTeacherPassword: defaultStudentPassword };
