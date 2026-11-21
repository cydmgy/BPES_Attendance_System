// ============================================================
// STUDENT PORTAL CONTROLLER
// Student Dashboard, Attendance History Ledger, File Excuse / Leave
// ============================================================

function initStudentPortal() {
  const today = manilaDate();
  const stdLeaveDateEl = document.getElementById('std-leave-date');
  if (stdLeaveDateEl) {
    stdLeaveDateEl.value = today;
    stdLeaveDateEl.min = today;
  }

  const todayDateBadge = document.getElementById('student-today-date');
  if (todayDateBadge) {
    todayDateBadge.textContent = `Today, ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }

  populateStudentSubjectDropdowns();
  showStudentTab('overview');
  loadStudentPortalData();
}

function populateStudentSubjectDropdowns() {
  const filterSubj = document.getElementById('std-filter-subject');

  const subjList = subjects || [];

  if (filterSubj) {
    filterSubj.innerHTML = '<option value="">All subjects</option>' +
      subjList.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('');
  }

}

// ── Student Tabs ──────────────────────────────────────────────

function showStudentTab(tab) {
  const tabs = ['overview', 'logs', 'leave'];
  tabs.forEach(t => {
    document.getElementById(`std-tab-${t}`)?.classList.toggle('d-none', t !== tab);
    document.getElementById(`tablink-std-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`sidebar-std-${t}`)?.classList.toggle('active', t === tab);
  });

  const sidebarTitle = document.getElementById('student-sidebar-title');
  const sidebarDesc = document.getElementById('student-sidebar-desc');
  const mobileTitle = document.getElementById('student-mobile-header-title');
  const welcomeDesc = document.getElementById('student-welcome-desc');

  if (tab === 'overview') {
    if (sidebarTitle) sidebarTitle.textContent = 'Overview';
    if (sidebarDesc) sidebarDesc.textContent = 'Track attendance, review history, and submit leave requests.';
    if (mobileTitle) mobileTitle.textContent = 'Dashboard';
    if (welcomeDesc) welcomeDesc.textContent = 'Track your attendance, upcoming classes, and leave status.';
    loadStudentPortalData();
  } else if (tab === 'logs') {
    if (sidebarTitle) sidebarTitle.textContent = 'Attendance History';
    if (sidebarDesc) sidebarDesc.textContent = 'Review all personal attendance records with date, time, room, status, and teacher.';
    if (mobileTitle) mobileTitle.textContent = 'Attendance History';
    if (welcomeDesc) welcomeDesc.textContent = 'Review all personal attendance records with date, time, room, status, and teacher.';
    loadStudentPortalData();
  } else if (tab === 'leave') {
    if (sidebarTitle) sidebarTitle.textContent = 'File Excuse / Leave';
    if (sidebarDesc) sidebarDesc.textContent = 'Submit leave requests, attach proof, and review past request status.';
    if (mobileTitle) mobileTitle.textContent = 'File Excuse / Leave';
    if (welcomeDesc) welcomeDesc.textContent = 'Submit an absence request and track its review status.';
    loadStudentLeaveHistory();
  }
}

// ── Tab 1: Dashboard Overview & Tab 2: Logs Ledger ───────────

