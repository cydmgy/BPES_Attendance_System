// ============================================================
// TEACHER PORTAL CONTROLLER
// Today's classes and weekly timetable, per-session rosters with inline override,
// Export Attendance, Leave Review
//
// Data comes from the server already scoped to this teacher (their own periods, co-teaching and
// substitutions): GET /api/sessions?date=, GET /api/schedules/my-week.
// ============================================================

let teacherAutoRefreshInterval = null;
let currentTeacherPeriods = [];      // periods (with rosters) shown on the Attendance tab
let teacherOverrideRows = new Map(); // log id -> row, so inline buttons only carry the id
let teacherWeekData = { schedules: [], substitutions: [] }; // GET /api/schedules/my-week, kept for the Schedule grid

const SESSION_LABELS = {
  pending: 'Upcoming', ongoing: 'In session', substituted: 'Substituted', no_teacher: 'No teacher', closed: 'Closed', cancelled: 'No classes',
};

function initTeacherPortal() {
  const today = manilaDate();
  ['teacher-analytics-date', 'teacher-export-date'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = today;
  });

  setText('teacher-today-date', `Today, ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);

  // Room filter for the export tab
  const exportRoomSelect = document.getElementById('teacher-export-room');
  if (exportRoomSelect && rooms.length > 0) {
    exportRoomSelect.innerHTML = '<option value="">All Classrooms</option>' +
      rooms.map(r => `<option value="${escapeHtml(r.name)}">${escapeHtml(r.name)}</option>`).join('');
  }

  // Update teacher name, email & avatar in sidebar & greeting
  if (currentTeacherUser && currentTeacherUser.name) {
    setText('teacher-greeting', `${greetingWord()}, ${currentTeacherUser.name}!`);
  }

  showTeacherTab('dashboard');
}

// ── Data helpers ──────────────────────────────────────────────

async function fetchTeacherDay(date) {
  const res = await axios.get(`${API_BASE}/api/sessions`, { params: { date } });
  return res.data.periods || [];
}

// One row per (period, student) of the given periods.
function rosterRows(periods) {
  return periods.flatMap(p => p.roster.map(st => ({
    period: p,
    student: st,
    status: st.log_status,   // null until the student has a log in the session
    badge: st.badge,         // log status, or upcoming / not_checked_in / no_teacher
    logId: st.log_id,
    time: st.log_time,
  })));
}

const periodLabel = p => `${shortTime(p.start_time)}–${shortTime(p.end_time)} ${p.subject?.name || ''}`.trim();
const timeOf = ts => (ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const csvCell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

// ── Teacher Tabs ──────────────────────────────────────────────

function showTeacherTab(tab) {
  const tabs = ['dashboard', 'schedule', 'classes', 'attendance', 'export', 'leave', 'settings'];
  tabs.forEach(t => {
    document.getElementById(`tch-tab-${t}`)?.classList.toggle('d-none', t !== tab);
    document.getElementById(`tablink-tch-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`sidebar-tch-${t}`)?.classList.toggle('active', t === tab);
  });

  const sidebarTitle = document.getElementById('teacher-sidebar-title');
  const sidebarDesc = document.getElementById('teacher-sidebar-desc');
  const mobileTitle = document.getElementById('teacher-mobile-header-title');
  const welcomeDesc = document.getElementById('teacher-welcome-desc');

  if (tab === 'dashboard') {
    if (sidebarTitle) sidebarTitle.textContent = 'Dashboard';
    if (sidebarDesc) sidebarDesc.textContent = 'Today\'s attendance at a glance.';
    if (mobileTitle) mobileTitle.textContent = 'Dashboard';
    if (welcomeDesc) welcomeDesc.textContent = "Welcome back! Here's what's happening with your classes today.";
    loadTeacherDashboardData();
    stopTeacherAutoRefresh();
  } else if (tab === 'schedule' || tab === 'classes') {
    const isSchedule = tab === 'schedule';
    if (sidebarTitle) sidebarTitle.textContent = isSchedule ? 'Schedule' : 'Classes';
    if (sidebarDesc) sidebarDesc.textContent = isSchedule ? 'Your weekly timetable, including upcoming substitutions.' : "Your grades, sections and subjects, with each section's student list.";
    if (mobileTitle) mobileTitle.textContent = isSchedule ? 'Schedule' : 'Classes';
    if (welcomeDesc) welcomeDesc.textContent = isSchedule ? 'When and where you teach this week.' : 'Open a section to see its enrolled students.';
    loadTeacherWeek();
    stopTeacherAutoRefresh();
  } else if (tab === 'attendance') {
    if (sidebarTitle) sidebarTitle.textContent = 'Attendance';
    if (sidebarDesc) sidebarDesc.textContent = 'Pick a date to see each class roster and override individual records.';
    if (mobileTitle) mobileTitle.textContent = 'Attendance';
    if (welcomeDesc) welcomeDesc.textContent = 'Live roster per class period with manual status override.';
    loadTeacherAttendance();
    startTeacherAutoRefresh();
  } else if (tab === 'export') {
    if (sidebarTitle) sidebarTitle.textContent = 'Export Attendance';
    if (sidebarDesc) sidebarDesc.textContent = 'Generate official Department of Education attendance log sheets.';
    if (mobileTitle) mobileTitle.textContent = 'Export Attendance';
    if (welcomeDesc) welcomeDesc.textContent = 'Download CSV or print daily attendance rosters.';
    generateTeacherExportPreview();
    stopTeacherAutoRefresh();
  } else if (tab === 'leave') {
    if (sidebarTitle) sidebarTitle.textContent = 'Student Leave Requests';
    if (sidebarDesc) sidebarDesc.textContent = 'Review student medical, emergency, and excuse submissions.';
    if (mobileTitle) mobileTitle.textContent = 'Student Leave Requests';
    if (welcomeDesc) welcomeDesc.textContent = 'Review submitted excuse requests with supporting proof documents.';
    loadTeacherLeaveRequests();
    stopTeacherAutoRefresh();
  } else if (tab === 'settings') {
    openSettingsTab('teacher', 'tch', [sidebarTitle, sidebarDesc, mobileTitle, welcomeDesc]);
    stopTeacherAutoRefresh();
  }
}

