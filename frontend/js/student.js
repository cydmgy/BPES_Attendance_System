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
  const brandTitle = document.getElementById('student-brand-title');
  const mobileTitle = document.getElementById('student-mobile-header-title');
  const welcomeDesc = document.getElementById('student-welcome-desc');

  if (tab === 'overview') {
    if (sidebarTitle) sidebarTitle.textContent = 'Overview';
    if (sidebarDesc) sidebarDesc.textContent = 'Track attendance, review history, and submit leave requests.';
    if (brandTitle) brandTitle.textContent = 'Student Dashboard';
    if (mobileTitle) mobileTitle.textContent = 'Dashboard';
    if (welcomeDesc) welcomeDesc.textContent = 'Track your attendance, upcoming classes, and leave status.';
    loadStudentPortalData();
  } else if (tab === 'logs') {
    if (sidebarTitle) sidebarTitle.textContent = 'Attendance History';
    if (sidebarDesc) sidebarDesc.textContent = 'Review all personal attendance records with date, time, room, status, and teacher.';
    if (brandTitle) brandTitle.textContent = 'Attendance History';
    if (mobileTitle) mobileTitle.textContent = 'Attendance History';
    if (welcomeDesc) welcomeDesc.textContent = 'Review all personal attendance records with date, time, room, status, and teacher.';
    loadStudentPortalData();
  } else if (tab === 'leave') {
    if (sidebarTitle) sidebarTitle.textContent = 'File Excuse / Leave';
    if (sidebarDesc) sidebarDesc.textContent = 'Submit leave requests, attach proof, and review past request status.';
    if (brandTitle) brandTitle.textContent = 'File Excuse / Leave';
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
        <td><span class="small fw-medium text-dark">${shortTime(p.start_time)} – ${shortTime(p.end_time)}</span></td>
        <td>${escapeHtml(p.subject?.name || '—')}<div class="small text-muted">${escapeHtml(p.subject?.code || '')}</div></td>
        <td><span class="small text-muted">${escapeHtml(p.room || '—')}</span></td>
        <td><span class="small text-dark">${escapeHtml(p.teacher?.full_name || '—')}</span></td>
        <td>${statusBadge(p.badge)}</td>
      </tr>`).join('');
}

// Weekly timetable from TeacherSchedule.buildWeekGrid (js/teacher-schedule.js): a grid from 768px up, stacked by day below.
function renderStudentWeek(schedules) {
  const box = document.getElementById('std-week-grid');
  if (!box) return;
  const list = schedules || [];
  setText('std-week-pill', `${list.length} period${list.length === 1 ? '' : 's'}`);
  const { days, hours, cells } = TeacherSchedule.buildWeekGrid(list, null);
  if (!hours.length) {
    box.innerHTML = '<div class="text-center py-4 text-muted">No timetable has been set for your section yet.</div>';
    return;
  }
  const todayName = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', weekday: 'long' }).format(new Date());
  const block = e => `
    <div class="rounded-3 p-2 mb-1 bg-success-subtle" style="font-size: 12px;">
      <div class="fw-bold text-dark">${escapeHtml(e.subject)}</div>
      <div class="text-muted">${escapeHtml(e.room)}${e.teacher ? ` &middot; ${escapeHtml(e.teacher)}` : ''}</div>
      <div class="text-muted">${shortTime(e.start_time)}&ndash;${shortTime(e.end_time)}</div>
    </div>`;
  const grid = `
    <div class="table-responsive d-none d-md-block">
      <table class="table table-bordered align-middle mb-0" style="min-width: 720px;">
        <thead class="table-light"><tr><th style="width: 80px;">Time</th>${days.map(d => `<th class="${d === todayName ? 'bg-success-subtle text-success' : ''}">${escapeHtml(d)}</th>`).join('')}</tr></thead>
        <tbody>${hours.map(h => `<tr><th class="text-nowrap small">${TeacherSchedule.hourLabel(h)}</th>${days.map(d => `<td class="${d === todayName ? 'bg-success-subtle bg-opacity-25' : ''}">${cells[h][d].map(block).join('')}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>`;
  // A class spans several hour rows in the grid, so de-duplicate by schedule id for the stacked view.
  const stacked = days.map(d => {
    const periods = [...new Map(hours.flatMap(h => cells[h][d]).map(e => [e.schedule_id, e])).values()];
    if (!periods.length) return '';
    return `
      <div class="border rounded-3 p-2 mb-2 ${d === todayName ? 'border-success' : ''}">
        <div class="fw-bold mb-1 ${d === todayName ? 'text-success' : 'text-dark'}">${escapeHtml(d)}${d === todayName ? ' <span class="small fw-normal">(today)</span>' : ''}</div>
        ${periods.map(block).join('')}
      </div>`;
  }).join('');
  box.innerHTML = `${grid}<div class="d-md-none">${stacked}</div>`;
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
        <td><span class="fw-medium text-dark">${new Date(l.timestamp).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })}</span></td>
        <td><span class="small text-muted">${escapeHtml(l.rooms?.name || '—')}</span></td>
        <td><span class="small text-dark">${new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></td>
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
        <td><strong class="text-dark">${new Date(l.timestamp).toLocaleString([], { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong></td>
        <td><span class="small text-dark">${escapeHtml(l.class_sessions?.schedules?.subjects?.name || '—')}</span></td>
        <td><span class="small text-muted">${escapeHtml(l.rooms?.name || '—')}</span></td>
        <td>${statusBadge(l.status)}</td>
        <td><span class="small text-dark fw-medium">${escapeHtml(l.class_sessions?.teacher?.full_name || '—')}</span></td>
      </tr>`).join('');
}

// ── Tab 3: File Excuse or Leave ─────────────

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

  try {
    const requesterText = requester ? ` [Filed by: ${requester}]` : '';
    const formattedReason = `${reasonText}${requesterText}`;

    await axios.post(`${API_BASE}/api/leave`, {
      student_id: studentUser.id || studentUser.student_id,
      leave_type: leaveType,
      leave_date: leaveDate,
      reason: formattedReason
    });

    notify('student', 'Leave request submitted successfully!', 'success');
    document.getElementById('std-leave-form')?.reset();
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

      const date = req.leave_date || 'Date';
      const statusBadge = getStudentLeaveStatusBadge(req.status);
      const reqId = req.id ? `REQ-${req.id.slice(0, 8).toUpperCase()}` : `REQ-${String(idx + 1).padStart(4, '0')}`;

      return `
        <tr>
          <td><span class="bpes-req-id">${escapeHtml(reqId)}</span></td>
          <td><span class="text-nowrap small text-dark">${escapeHtml(date)}</span></td>
          <td><span class="badge bg-light text-dark border">${escapeHtml(subject)}</span></td>
          <td><span class="small text-secondary" style="max-width: 180px; display: inline-block;">${escapeHtml(displayReason)}</span></td>
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