async function loadStudentPortalData() {
  showNoClassBanner('std-noclass-banner');
  // Always prioritize and display the student's full name over their LRN
  let displayName = studentUser.full_name || studentUser.name || '';
  if (!displayName || displayName === 'Student' || displayName === studentUser.student_id) {
    let matched = null;
    try {
      const r = await axios.get(`${API_BASE}/api/students/${studentUser.id}`);
      matched = r.data.student || r.data;
    } catch (err) { /* keep the name we already have */ }
    if (matched && matched.full_name) {
      displayName = matched.full_name;
      studentUser.full_name = matched.full_name;
      studentUser.name = matched.full_name;
    }
  }
  if (!displayName) displayName = 'Student';

  const displaySection = studentUser.section || '—';
  const displayLrn = studentUser.student_id || '—';
  const displayRfid = studentUser.rfid_uid || studentUser.rfid || '—';
  const initials = displayName.charAt(0).toUpperCase();

  // Populate UI Profile fields
  const navNameEl = document.getElementById('student-nav-name');
  const avatarEl = document.getElementById('student-avatar');
  const avatarBigEl = document.getElementById('student-avatar-big');
  const cardNameEl = document.getElementById('std-card-name');
  const detailNameEl = document.getElementById('std-detail-name');
  const cardIdEl = document.getElementById('std-card-id');
  const cardCourseEl = document.getElementById('std-card-course');
  const cardRfidEl = document.getElementById('std-card-rfid');
  const greetingEl = document.getElementById('student-greeting');

  const sidebarUserName = document.getElementById('student-sidebar-user-name');
  const sidebarUserLrn = document.getElementById('student-sidebar-user-lrn');

  if (navNameEl) navNameEl.textContent = displayName;
  if (avatarEl) avatarEl.textContent = initials;
  if (avatarBigEl) avatarBigEl.textContent = initials;
  if (sidebarUserName) sidebarUserName.textContent = displayName;
  if (sidebarUserLrn) sidebarUserLrn.textContent = `LRN: ${displayLrn}`;
  if (cardNameEl) cardNameEl.textContent = displayName;
  if (detailNameEl) detailNameEl.textContent = displayName;
  if (cardIdEl) cardIdEl.textContent = displayLrn;
  if (cardCourseEl) cardCourseEl.textContent = displaySection;
  if (cardRfidEl) cardRfidEl.textContent = displayRfid;
  if (greetingEl) greetingEl.textContent = `${greetingWord()}, ${displayName}!`;

  // Prefill Tab 3 form fields
  const formLrn = document.getElementById('leave-form-lrn');
  const formName = document.getElementById('leave-form-name');
  if (formLrn) formLrn.value = displayLrn;
  if (formName) formName.value = displayName;

  // Everything below is the student's own data: the server only returns their logs, sessions and
  // timetable, so nothing is filtered or "filled in" from other students here.
  try {
    const today = manilaDate();
    const termFrom = manilaDate(new Date(Date.now() - TERM_DAYS * 864e5));
    const results = await Promise.allSettled([
      axios.get(`${API_BASE}/api/attendance`, { params: { limit: 500 } }),
      axios.get(`${API_BASE}/api/attendance/weekly`, { params: { from: termFrom, to: today } }),
      axios.get(`${API_BASE}/api/sessions/today`),
      axios.get(`${API_BASE}/api/schedules/my-week`),
      axios.get(`${API_BASE}/api/attendance/trend`, { params: { days: 14 } }),
    ]);
    const [logsData, reportData, todayData, weekData, trendData] = results.map(r => (r.status === 'fulfilled' ? r.value.data : null));

    studentLogsCache = logsData?.logs || [];
    studentReport = reportData?.report?.[0] || null;
    renderStudentStats();
    BpesCharts.trendBars('std-trend-chart', trendData?.days || [], 'No classes held in the last 14 days.');
    renderStudentToday(todayData?.periods);
    renderStudentWeek(weekData?.schedules);
    renderStudentRecent();
    renderStudentHistory();
  } catch (err) {
    console.error('Error fetching student portal data:', err);
  }
}

// ── Stats from session reports ───────────────────────────────

const TERM_DAYS = 90;                // window for the stats cards
let studentLogsCache = [];
let studentReport = null;            // this student's row of /api/attendance/weekly

function renderStudentStats() {
  const r = studentReport || { present: 0, late: 0, excused: 0, absent: 0, sessions: 0, attendance_percent: null };
  const attended = r.present + r.late + r.excused;
  const rate = r.attendance_percent;

  setText('std-stat-present', attended);
  setText('std-stat-present-sub', `${r.sessions} class${r.sessions === 1 ? '' : 'es'} held (last ${TERM_DAYS} days)`);
  setText('std-stat-ontime', r.present);
  setText('std-stat-ontime-sub', `${attended > 0 ? Math.round((r.present / attended) * 100) : 0}% of attended classes`);
  setText('std-stat-absent', r.absent);
  setText('std-stat-absent-sub', `${r.excused} excused`);
  setText('std-stat-rate', rate === null ? '—' : `${rate}%`);
  setText('std-stat-rate-sub', r.sessions > 0 ? `${attended} of ${r.sessions} classes attended` : 'No classes held yet');

  BpesCharts.statusDonut('std-mix-chart', r, 'std-mix-legend', 'No classes held yet.');

  // History tab cards
  const logs = studentLogsCache;
  const rooms = new Set(logs.map(l => l.rooms?.name).filter(Boolean));
  setText('std-logs-total-count', logs.length);
  setText('std-logs-total-sub', `${logs.length} record${logs.length === 1 ? '' : 's'} logged`);
  setText('std-logs-present-count', logs.filter(l => l.status === 'present').length);
  setText('std-logs-present-sub', rate === null ? 'No attendance rate yet' : `${rate}% attendance rate`);
  setText('std-logs-teachers-count', rooms.size);
  setText('std-logs-teachers-sub', `${rooms.size} room${rooms.size === 1 ? '' : 's'} recorded`);
}