function startTeacherAutoRefresh() {
  stopTeacherAutoRefresh();
  teacherAutoRefreshInterval = setInterval(() => {
    loadTeacherAttendance(true);
  }, 5000);
}

function stopTeacherAutoRefresh() {
  if (teacherAutoRefreshInterval) {
    clearInterval(teacherAutoRefreshInterval);
    teacherAutoRefreshInterval = null;
  }
}

// ── Tab 1: Dashboard (KPIs, attendance mix, recent taps) ───

async function loadTeacherDashboardData() {
  showNoClassBanner('tch-noclass-banner');
  try {
    const periods = await fetchTeacherDay(manilaDate());
    const rows = rosterRows(periods);
    const count = s => rows.filter(r => r.status === s).length;
    const present = count('present'), late = count('late'), excused = count('excused'), absent = count('absent');
    const logged = present + late + excused + absent;

    setText('tch-kpi-total', new Set(rows.map(r => r.student.id)).size);
    setText('tch-kpi-present', present);
    setText('tch-kpi-late', late);
    setText('tch-kpi-absent', absent);
    setText('tch-kpi-present-sub', logged > 0 ? `${Math.round(((present + late + excused) / logged) * 100)}% attendance` : 'No records yet');

    BpesCharts.statusDonut('tch-mix-chart', { present, late, excused, absent }, 'tch-mix-legend', 'No attendance records in your classes yet today.');
    renderTeacherRecent(rows);
  } catch (err) {
    console.error('Teacher dashboard data error:', err);
  }
}

// Schedule and Classes tabs share one fetch of the teacher's timetable.
async function loadTeacherWeek() {
  try {
    teacherWeekData = (await axios.get(`${API_BASE}/api/schedules/my-week`)).data;
  } catch (err) {
    console.error('Teacher timetable error:', err);
    teacherWeekData = { schedules: [], substitutions: [] };
    ['tch-week-list', 'tch-classes-list'].forEach(id => { const el = document.getElementById(id); if (el) el.innerHTML = '<div class="small text-danger">Could not load your timetable. Try again.</div>'; });
    return;
  }
  renderTeacherWeek(teacherWeekData);
  renderTeacherClasses(teacherWeekData);
}

