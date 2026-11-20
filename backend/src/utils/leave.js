// Leave requests are a whole day or a half day (morning / afternoon). The cutoff matches roll_in_students (migration 007).
const LEAVE_TYPES = ['whole_day', 'half_day_am', 'half_day_pm'];
const NOON = '12:00:00'; // period times are 'HH:MM:SS' strings, which compare correctly as text

// Does an approved leave excuse this period? Old requests that named a subject still only cover that subject.
function leaveCoversPeriod(leave, period) {
  if (leave.subject_id && leave.subject_id !== period.subject_id) return false;
  if (leave.leave_type === 'half_day_am') return period.start_time < NOON;
  if (leave.leave_type === 'half_day_pm') return period.start_time >= NOON;
  return true;
}

// Two requests for the same date clash when either is a whole day, or both are the same half.
const leaveTypesConflict = (a, b) => a === 'whole_day' || b === 'whole_day' || a === b;

module.exports = { LEAVE_TYPES, leaveCoversPeriod, leaveTypesConflict };