// ── Today's classes and the weekly timetable ─────────────────

function renderStudentToday(periods) {
  const tbody = document.getElementById('std-today-tbody');
  if (!tbody) return;
  const list = periods || [];
  setText('std-today-pill', `${list.length} class${list.length === 1 ? '' : 'es'}`);
  tbody.innerHTML = list.length === 0
    ? '<tr><td colspan="5" class="text-center py-4 text-muted">No classes scheduled today.</td></tr>'
    : list.map(p => `
      <tr>
        <td>${shortTime(p.start_time)} – ${shortTime(p.end_time)}</td>
        <td>${escapeHtml(p.subject?.name || '—')}<span class="bpes-cell-sub">${escapeHtml(p.subject?.code || '')}</span></td>
        <td>${escapeHtml(p.room || '—')}</td>
        <td>${escapeHtml(p.teacher?.full_name || '—')}</td>
        <td>${statusBadge(p.badge)}</td>
      </tr>`).join('');
}

// Weekly timetable from TeacherSchedule.buildWeekCalendar (js/teacher-schedule.js): a time-proportional calendar from 768px up, stacked by day below.
function renderStudentWeek(schedules) {
  const box = document.getElementById('std-week-grid');
  if (!box) return;
  const list = schedules || [];
  setText('std-week-pill', `${list.length} period${list.length === 1 ? '' : 's'}`);
  const cal = TeacherSchedule.buildWeekCalendar(list, null);
  if (!cal.hours.length) {
    box.innerHTML = '<div class="text-center py-4 text-muted">No timetable has been set for your section yet.</div>';
    return;
  }
  const todayName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'long' }).format(new Date());
  const inner = e => `
    <strong>${escapeHtml(e.subject)}</strong>
    <div>${escapeHtml(e.room)}${e.teacher ? ` &middot; ${escapeHtml(e.teacher)}` : ''}</div>
    <div>${shortTime(e.start_time)}&ndash;${shortTime(e.end_time)}</div>`;
  const stacked = cal.days.map(d => {
    if (!cal.blocks[d].length) return '';
    return `
      <div class="border rounded-3 p-2 mb-2 ${d === todayName ? 'border-success' : ''}">
        <div class="fw-bold mb-1 ${d === todayName ? 'text-success' : 'text-dark'}">${escapeHtml(d)}${d === todayName ? ' <span class="small fw-normal">(today)</span>' : ''}</div>
        ${cal.blocks[d].map(e => `<div class="rounded-3 p-2 mb-1 bg-success-subtle" style="font-size: 12px; color: var(--color-text-main);">${inner(e)}</div>`).join('')}
      </div>`;
  }).join('');
  box.innerHTML = `<div class="d-none d-md-block">${weekCalendarHtml(cal, todayName, inner, () => 'bg-success-subtle')}</div><div class="d-md-none">${stacked}</div>`;
}

// ── Attendance history (dashboard preview + filtered ledger) ──

function renderStudentRecent() {
  const tbody = document.getElementById('std-recent-tbody');
  const recent = studentLogsCache.slice(0, 5);
  setText('std-history-pill', `${recent.length} records`);
  if (!tbody) return;
  tbody.innerHTML = recent.length === 0
    ? '<tr><td colspan="4" class="text-center py-4 text-muted">No attendance events recorded yet.</td></tr>'
    : recent.map(l => `
      <tr>
        <td><strong>${new Date(l.timestamp).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })}</strong></td>
        <td>${escapeHtml(l.rooms?.name || '—')}</td>
        <td>${new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
        <td>${statusBadge(l.status)}</td>
      </tr>`).join('');
}

function renderStudentHistory() {
  const tbody = document.getElementById('std-all-logs-tbody');
  if (!tbody) return;
  const subject = document.getElementById('std-filter-subject')?.value;
  const status = document.getElementById('std-filter-status')?.value;
  const rows = studentLogsCache.filter(l =>
    (!subject || l.class_sessions?.schedules?.subjects?.name === subject) &&
    (!status || l.status === status));

  setText('std-all-logs-count-pill', `${rows.length} records`);
  tbody.innerHTML = rows.length === 0
    ? '<tr><td colspan="5" class="text-center py-4 text-muted">No attendance history found.</td></tr>'
    : rows.map(l => `
      <tr>
        <td><strong>${new Date(l.timestamp).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong></td>
        <td>${escapeHtml(l.class_sessions?.schedules?.subjects?.name || '—')}</td>
        <td>${escapeHtml(l.rooms?.name || '—')}</td>
        <td>${statusBadge(l.status)}</td>
        <td>${escapeHtml(l.class_sessions?.teacher?.full_name || '—')}</td>
      </tr>`).join('');
}