function renderTeacherWeek({ schedules = [], substitutions = [] }) {
  const box = document.getElementById('tch-week-list');
  if (!box) return;
  const byDay = {};
  schedules.forEach(s => (byDay[s.day_of_week] ||= []).push(s));
  const days = Object.keys(byDay);
  const lines = days.map(d => `
    <div class="mb-2">
      <div class="fw-bold small text-dark">${escapeHtml(d)}</div>
      ${byDay[d].map(s => `<div class="small text-muted">${shortTime(s.start_time)}–${shortTime(s.end_time)} · ${escapeHtml(s.subjects?.name || '—')} · ${escapeHtml(s.sections?.section_name || '')} · ${escapeHtml(s.rooms?.name || '—')}</div>`).join('')}
    </div>`);
  const subs = substitutions.map(x => `
    <div class="small text-warning-emphasis">Substituting ${escapeHtml(x.override_date)}: ${shortTime(x.schedule.start_time)}–${shortTime(x.schedule.end_time)} · ${escapeHtml(x.schedule.subjects?.name || '—')} · ${escapeHtml(x.schedule.sections?.section_name || '')}</div>`);
  box.innerHTML = days.length || subs.length
    ? lines.join('') + subs.join('')
    : '<div class="small text-muted">No timetable assigned to you yet.</div>';
}

// ── My Classes: Grade > Section > Subjects (TeacherSchedule.groupTeacherClasses) ──

function renderTeacherClasses({ schedules = [] }) {
  const box = document.getElementById('tch-classes-list');
  if (!box) return;
  const groups = TeacherSchedule.groupTeacherClasses(schedules, currentTeacherUser?.id);
  const sectionCount = groups.reduce((n, g) => n + g.sections.length, 0);
  setText('tch-classes-pill', `${sectionCount} section${sectionCount === 1 ? '' : 's'}`);
  if (!groups.length) {
    box.innerHTML = '<div class="small text-muted">No classes assigned yet.</div>';
    return;
  }
  // Compact: one line per subject. Grades are collapsed; keep the ones the teacher opened across a refresh.
  const subjectHtml = sub => `
    <div class="small lh-sm mb-1"><span class="fw-medium text-dark">${escapeHtml(sub.name)}</span>${sub.role === 'co' ? ' <span class="badge bg-warning-subtle text-dark border">co-teacher</span>' : ''}
      <span class="text-muted">${sub.slots.map(sl => `${escapeHtml(sl.day.slice(0, 3))} ${shortTime(sl.start_time)}&ndash;${shortTime(sl.end_time)}`).join(' &middot; ')}</span></div>`;
  const open = new Set([...box.querySelectorAll('.collapse.show')].map(e => e.id));
  box.innerHTML = groups.map(g => {
    const id = `tch-grade-${g.grade ?? 'other'}`;
    const n = g.sections.length;
    const isOpen = open.has(id);
    return `
    <div class="border rounded-3 mb-2">
      <button type="button" class="tch-grade-toggle${isOpen ? '' : ' collapsed'}" data-bs-toggle="collapse" data-bs-target="#${id}" aria-expanded="${isOpen}" aria-controls="${id}">
        <span class="fw-bold text-dark">${g.grade ? `Grade ${g.grade}` : 'Other'}</span>
        <span class="small text-muted text-truncate me-auto">${n} section${n === 1 ? '' : 's'} &middot; ${g.sections.map(sec => escapeHtml(sec.section_name)).join(', ')}</span>
        <i class="fas fa-chevron-down small text-muted" aria-hidden="true"></i>
      </button>
      <div class="collapse${isOpen ? ' show' : ''}" id="${id}">
        <div class="row g-2 px-3 pb-3">
          ${g.sections.map(sec => `
            <div class="col-md-6">
              <div class="d-flex align-items-center justify-content-between gap-2 mb-1">
                <div class="fw-bold small text-success-emphasis">${escapeHtml(sec.section_name)}</div>
                <button type="button" class="bpes-btn-outline bpes-btn-sm" data-section-id="${escapeHtml(sec.section_id)}" data-section-name="${escapeHtml(sec.section_name)}" onclick="openTeacherStudents(this)"><i class="fas fa-users me-1"></i>Students</button>
              </div>
              ${sec.subjects.map(subjectHtml).join('')}
            </div>`).join('')}
        </div>
      </div>
    </div>`;
  }).join('');
}

// Masterlist modal, created once on <body> like the schedule modal. Server returns names alphabetical; 403 if not the teacher's section.
async function openTeacherStudents(btn) {
  const { sectionId, sectionName } = btn.dataset;
  let el = document.getElementById('tch-students-modal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tch-students-modal';
    el.className = 'modal fade';
    el.tabIndex = -1;
    el.setAttribute('aria-labelledby', 'tch-students-title');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <div class="modal-dialog modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="tch-students-title"></h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body" id="tch-students-body"></div>
        </div>
      </div>`;
    document.body.appendChild(el);
  }
  const title = document.getElementById('tch-students-title');
  const body = document.getElementById('tch-students-body');
  title.textContent = `${sectionName} \u2014 Students`;
  body.innerHTML = '<div class="text-center text-muted py-4">Loading students...</div>';
  bootstrap.Modal.getOrCreateInstance(el).show();
  try {
    const { data } = await axios.get(`${API_BASE}/api/sections/${encodeURIComponent(sectionId)}/students`);
    const list = Array.isArray(data) ? data : (data.students || []);
    title.textContent = `${sectionName} \u2014 Students (${list.length})`;
    body.innerHTML = list.length
      ? `<table class="bpes-table"><thead><tr><th>Name</th><th>LRN</th></tr></thead><tbody>${list.map(s => `<tr><td>${escapeHtml(s.full_name)}</td><td>${escapeHtml(s.student_id || '\u2014')}</td></tr>`).join('')}</tbody></table>`
      : '<div class="text-center text-muted py-4">No students enrolled</div>';
  } catch (err) {
    body.innerHTML = `<div class="text-center text-danger py-4">${escapeHtml(err.response?.data?.error || 'Could not load students.')}</div>`;
  }
}

// ── Schedule grid: days across, hours down (window.TeacherSchedule, js/teacher-schedule.js) ──

function renderTeacherScheduleGrid() {
  const box = document.getElementById('tch-schedule-grid');
  if (!box) return;
  const cal = TeacherSchedule.buildWeekCalendar(teacherWeekData.schedules, currentTeacherUser?.id);
  if (!cal.hours.length) {
    box.innerHTML = '<div class="text-center text-muted py-4">No classes assigned yet.</div>';
    return;
  }
  box.innerHTML = weekCalendarHtml(cal, null,
    e => `
      <strong>${escapeHtml(e.subject)}</strong>
      <div>${escapeHtml(e.section)} &middot; ${escapeHtml(e.room)}</div>
      <div>${shortTime(e.start_time)}&ndash;${shortTime(e.end_time)}${e.role === 'co' ? ' &middot; co-teacher' : ''}</div>`,
    e => (e.role === 'co' ? 'bg-warning-subtle' : 'bg-success-subtle'));
}

// The modal lives on <body> (created once), so leaving and re-entering the portal never duplicates it.
function openTeacherScheduleModal() {
  let el = document.getElementById('tch-schedule-modal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tch-schedule-modal';
    el.className = 'modal fade';
    el.tabIndex = -1;
    el.setAttribute('aria-labelledby', 'tch-schedule-title');
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <div class="modal-dialog modal-xl modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="tch-schedule-title"><i class="fas fa-table me-2"></i>My weekly schedule</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body" id="tch-schedule-grid"></div>
        </div>
      </div>`;
    document.body.appendChild(el);
  }
  renderTeacherScheduleGrid();
  bootstrap.Modal.getOrCreateInstance(el).show();
}