// ── Tab 3: File Excuse or Leave ─────────────

// Same limits as backend/src/utils/attachment.js (MAX_FILES, MAX_BYTES, ALLOWED_TYPES); the server re-checks them.
const LEAVE_MAX_FILES = 3;
const LEAVE_MAX_BYTES = 5242880;
const LEAVE_FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
let leaveFiles = []; // a FileList cannot be edited, so the chosen files live here

function renderLeaveFiles() {
  const list = document.getElementById('std-leave-file-list');
  if (!list) return;
  list.innerHTML = leaveFiles.map((f, i) => `
    <li class="d-flex align-items-center gap-2 mb-1" style="font-size:13px">
      <i class="fas fa-paperclip text-muted" aria-hidden="true"></i>
      <span class="flex-grow-1" style="min-width:0;overflow-wrap:anywhere">${escapeHtml(f.name)}</span>
      <button type="button" class="btn btn-link text-danger p-0" style="min-width:44px;min-height:44px;font-size:13px"
        aria-label="Remove ${escapeHtml(f.name)}" onclick="removeLeaveFile(${i})"><i class="fas fa-xmark" aria-hidden="true"></i></button>
    </li>`).join('');
}

function addLeaveFiles(input) {
  const errEl = document.getElementById('std-leave-files-error');
  const errors = [];
  for (const f of Array.from(input.files || [])) {
    if (!LEAVE_FILE_TYPES.includes(f.type)) errors.push(`${f.name} is not a JPG, PNG, WebP or PDF file.`);
    else if (f.size > LEAVE_MAX_BYTES) errors.push(`${f.name} is larger than 5 MB.`);
    else if (leaveFiles.length >= LEAVE_MAX_FILES) errors.push(`You can attach at most ${LEAVE_MAX_FILES} files, so ${f.name} was not added.`);
    else leaveFiles.push(f);
  }
  input.value = ''; // else picking the same file again after removing it fires no change event
  if (errEl) errEl.textContent = errors.join(' ');
  renderLeaveFiles();
}

function removeLeaveFile(i) {
  leaveFiles.splice(i, 1);
  const errEl = document.getElementById('std-leave-files-error');
  if (errEl) errEl.textContent = '';
  renderLeaveFiles();
}

// The picker and remove buttons stay locked while files upload, so the list cannot change mid-submit.
function setLeavePickerLocked(locked) {
  const input = document.getElementById('std-leave-files');
  if (input) input.disabled = locked;
  document.querySelectorAll('#std-leave-file-list button').forEach(b => { b.disabled = locked; });
}