function renderTeacherRecent(rows) {
  const tbody = document.getElementById('tch-recent-logs-tbody');
  if (!tbody) return;
  const recent = rows.filter(r => r.time).sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 5);
  setText('recent-scans-pill', `${recent.length} student${recent.length === 1 ? '' : 's'}`);
  tbody.innerHTML = recent.length === 0
    ? '<tr><td colspan="4" class="text-center py-4 text-muted">No student records in your classes today yet.</td></tr>'
    : recent.map(r => {
        const name = escapeHtml(r.student.full_name);
        return `
          <tr>
            <td>
              <div class="d-flex align-items-center gap-2">
                <div class="d-flex align-items-center justify-content-center fw-bold text-white small" style="width: 30px; height: 30px; border-radius: 50%; background: #14532D; flex-shrink: 0;">${name.charAt(0).toUpperCase()}</div>
                <strong>${name}</strong>
              </div>
            </td>
            <td>${statusBadge(r.badge)}</td>
            <td>${escapeHtml(r.period.room || '—')}</td>
            <td>${timeOf(r.time)}</td>
          </tr>`;
      }).join('');
}

// ── Tab 2: Attendance rosters & inline override ───

function fillTeacherSectionFilter(periods) {
  const el = document.getElementById('teacher-section-filter');
  if (!el) return;
  const prev = el.value;
  const names = [...new Set(periods.map(p => p.section).filter(Boolean))].sort();
  el.innerHTML = '<option value="">All Sections</option>' +
    names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  if (names.includes(prev)) el.value = prev;
}

async function loadTeacherAttendance(isSilent = false) {
  const tbody = document.getElementById('tch-attendance-tbody');
  if (!tbody) return;
  const date = document.getElementById('teacher-analytics-date')?.value || manilaDate();

  try {
    const all = await fetchTeacherDay(date);
    fillTeacherSectionFilter(all);
    const sectionFilter = document.getElementById('teacher-section-filter')?.value;
    const periods = all.filter(p => !sectionFilter || p.section === sectionFilter);
    currentTeacherPeriods = periods;

    const rows = rosterRows(periods);
    setText('attendance-count-pill', `${rows.length} students`);
    setText('tch-attendance-count-label', `Showing ${rows.length} student${rows.length === 1 ? '' : 's'} across ${periods.length} class${periods.length === 1 ? '' : 'es'}`);

    teacherOverrideRows = new Map();
    if (periods.length === 0) {
      if (!isSilent) tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-muted">No classes assigned to you on this date.</td></tr>';
      return;
    }

    tbody.innerHTML = periods.map(p => {
      const header = `
        <tr class="table-light">
          <td colspan="6">
            <strong>${shortTime(p.start_time)}–${shortTime(p.end_time)} · ${escapeHtml(p.subject?.name || '—')}</strong>
            <span class="bpes-cell-sub d-inline ms-2">${escapeHtml(p.section || '')} · ${escapeHtml(p.room || '—')}</span>
            <span class="badge bg-light text-dark border ms-2">${escapeHtml(SESSION_LABELS[p.session_status] || p.session_status)}</span>
          </td>
        </tr>`;
      if (p.roster.length === 0) {
        return header + '<tr><td colspan="6" class="text-center py-4 text-muted">No students in this section.</td></tr>';
      }
      return header + p.roster.map(st => {
        const name = escapeHtml(st.full_name);
        if (st.log_id) teacherOverrideRows.set(st.log_id, { name: st.full_name, lrn: st.student_id, label: periodLabel(p), status: st.log_status });
        const action = st.log_id
          ? `<button class="bpes-btn-outline bpes-btn-sm" onclick="selectTeacherOverride('${st.log_id}')"><span>Override</span></button>`
          : '<span class="bpes-cell-muted">No record yet</span>';
        return `
          <tr>
            <td>
              <div class="d-flex align-items-center gap-2">
                <div class="d-flex align-items-center justify-content-center fw-bold text-white small" style="width: 30px; height: 30px; border-radius: 50%; background: #14532D; flex-shrink: 0;">${name.charAt(0).toUpperCase()}</div>
                <strong>${name}</strong>
              </div>
            </td>
            <td><span class="bpes-cell-lrn">${escapeHtml(st.student_id)}</span></td>
            <td>${escapeHtml(p.subject?.name || '—')}</td>
            <td>${statusBadge(st.badge)}</td>
            <td>${timeOf(st.log_time)}</td>
            <td>${action}</td>
          </tr>`;
      }).join('');
    }).join('');
  } catch (err) {
    if (!isSilent) {
      console.error('Error fetching teacher attendance', err);
      tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-warning">Could not load attendance records.</td></tr>';
    }
  }
}

function selectTeacherOverride(logId) {
  const r = teacherOverrideRows.get(logId);
  if (r) selectStudentForInlineOverride(logId, r.name, r.lrn, r.label, r.status);
}

function selectStudentForInlineOverride(logId, studentName, lrn, classLabel, currentStatus) {
  const hiddenId = document.getElementById('override-log-id');
  const nameEl = document.getElementById('override-student-name');
  const metaEl = document.getElementById('override-meta');
  const submitBtn = document.getElementById('override-submit-btn');

  if (hiddenId) hiddenId.value = logId;
  if (nameEl) nameEl.textContent = studentName;
  if (metaEl) metaEl.textContent = `LRN: ${lrn} | ${classLabel} | Current: ${String(currentStatus).toUpperCase()}`;
  if (submitBtn) submitBtn.disabled = false;

  setOverrideStatus(currentStatus || 'present');
}

function setOverrideStatus(status) {
  const statusInput = document.getElementById('override-status-select');
  if (statusInput) statusInput.value = status;

  document.querySelectorAll('.override-status-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-status') === status);
  });
}

async function submitAttendanceOverride(e) {
  e.preventDefault();
  const btn = document.getElementById('override-submit-btn');
  const logId = document.getElementById('override-log-id')?.value;
  const newStatus = document.getElementById('override-status-select')?.value || 'present';
  const reason = document.getElementById('override-reason')?.value.trim();

  if (!logId) {
    alert('Please click "Override" on a student row first.');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span> Saving...';
  }

  try {
    await axios.patch(`${API_BASE}/api/override/${logId}`, {
      new_status: newStatus,
      reason: reason || 'Manual instructor adjustment'
    });

    notify('teacher', `Attendance status updated to ${newStatus.toUpperCase()}!`, 'success');
    document.getElementById('override-form')?.reset();
    document.getElementById('override-log-id').value = '';
    document.getElementById('override-student-name').textContent = 'Select a student';
    document.getElementById('override-meta').textContent = 'Click "Override" on any row to begin';

    await loadTeacherAttendance();
    await loadTeacherDashboardData();
  } catch (err) {
    const msg = err.response?.data?.error || err.message || 'Failed to update attendance status';
    notify('teacher', `Override error: ${msg}`, 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>Confirm override</span>';
    }
  }
}

// ── Tab 3: Export Attendance Sheet ──────────

// Rows for the export date (and room, when chosen), straight from the server.
async function loadExportRows() {
  const date = document.getElementById('teacher-export-date')?.value || manilaDate();
  const roomFilter = document.getElementById('teacher-export-room')?.value;
  const periods = (await fetchTeacherDay(date)).filter(p => !roomFilter || p.room === roomFilter);
  return { date, rows: rosterRows(periods) };
}