async function submitStudentLeave(e) {
  e.preventDefault();
  const alertEl = document.getElementById('std-leave-form-alert');
  const btn = document.getElementById('std-leave-btn');

  // Whole day, or a half day with its part: whole_day | half_day_am | half_day_pm
  const isHalf = document.getElementById('std-leave-half')?.checked;
  const leaveType = isHalf ? `half_day_${document.getElementById('std-leave-half-part')?.value || 'am'}` : 'whole_day';

  const leaveDate = document.getElementById('std-leave-date')?.value;
  const reasonText = document.getElementById('std-leave-reason')?.value.trim();
  const requester = document.getElementById('std-leave-requester')?.value || 'Student';

  if (!leaveDate) {
    if (alertEl) {
      alertEl.innerHTML = `<div class="alert alert-danger py-2 small mb-3"><i class="fas fa-circle-exclamation me-1"></i> Please select a valid absence date.</div>`;
    }
    return;
  }

  if (!reasonText) {
    if (alertEl) {
      alertEl.innerHTML = `<div class="alert alert-danger py-2 small mb-3"><i class="fas fa-circle-exclamation me-1"></i> Please provide a reason for your absence.</div>`;
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span> Submitting...';
  }
  setLeavePickerLocked(true);

  try {
    const requesterText = requester ? ` [Filed by: ${requester}]` : '';
    const formattedReason = `${reasonText}${requesterText}`;

    if (alertEl) alertEl.innerHTML = '';
    const posted = await axios.post(`${API_BASE}/api/leave`, {
      student_id: studentUser.id || studentUser.student_id,
      leave_type: leaveType,
      leave_date: leaveDate,
      reason: formattedReason
    });

    // Files go up one at a time; a failed file does not undo the filed request.
    const leaveId = posted.data?.leave_request?.id;
    const failed = [];
    const toUpload = leaveFiles.slice();
    for (let i = 0; i < toUpload.length; i++) {
      const f = toUpload[i];
      if (btn) btn.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span> Uploading ${i + 1} of ${toUpload.length}...`;
      try {
        if (!leaveId) throw new Error('no leave id');
        await axios.post(`${API_BASE}/api/leave/${leaveId}/attachments`, f, {
          headers: { 'Content-Type': f.type, 'x-file-name': encodeURIComponent(f.name) }
        });
      } catch (upErr) { failed.push(f.name); }
    }

    if (failed.length) {
      if (alertEl) alertEl.innerHTML = `<div class="alert alert-warning py-2 small mb-3" role="alert"><i class="fas fa-triangle-exclamation me-1"></i> Leave request filed, but these files did not upload: ${failed.map(escapeHtml).join(', ')}. Show them to your teacher, or file a new request with them attached.</div>`;
    } else {
      notify('student', 'Leave request submitted successfully!', 'success');
    }
    document.getElementById('std-leave-form')?.reset();
    leaveFiles = [];
    renderLeaveFiles();
    const filesErr = document.getElementById('std-leave-files-error');
    if (filesErr) filesErr.textContent = '';
    toggleLeaveHalf();

    const today = manilaDate();
    const stdLeaveDateEl = document.getElementById('std-leave-date');
    if (stdLeaveDateEl) {
      stdLeaveDateEl.value = today;
    }

    await loadStudentLeaveHistory();
  } catch (err) {
    const msg = err.response?.data?.error || err.message || 'Failed to file leave request';
    if (alertEl) {
      alertEl.innerHTML = `<div class="alert alert-danger py-2 small mb-3"><i class="fas fa-circle-exclamation me-1"></i> ${escapeHtml(msg)}</div>`;
    }
  } finally {
    setLeavePickerLocked(false);
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>Submit request</span>';
    }
  }
}

// The Morning / Afternoon choice only shows when Half day is picked.
function toggleLeaveHalf() {
  const isHalf = document.getElementById('std-leave-half')?.checked;
  document.getElementById('std-leave-half-wrap')?.classList.toggle('d-none', !isHalf);
}

async function loadStudentLeaveHistory() {
  const tbody = document.getElementById('std-leave-history-tbody');
  const countPill = document.getElementById('std-leave-count-pill');
  if (!tbody) return;

  try {
    const res = await axios.get(`${API_BASE}/api/leave?student_id=${studentUser.id || ''}`);
    const requests = res.data.leave_requests || [];

    if (countPill) countPill.textContent = `${requests.length} request${requests.length === 1 ? '' : 's'}`;

    if (requests.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-muted">No leave requests submitted yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = requests.map((req, idx) => {
      const subject = leaveLabel(req);
      const displayReason = leaveReasonText(req);
      const filedBy = leaveFiledBy(req);

      const date = req.leave_date || 'Date';
      const statusBadge = getStudentLeaveStatusBadge(req.status);
      const reqId = req.id ? `REQ-${req.id.slice(0, 8).toUpperCase()}` : `REQ-${String(idx + 1).padStart(4, '0')}`;

      return `
        <tr>
          <td><span class="bpes-req-id">${escapeHtml(reqId)}</span></td>
          <td class="text-nowrap">${escapeHtml(date)}</td>
          <td>${escapeHtml(subject)}</td>
          <td><div>${escapeHtml(displayReason)}${filedBy ? `<span class="bpes-cell-sub">Filed by: ${escapeHtml(filedBy)}</span>` : ''}${leaveAttachmentLinks(req)}</div></td>
          <td>${statusBadge}</td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error('Error fetching student leave history:', err);
    tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-warning">Could not load past requests.</td></tr>`;
  }
}

function getStudentLeaveStatusBadge(status) {
  const s = String(status || 'pending').toLowerCase();
  if (s === 'approved') return '<span class="bpes-badge bpes-badge-approved">Approved</span>';
  if (s === 'rejected' || s === 'declined') return '<span class="bpes-badge bpes-badge-declined">Declined</span>';
  return '<span class="bpes-badge bpes-badge-pending">Pending</span>';
}