async function generateTeacherExportPreview() {
  const tbody = document.getElementById('tch-export-tbody');
  if (!tbody) return;

  try {
    const { date, rows } = await loadExportRows();
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center py-4 text-muted">No attendance records found for ${escapeHtml(date)}.</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map((r, index) => `
      <tr>
        <td>${index + 1}</td>
        <td><code>${escapeHtml(r.student.student_id)}</code></td>
        <td class="fw-bold">${escapeHtml(r.student.full_name)}</td>
        <td><span class="badge bg-light text-dark border">${escapeHtml(r.period.section || '—')}</span></td>
        <td>${escapeHtml(r.period.room || '—')}</td>
        <td>${statusBadge(r.badge)}</td>
        <td>${timeOf(r.time)}</td>
      </tr>`).join('');
  } catch (err) {
    console.error('Export preview error', err);
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-warning">Could not load attendance records.</td></tr>';
  }
}

async function printAttendanceReport() {
  await generateTeacherExportPreview();
  window.print();
}

async function exportAttendanceCsv() {
  const { date, rows } = await loadExportRows();
  let csv = 'No.,LRN,Student Full Name,Section,Subject,Room,Status,Time\n';
  rows.forEach((r, index) => {
    csv += [index + 1, r.student.student_id, r.student.full_name, r.period.section, r.period.subject?.name,
      r.period.room, r.badge, r.time ? new Date(r.time).toLocaleTimeString() : ''].map(csvCell).join(',') + '\n';
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.setAttribute('download', `Attendance_Report_${date}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ── Tab 4: Student Leave Requests ───────────

async function loadTeacherLeaveRequests() {
  const tbody = document.getElementById('tch-leave-table-tbody');
  const countPill = document.getElementById('leave-requests-pill');
  if (!tbody) return;

  try {
    const res = await axios.get(`${API_BASE}/api/leave`);
    const requests = res.data.leave_requests || [];

    const pending = requests.filter(r => r.status === 'pending').length;
    const approved = requests.filter(r => r.status === 'approved').length;
    const declined = requests.filter(r => r.status === 'rejected' || r.status === 'declined').length;

    setText('tch-leave-pending-count', pending);
    setText('tch-leave-approved-count', approved);
    setText('tch-leave-declined-count', declined);
    setText('tch-leave-total-count', requests.length);

    if (countPill) countPill.textContent = `${requests.length} requests`;

    if (requests.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted">No excuse or leave requests submitted yet.</td></tr>`;
      return;
    }

    tbody.innerHTML = requests.map(req => {
      const student = req.students;
      const studentName = student ? escapeHtml(student.full_name) : 'Student';
      const studentId = student ? escapeHtml(student.student_id) : '--';

      const subject = leaveLabel(req);
      const displayReason = leaveReasonText(req);
      const filedBy = leaveFiledBy(req);

      const leaveDate = req.leave_date || 'Date';
      const leaveBadge = getLeaveStatusBadge(req.status);
      const isPending = req.status === 'pending';

      return `
        <tr>
          <td>
            <strong>${studentName}</strong>
            <span class="bpes-cell-sub">LRN: ${studentId}</span>
          </td>
          <td>${escapeHtml(subject)}</td>
          <td>${escapeHtml(leaveDate)}</td>
          <td><div>${escapeHtml(displayReason)}${filedBy ? `<span class="bpes-cell-sub">Filed by: ${escapeHtml(filedBy)}</span>` : ''}${leaveAttachmentLinks(req)}</div></td>
          <td>${leaveBadge}</td>
          <td>
            ${isPending ? `
              <div class="d-flex gap-2">
                <button class="bpes-btn-primary bpes-btn-sm bpes-review-btn" onclick="handleReviewLeave('${req.id}', 'approved')">Approve</button>
                <button class="bpes-btn-outline bpes-btn-sm bpes-review-btn text-danger" onclick="handleReviewLeave('${req.id}', 'rejected')">Decline</button>
              </div>
            ` : `
              <span class="bpes-cell-muted">Reviewed</span>
            `}
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Error fetching teacher leave requests:', err);
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-warning">Could not load leave requests.</td></tr>`;
  }
}

async function handleReviewLeave(leaveId, action) {
  try {
    await axios.patch(`${API_BASE}/api/leave/${leaveId}`, { action });
    notify('teacher', `Leave request ${action === 'approved' ? 'Approved' : 'Declined'} successfully!`, 'success');
    await loadTeacherLeaveRequests();
  } catch (err) {
    const msg = err.response?.data?.error || err.message || 'Failed to update request';
    notify('teacher', `Error: ${msg}`, 'danger');
  }
}

function getLeaveStatusBadge(status) {
  const s = String(status || 'pending').toLowerCase();
  if (s === 'approved') return '<span class="bpes-badge bpes-badge-approved"><i class="fas fa-check"></i> Approved</span>';
  if (s === 'rejected' || s === 'declined') return '<span class="bpes-badge bpes-badge-declined"><i class="fas fa-times"></i> Declined</span>';
  return '<span class="bpes-badge bpes-badge-pending"><i class="fas fa-clock"></i> Pending</span>';
}
