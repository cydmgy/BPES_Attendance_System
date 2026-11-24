// ============================================================
// ADMINISTRATOR PORTAL CONTROLLER
// Tap-to-Enroll, Teachers Directory, and Real-Time Live Taps
// ============================================================

let tapPollInterval = null;
let logsAutoRefreshInterval = null;
let isScanningRfid = false;
let rfidTargetInputId = 'enroll-rfid-input';
let rfidCaptureHandler = null;
let sections = [];
let schedules = [];

function initAdminPortal() {
  startLiveClock(() => {
    setText('admin-date-pill', manilaTodayLabel());
    const dateFormatted = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Manila', day: '2-digit', month: 'short', year: 'numeric' });
    setText('adm-stream-date-display', `Today, ${dateFormatted}`);
    refreshGreeting('admin-greeting');
  });
  BpesProfile.load();

  // Set default enrollment date to today
  const enrollDateInput = document.getElementById('enroll-date-input');
  if (enrollDateInput) {
    enrollDateInput.value = manilaDate();
  }

  populateAdminSectionFilter();

  const greeting = document.getElementById('admin-greeting');
  if (greeting) greeting.textContent = `${greetingWord()}, Admin!`;
  showAdminTab('dashboard');
  loadAdminSections();
  loadAdminStudents();
  loadAdminTeachers();

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('triggerScan') === '1') {
    setTimeout(() => {
      startTapToEnrollInline();
    }, 400);
  }
}

function populateAdminSectionFilter() {
  const el = document.getElementById('adm-log-section-filter');
  if (!el) return;

  const sectionSet = new Set();
  (students || []).forEach(s => {
    if (s.section && typeof s.section === 'string' && s.section.trim()) {
      sectionSet.add(s.section.trim());
    }
  });

  const sortedSections = Array.from(sectionSet).sort();
  if (sortedSections.length > 0) {
    el.innerHTML = '<option value="">All sections</option>' +
      sortedSections.map(sec => `<option value="${escapeHtml(sec)}">${escapeHtml(sec)}</option>`).join('');
  }
}

// ── Admin Tabs ────────────────────────────────────────────────

const ADMIN_TABS = {
  dashboard: ['Dashboard', 'School-wide numbers and today\'s attendance at a glance.',
              'School-wide numbers and today\'s attendance at a glance.'],
  students:  ['Student Enrollment', 'Tap-to-enroll workflow, enrolled students, and system summaries.',
              'Manage student enrollment, review enrolled students, and monitor system health.'],
  teachers:  ['Teachers', 'Manage teacher registration, review registered teachers, and monitor system health.',
              'Manage teacher registration, review registered teachers, and monitor system health.'],
  sections:  ['Sections', 'Create sections and choose the home room where each one has its classes.',
              'Create sections and choose the home room where each one has its classes.'],
  subjects:  ['Subjects', 'Add, edit and remove the subjects offered by the school.',
              'Add, edit and remove the subjects offered by the school.'],
  rooms:     ['Rooms', 'Add, edit and remove rooms and the RFID reader assigned to each.',
              'Add, edit and remove rooms and the RFID reader assigned to each.'],
  schedules: ['Schedules', 'Build the weekly timetable. Rooms, teachers and sections can never be double-booked.',
              'Build the weekly timetable. Rooms, teachers and sections can never be double-booked.'],
  logs:      ['Attendance Stream', 'Monitor live RFID taps, review attendance by section, and keep room coverage up to date.',
              'Monitor live RFID taps, review attendance by section, and keep room coverage up to date.'],
  noclass:   ['No class days', 'Holidays and suspensions. Adding a day cancels that day\'s unfinished class periods.',
              'Add holidays and suspensions, or lift a no-class day.'],
  audit:     ['Audit log', 'Who changed what, and when.', 'See who changed something, for transparency.'],
  settings:  ['Settings', 'Your account name and password.', 'Manage your account name and password.'],
};

function showAdminTab(tab) {
  Object.keys(ADMIN_TABS).forEach(t => {
    document.getElementById(`adm-tab-${t}`)?.classList.toggle('d-none', t !== tab);
    document.getElementById(`tablink-adm-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`sidebar-adm-${t}`)?.classList.toggle('active', t === tab);
  });

  const [title, sideDesc, welcomeDesc] = ADMIN_TABS[tab];
  const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  setText('admin-sidebar-title', title);
  setText('admin-sidebar-desc', sideDesc);
  setText('admin-mobile-header-title', title);
  setText('admin-welcome-desc', welcomeDesc);

  if (tab === 'logs') {
    loadAdminLogs();
    startAutoRefreshLogs();
    return;
  }
  stopAutoRefreshLogs();
  if (tab === 'settings') BpesSettings.mount(document.getElementById('adm-tab-settings'), 'admin');
  else if (tab === 'dashboard') loadAdminDashboard();
  else if (tab === 'noclass') loadNoClassDays();
  else if (tab === 'audit') loadAudit(true);
  else if (tab === 'students') loadAdminStudents();
  else if (tab === 'teachers') loadAdminTeachers();
  else if (tab === 'sections') loadAdminSections();
  else if (tab === 'subjects') loadAdminSubjects();
  else if (tab === 'rooms') loadAdminRooms();
  else if (tab === 'schedules') { loadAdminSections().then(refreshScheduleAvailability); loadAdminSchedules(); }
}

// ── Dashboard ─────────────────────────────────────────────────

const DASH_COUNTS = {
  students: 'dash-students', teachers: 'dash-teachers', sections: 'dash-sections', subjects: 'dash-subjects',
  rooms: 'dash-rooms', active_schedules: 'dash-schedules', pending_leave: 'dash-leave',
};

// Overview numbers, today's mix and the 14-day trend load side by side; each part fails on its own,
// showing "—" or an empty chart instead of a fake zero.
async function loadAdminDashboard() {
  const set = (id, value) => { const el = byId(id); if (el) el.textContent = value; };
  const [overview, today, trend] = await Promise.allSettled([
    axios.get(`${API_BASE}/api/stats/overview`),
    axios.get(`${API_BASE}/api/attendance/daily`),
    axios.get(`${API_BASE}/api/attendance/trend`, { params: { days: 14 } }),
  ]);

  if (overview.status === 'fulfilled') {
    const data = overview.value.data;
    Object.entries(DASH_COUNTS).forEach(([key, id]) => set(id, data[key] ?? '—'));
    BpesCharts.barList('dash-sections-chart', (data.students_per_section || []).map(x => ({ label: x.section, value: x.count })), 'Students');
  } else {
    Object.values(DASH_COUNTS).forEach(id => set(id, '—')); // unknown, not zero
    BpesCharts.barList('dash-sections-chart', []);
    notify('admin', errMsg(overview.reason, 'Could not load dashboard numbers'), 'danger');
  }

  const summary = today.status === 'fulfilled' ? today.value.data.summary : null;
  set('dash-rate', summary?.attendance_rate == null ? '—' : `${summary.attendance_rate}%`);
  BpesCharts.statusDonut('dash-today-chart', summary || {}, 'dash-today-legend', 'No attendance records yet today.');

  BpesCharts.trendBars('dash-trend-chart', trend.status === 'fulfilled' ? trend.value.data.days : []);
}

function startAutoRefreshLogs() {
  stopAutoRefreshLogs();
  logsAutoRefreshInterval = setInterval(() => {
    loadAdminLogs(true);
  }, 3000);
}

function stopAutoRefreshLogs() {
  if (logsAutoRefreshInterval) {
    clearInterval(logsAutoRefreshInterval);
    logsAutoRefreshInterval = null;
  }
}

// ── Interactive RFID Tap Scanner Modal & Sound Effect ──────────

function playRfidChirp() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    // Melodic positive chime (880Hz A5 -> 1320Hz E6)
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) {
    // Audio synthesis blocked by browser autoplay policy
  }
}

function openRfidScanModal() {
  const modal = document.getElementById('rfid-scan-modal');
  if (!modal) return;

  // Reset modal state to active listening
  const radar = document.getElementById('rfid-modal-radar');
  const iconCircle = document.getElementById('rfid-modal-icon-circle');
  const icon = document.getElementById('rfid-modal-icon');
  const badge = document.getElementById('rfid-modal-badge');
  const dot = document.getElementById('rfid-modal-dot');
  const badgeText = document.getElementById('rfid-modal-badge-text');
  const title = document.getElementById('rfid-modal-title');
  const desc = document.getElementById('rfid-modal-desc');
  const cardInfo = document.getElementById('rfid-modal-card-info');
  const cancelBtn = document.getElementById('rfid-modal-cancel-btn');

  if (radar) radar.classList.remove('stopped');
  if (iconCircle) iconCircle.classList.remove('detected');
  if (icon) icon.className = 'fas fa-id-card';
  if (badge) badge.classList.remove('detected');
  if (dot) dot.classList.remove('detected');
  if (badgeText) badgeText.textContent = 'SCANNER ACTIVE';
  if (title) title.textContent = 'Waiting for RFID Scan...';
  if (desc) desc.textContent = "Please tap or hold the student's RFID card on the reader.";
  if (cardInfo) cardInfo.classList.add('d-none');
  if (cancelBtn) {
    cancelBtn.innerHTML = '<i class="fas fa-times me-1"></i> Cancel Scan';
    cancelBtn.className = 'bpes-btn-outline px-4 py-2';
  }

  modal.classList.add('active');
}

function closeRfidScanModal() {
  const modal = document.getElementById('rfid-scan-modal');
  if (modal) modal.classList.remove('active');

  if (isScanningRfid) rfidCaptureHandler = null; // cancelled before a card was read
  stopTapPolling();
  isScanningRfid = false;

  const statusText = document.getElementById('rfid-scan-status-text');
  const scanIcon = document.getElementById('rfid-scan-icon');
  const scanBtn = document.getElementById('btn-scan-rfid');
  const rfidInput = document.getElementById(rfidTargetInputId);

  if (scanIcon) scanIcon.style.animation = 'none';

  // If already detected, keep the detected label
  if (rfidInput && rfidInput.value.trim()) {
    if (statusText) statusText.innerHTML = `<span class="text-success fw-bold"><i class="fas fa-check-circle me-1"></i> Card detected: ${escapeHtml(rfidInput.value)}</span>`;
    if (scanBtn) scanBtn.innerHTML = '<i class="fas fa-rotate me-2"></i> Rescan RFID card';
  } else {
    if (statusText) statusText.textContent = 'Ready to enroll';
    if (scanBtn) scanBtn.innerHTML = '<i class="fas fa-id-card me-2"></i> Scan RFID card';
  }
}

function handleRfidModalBackdropClick(e) {
  if (e.target.id === 'rfid-scan-modal') {
    closeRfidScanModal();
  }
}

// ── Tap to Enroll Inline Workflow ────────────

// targetInputId: input that receives the UID ('' for none). onCapture(uid): optional callback once a card is read.
async function startTapToEnrollInline(targetInputId = 'enroll-rfid-input', onCapture = null) {
  rfidTargetInputId = targetInputId;
  rfidCaptureHandler = onCapture;
  const statusText = document.getElementById('rfid-scan-status-text');
  const scanIcon = document.getElementById('rfid-scan-icon');
  const scanBtn = document.getElementById('btn-scan-rfid');
  const rfidInput = document.getElementById(targetInputId);

  isScanningRfid = true;
  if (statusText) statusText.textContent = 'Waiting for RFID card tap...';
  if (scanBtn) scanBtn.innerHTML = '<i class="fas fa-times me-2"></i> Cancel Scan';
  if (scanIcon) scanIcon.style.animation = 'pulse 1s infinite';

  // Pop out interactive modal window
  openRfidScanModal();

  try {
    await axios.post(`${API_BASE}/api/scan/clear-tap`).catch(() => null);
  } catch (e) {}

  stopTapPolling();
  tapPollInterval = setInterval(async () => {
    try {
      const res = await axios.get(`${API_BASE}/api/scan/latest-tap`);
      const scan = res.data.scan;

      if (scan && scan.uid) {
        stopTapPolling();
        isScanningRfid = false;
        const uid = scan.formatted || scan.uid;

        // Play feedback sound
        playRfidChirp();

        if (rfidCaptureHandler) {
          const handler = rfidCaptureHandler;
          rfidCaptureHandler = null;
          handler(uid);
        }

        // Update form input and highlight it
        if (rfidInput) {
          rfidInput.value = uid;
          rfidInput.style.borderColor = 'var(--color-primary)';
          rfidInput.style.boxShadow = '0 0 0 3px rgba(15, 76, 58, 0.15)';
        }

        // Update modal UI interactively
        const radar = document.getElementById('rfid-modal-radar');
        const iconCircle = document.getElementById('rfid-modal-icon-circle');
        const icon = document.getElementById('rfid-modal-icon');
        const badge = document.getElementById('rfid-modal-badge');
        const dot = document.getElementById('rfid-modal-dot');
        const badgeText = document.getElementById('rfid-modal-badge-text');
        const title = document.getElementById('rfid-modal-title');
        const desc = document.getElementById('rfid-modal-desc');
        const cardInfo = document.getElementById('rfid-modal-card-info');
        const cardUidEl = document.getElementById('rfid-modal-card-uid');
        const cancelBtn = document.getElementById('rfid-modal-cancel-btn');

        if (radar) radar.classList.add('stopped');
        if (iconCircle) iconCircle.classList.add('detected');
        if (icon) icon.className = 'fas fa-check';
        if (badge) badge.classList.add('detected');
        if (dot) dot.classList.add('detected');
        if (badgeText) badgeText.textContent = 'CARD DETECTED';
        if (title) title.textContent = 'Card Scanned Successfully!';
        if (desc) desc.textContent = 'RFID UID captured. Attaching to student enrollment.';
        if (cardUidEl) cardUidEl.textContent = uid;
        if (cardInfo) cardInfo.classList.remove('d-none');
        if (cancelBtn) {
          cancelBtn.innerHTML = '<i class="fas fa-check me-1"></i> Continue';
          cancelBtn.className = 'bpes-btn px-4 py-2 text-white';
          cancelBtn.style.background = 'var(--color-primary)';
        }

        // Update background inline scan status
        if (statusText) statusText.innerHTML = `<span class="text-success fw-bold"><i class="fas fa-check-circle me-1"></i> Card detected: ${escapeHtml(uid)}</span>`;
        if (scanBtn) scanBtn.innerHTML = '<i class="fas fa-rotate me-2"></i> Rescan RFID card';
        if (scanIcon) scanIcon.style.animation = 'none';

        // Auto-close after 1.4 seconds of visual confirmation
        setTimeout(() => {
          const modal = document.getElementById('rfid-scan-modal');
          if (modal && modal.classList.contains('active')) {
            closeRfidScanModal();
          }
        }, 1400);
      }
    } catch (err) {
      console.error('Tap poll error', err);
    }
  }, 800);
}

function stopTapPolling() {
  if (tapPollInterval) {
    clearInterval(tapPollInterval);
    tapPollInterval = null;
  }
}

async function submitInlineEnrollForm(e) {
  e.preventDefault();
  const btns = document.querySelectorAll('.enroll-submit'); // phone copy inside the form + desktop copy beside the scan panel
  const studentId = document.getElementById('enroll-id-input')?.value.trim();
  const fullName = document.getElementById('enroll-name-input')?.value.trim();
  const sectionId = document.getElementById('enroll-section-input')?.value;
  const rfidUid = document.getElementById('enroll-rfid-input')?.value.trim();

  // Guardian details
  const guardianName = document.getElementById('enroll-guardian-name')?.value.trim();
  const guardianPhone = document.getElementById('enroll-guardian-phone')?.value.trim();
  const guardianRelation = document.getElementById('enroll-guardian-relation')?.value;

  btns.forEach(btn => {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span> Enrolling...';
  });

  try {
    const res = await axios.post(`${API_BASE}/api/students`, {
      student_id: studentId,
      full_name: fullName,
      rfid_uid: rfidUid,
      course: 'Elementary',
      year_level: 1,
      section_id: sectionId,
      guardian: {
        full_name: guardianName,
        phone_number: guardianPhone,
        relationship: guardianRelation || 'Parent'
      }
    });

    document.getElementById('enroll-pw-name').textContent = `${fullName} is now enrolled.`;
    document.getElementById('enroll-pw-value').textContent = res.data.temp_password || '(not returned)';
    const pwModalEl = document.getElementById('enroll-pw-modal');
    pwModalEl.addEventListener('hidden.bs.modal', () => { document.getElementById('enroll-pw-value').textContent = ''; }, { once: true });
    bootstrap.Modal.getOrCreateInstance(pwModalEl).show();
    document.getElementById('enrollment-form')?.reset();
    
    // Reset date input
    const enrollDateInput = document.getElementById('enroll-date-input');
    if (enrollDateInput) enrollDateInput.value = manilaDate();

    const statusText = document.getElementById('rfid-scan-status-text');
    if (statusText) statusText.textContent = 'Ready to enroll';

    const scanBtn = document.getElementById('btn-scan-rfid');
    if (scanBtn) scanBtn.innerHTML = '<i class="fas fa-id-card me-2"></i> Scan RFID card';

    const enrollRfidInput = document.getElementById('enroll-rfid-input');
    if (enrollRfidInput) {
      enrollRfidInput.style.borderColor = '';
      enrollRfidInput.style.boxShadow = '';
    }

    await loadSystemData();
    await loadAdminStudents();
  } catch (err) {
    const msg = err.response?.data?.error || err.message || 'Enrollment failed';
    notify('admin', `Enrollment error: ${msg}`, 'danger');
  } finally {
    btns.forEach(btn => {
      btn.disabled = false;
      btn.innerHTML = '<span>Enroll student</span>';
    });
  }
}

// ── Students Management & Table Rendering ─────────────────────

async function loadAdminStudents() {
  const tbody = document.getElementById('adm-students-tbody');
  if (!tbody) return;

  try {
    const res = await axios.get(`${API_BASE}/api/students`);
    students = res.data.students || [];

    const countPill = document.getElementById('enrolled-count-pill');
    if (countPill) countPill.textContent = `${students.length} students`;

    fillStudentSectionFilter();
    filterAdminStudents();
    populateAdminSectionFilter();
  } catch (err) {
    console.error('Error loading students:', err);
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-warning">Could not load students. Verify backend is running.</td></tr>`;
  }
}

function renderStudentsTable(list) {
  const tbody = document.getElementById('adm-students-tbody');
  const paginationLabel = document.getElementById('adm-students-pagination-label');
  if (!tbody) return;

  if (paginationLabel) {
    paginationLabel.textContent = `Showing ${list.length} of ${students.length} student record${students.length === 1 ? '' : 's'}`;
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted">${students.length ? 'No students match.' : 'No students enrolled yet.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(s => {
    const initials = s.full_name ? s.full_name.charAt(0).toUpperCase() : 'S';
    const guardian = (s.guardians && s.guardians.length > 0) ? s.guardians[0] : null;
    const guardianHtml = guardian ? `<div class="bpes-cell-sub mt-1"><i class="fas fa-user-shield text-success me-1"></i>${escapeHtml(guardian.full_name)} (${escapeHtml(guardian.relationship || 'Guardian')}: ${escapeHtml(guardian.phone_number || '')})</div>` : '';
    const rfidTag = (s.rfid_uid && s.rfid_uid !== '-') ? `<span>${escapeHtml(s.rfid_uid)}</span>` : `<span class="badge bg-warning text-dark"><i class="fas fa-clock me-1"></i>Pending RFID</span>`;

    return `
      <tr>
        <td>
          <div class="d-flex align-items-center gap-2">
            <div class="d-flex align-items-center justify-content-center fw-bold text-white small" style="width: 32px; height: 32px; border-radius: 50%; background: #14532D; flex-shrink: 0;">
              ${initials}
            </div>
            <div>
              <div class="fw-bold">${escapeHtml(s.full_name)}</div>
              <div class="bpes-cell-sub">${escapeHtml(s.student_id)}</div>
              ${guardianHtml}
            </div>
          </div>
        </td>
        <td><span class="badge bg-light text-dark border">Grade ${s.year_level || 1} &bull; ${escapeHtml(s.section || 'Diamond')}</span></td>
        <td>${rfidTag}</td>
        <td>${escapeHtml(sections.find(sec => sec.id === s.section_id)?.rooms?.name || '—')}</td>
        <td><span class="badge rounded-pill bg-light text-success border px-2 py-1">Enrolled</span></td>
        <td>
          <button class="bpes-btn-outline bpes-btn-sm me-1" onclick="openStudentPasswordModal('${s.id}')">
            <i class="fas fa-key me-1"></i> Change password
          </button>
          <button class="bpes-btn-danger-outline bpes-btn-sm" onclick="handleAdminDeleteStudent('${s.id}')">
            <i class="fas fa-trash me-1"></i> Delete
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// Options come from the sections list loaded by loadAdminSections; the selection survives a reload.
function fillStudentSectionFilter() {
  const el = document.getElementById('adm-student-section-filter');
  if (!el) return;
  const prev = el.value;
  el.innerHTML = '<option value="">All sections</option>' +
    (sections || []).map(sec => `<option value="${escapeHtml(sec.id)}">${escapeHtml(sec.section_name)}</option>`).join('');
  el.value = prev;
}

function filterAdminStudents() {
  const query = (document.getElementById('adm-student-search')?.value || '').toLowerCase();
  const sectionId = document.getElementById('adm-student-section-filter')?.value || '';
  const filtered = students.filter(s =>
    (!sectionId || s.section_id === sectionId) &&
    (!query ||
      (s.full_name && s.full_name.toLowerCase().includes(query)) ||
      (s.student_id && s.student_id.toLowerCase().includes(query)) ||
      (s.section && s.section.toLowerCase().includes(query)) ||
      (s.rfid_uid && s.rfid_uid.toLowerCase().includes(query)))
  );
  renderStudentsTable(filtered);
}

// The admin types the new password; it is never written back into the page.
let pwStudentId = null;
function openStudentPasswordModal(id) {
  pwStudentId = id;
  const name = students.find(s => s.id === id)?.full_name || 'this student';
  document.getElementById('student-pw-name').textContent = `Student: ${name}`;
  document.getElementById('student-pw-input').value = '';
  bootstrap.Modal.getOrCreateInstance(document.getElementById('student-pw-modal')).show();
}

async function confirmStudentPassword(e) {
  e.preventDefault();
  const input = document.getElementById('student-pw-input');
  const btn = document.getElementById('student-pw-confirm-btn');
  const pw = input.value;
  const name = students.find(s => s.id === pwStudentId)?.full_name || 'the student';
  if (pw.length < 4) return notify('admin', 'A password needs at least 4 characters', 'danger');
  btn.disabled = true;
  try {
    await axios.put(`${API_BASE}/api/students/${pwStudentId}/password`, { new_password: pw });
    bootstrap.Modal.getOrCreateInstance(document.getElementById('student-pw-modal')).hide();
    notify('admin', `Password changed for "${escapeHtml(name)}"`, 'success');
  } catch (err) {
    notify('admin', `Could not change password: ${escapeHtml(err.response?.data?.error || err.message)}`, 'danger');
  } finally {
    input.value = '';
    btn.disabled = false;
  }
}

// Only the id goes into onclick; the name is looked up here so no record text is ever parsed as script.
async function handleAdminDeleteStudent(id) {
  const name = students.find(s => s.id === id)?.full_name || 'this student';
  if (!confirm(`Are you sure you want to remove student "${name}"?`)) return;
  try {
    await axios.delete(`${API_BASE}/api/students/${id}`);
    notify('admin', `Removed student "${escapeHtml(name)}"`, 'warning');
    await loadSystemData();
    await loadAdminStudents();
  } catch (err) {
    notify('admin', `Delete failed: ${escapeHtml(err.response?.data?.error || err.message)}`, 'danger');
  }
}

// ── Teachers Management & Table Rendering ────

async function loadAdminTeachers() {
  const tbody = document.getElementById('adm-teachers-tbody');
  if (!tbody) return;

  try {
    const res = await axios.get(`${API_BASE}/api/teachers`);
    teachers = res.data.teachers || [];

    const countPill = document.getElementById('teachers-count-pill');
    if (countPill) countPill.textContent = `${teachers.length} teachers`;

    renderTeachersTable(teachers);
  } catch (err) {
    console.error('Error loading teachers', err);
    tbody.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-danger">Failed to load teachers</td></tr>`;
  }
}

function renderTeachersTable(list) {
  const tbody = document.getElementById('adm-teachers-tbody');
  const paginationLabel = document.getElementById('adm-teachers-pagination-label');
  if (!tbody) return;

  if (paginationLabel) {
    paginationLabel.textContent = `Showing ${list.length} teacher record${list.length === 1 ? '' : 's'}`;
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-muted">No teachers registered yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(t => {
    const initials = t.full_name ? t.full_name.charAt(0).toUpperCase() : 'T';
    return `
      <tr>
        <td>
          <div class="d-flex align-items-center gap-2">
            <div class="d-flex align-items-center justify-content-center fw-bold text-white small" style="width: 32px; height: 32px; border-radius: 50%; background: #14532D; flex-shrink: 0;">
              ${initials}
            </div>
            <div>
              <div class="fw-bold">${escapeHtml(t.full_name)}</div>
              <div class="bpes-cell-sub">${escapeHtml(t.employee_id || '—')}</div>
            </div>
          </div>
        </td>
        <td>${escapeHtml(t.email)}</td>
        <td>${t.rfid_uid
          ? `<span>${escapeHtml(t.rfid_uid)}</span>
             <button class="btn btn-link btn-sm p-0 ms-1 text-muted" title="Replace card" onclick="assignTeacherCard('${t.id}')"><i class="fas fa-rotate"></i></button>`
          : `<button class="bpes-btn-outline bpes-btn-sm" onclick="assignTeacherCard('${t.id}')"><i class="fas fa-id-card me-1"></i> Assign card</button>`}</td>
        <td>
          <button class="bpes-btn-danger-outline bpes-btn-sm" onclick="changeTeacherPassword('${t.id}')">
            <i class="fas fa-key me-1"></i> Change password
          </button>
          <button class="bpes-btn-danger-outline bpes-btn-sm" onclick="handleAdminDeleteTeacher('${t.id}')">
            <i class="fas fa-trash me-1"></i> Delete
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function filterAdminTeachers() {
  const query = (document.getElementById('adm-teacher-search')?.value || '').toLowerCase();
  if (!query) {
    renderTeachersTable(teachers);
    return;
  }
  const filtered = teachers.filter(t =>
    (t.full_name && t.full_name.toLowerCase().includes(query)) ||
    (t.email && t.email.toLowerCase().includes(query))
  );
  renderTeachersTable(filtered);
}

async function submitInlineTeacherForm(e) {
  e.preventDefault();
  const btn = document.getElementById('btn-submit-teacher');
  const name = document.getElementById('tch-name-input')?.value.trim();
  const email = document.getElementById('tch-email-input')?.value.trim();
  const employeeId = document.getElementById('tch-id-input')?.value.trim();
  const rfidUid = document.getElementById('tch-rfid-input')?.value.trim();

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span> Registering...';
  }

  try {
    await axios.post(`${API_BASE}/api/teachers`, {
      full_name: name,
      email: email,
      employee_id: employeeId,
      rfid_uid: rfidUid
    });

    notify('admin', `Teacher "${escapeHtml(name)}" registered successfully!`, 'success');
    document.getElementById('teacher-registration-form')?.reset();
    await loadAdminTeachers();
  } catch (err) {
    const msg = err.response?.data?.error || err.message || 'Failed to register teacher';
    notify('admin', `Registration error: ${msg}`, 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>Register teacher</span>';
    }
  }
}

function assignTeacherCard(id) {
  startTapToEnrollInline('', async uid => {
    try {
      await axios.put(`${API_BASE}/api/teachers/${id}`, { rfid_uid: uid });
      notify('admin', 'Card assigned to teacher', 'success');
    } catch (err) {
      notify('admin', err.response?.data?.error || 'Could not assign card', 'danger');
    }
    loadAdminTeachers();
  });
}

async function changeTeacherPassword(id) {
  const t = teachers.find(x => x.id === id);
  if (!t) return;
  const pw = prompt(`New password for ${t.full_name} (at least 6 characters). Their current one stops working.`);
  if (pw === null) return;
  if (pw.trim().length < 6) { notify('admin', 'Password must be at least 6 characters', 'danger'); return; }
  try {
    await axios.put(`${API_BASE}/api/teachers/${id}`, { password: pw.trim() });
    notify('admin', `Password changed for "${escapeHtml(t.full_name)}"`, 'success');
  } catch (err) {
    notify('admin', err.response?.data?.error || 'Could not change password', 'danger');
  }
}

async function handleAdminDeleteTeacher(id) {
  const name = teachers.find(t => t.id === id)?.full_name || 'this teacher';
  if (!confirm(`Are you sure you want to remove teacher "${name}"?`)) return;
  try {
    await axios.delete(`${API_BASE}/api/teachers/${id}`);
    notify('admin', `Removed teacher "${escapeHtml(name)}"`, 'warning');
    await loadAdminTeachers();
  } catch (err) {
    notify('admin', `Delete failed: ${err.message}`, 'danger');
  }
}

// ── Attendance Stream ────────────────────────

async function loadAdminLogs(isSilent = false) {
  const tbody = document.getElementById('adm-logs-tbody');
  const countBadge = document.getElementById('adm-stream-status-badge');
  const countLabel = document.getElementById('adm-logs-count-label');
  const sectionFilter = document.getElementById('adm-log-section-filter')?.value;
  if (!tbody) return;

  try {
    const res = await axios.get(`${API_BASE}/api/attendance`);
    let logs = res.data.logs || [];

    if (sectionFilter) {
      logs = logs.filter(l => l.students && l.students.section === sectionFilter);
    }

    if (countBadge) {
      countBadge.textContent = `${logs.length} taps`;
    }
    if (countLabel) {
      countLabel.textContent = `Live Stream: ${logs.length} logged tap${logs.length === 1 ? '' : 's'}`;
    }

    if (logs.length === 0) {
      if (!isSilent) tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-muted">No live attendance taps recorded yet today.</td></tr>`;
      return;
    }

    tbody.innerHTML = logs.map(l => {
      const student = l.students;
      const name = student ? escapeHtml(student.full_name) : (l.rfid_uid ? `Card ${escapeHtml(l.rfid_uid)}` : 'Unassigned Card');
      const id = student ? escapeHtml(student.student_id) : (l.rfid_uid ? escapeHtml(l.rfid_uid) : '—');
      const section = student?.section || (student ? '—' : 'Unregistered');
      const room = l.rooms?.name || '—';
      const subject = l.class_sessions?.schedules?.subjects?.name || '—';
      const teacher = l.class_sessions?.teacher?.full_name || '—';
      const time = new Date(l.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const date = new Date(l.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
      const badge = statusBadge(l.status);
      const initials = name.charAt(0).toUpperCase();

      return `
        <tr>
          <td>
            <div class="d-flex align-items-center gap-2">
              <div class="d-flex align-items-center justify-content-center fw-bold text-white small" style="width: 32px; height: 32px; border-radius: 50%; background: #14532D; flex-shrink: 0;">
                ${initials}
              </div>
              <strong>${name}</strong>
            </div>
          </td>
          <td><span class="bpes-cell-lrn">${id}</span></td>
          <td><span class="badge bg-light text-dark border">${escapeHtml(section)}</span></td>
          <td>${escapeHtml(subject)}</td>
          <td>${escapeHtml(teacher)}</td>
          <td>${escapeHtml(room)}</td>
          <td>${badge}</td>
          <td>
            ${time}
            <span class="bpes-cell-sub">${date}</span>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    if (!isSilent) {
      console.error('Error fetching admin logs', err);
      tbody.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-warning">Could not fetch live taps.</td></tr>`;
    }
  }
}

// ── Sections ─────────────────────────────────────────────────

const byId = id => document.getElementById(id);
const errMsg = (err, fallback) => err.response?.data?.error || fallback;

async function loadAdminSections() {
  try {
    const res = await axios.get(`${API_BASE}/api/sections`);
    sections = res.data.sections || [];
  } catch (err) {
    console.error('Error loading sections', err);
    notify('admin', errMsg(err, 'Could not load sections'), 'danger');
    return;
  }
  if (byId('sections-count-pill')) byId('sections-count-pill').textContent = `${sections.length} section${sections.length === 1 ? '' : 's'}`;
  renderSectionsTable();
  fillAdminSelects();
  if (students.length) filterAdminStudents(); // student rows show the section's home room
}

function roomOptions(selectedId) {
  return rooms.map(r => `<option value="${r.id}"${r.id === selectedId ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
}

function renderSectionsTable() {
  const tbody = byId('adm-sections-tbody');
  if (!tbody) return;
  if (!sections.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-muted">No sections yet. Add one to start building schedules.</td></tr>';
    return;
  }
  tbody.innerHTML = sections.map(sec => {
    const count = students.filter(s => s.section_id === sec.id).length;
    const gradeSelect = `<select class="bpes-select" style="height: 34px; font-size: 13px; min-width: 112px;" onchange="changeSectionGrade('${sec.id}', this.value)">
        <option value="">No grade</option>${[1, 2, 3, 4, 5, 6].map(g => `<option value="${g}"${g === sec.grade_level ? ' selected' : ''}>Grade ${g}</option>`).join('')}</select>`;
    const roomSelect = `<select class="bpes-select" style="height: 34px; font-size: 13px; min-width: 132px;" onchange="changeSectionRoom('${sec.id}', this.value)">
        ${sec.home_room_id ? '' : '<option value="">No home room</option>'}${roomOptions(sec.home_room_id)}</select>`;
    return `
      <tr>
        <td><strong>${escapeHtml(sec.section_name)}</strong></td>
        <td>${gradeSelect}</td>
        <td>${roomSelect}</td>
        <td><span class="badge bg-light text-dark border">${count}</span></td>
        <td>
          <button class="bpes-btn-outline bpes-btn-sm" onclick="renameSection('${sec.id}')"><i class="fas fa-pen me-1"></i> Rename</button>
          <button class="bpes-btn-danger-outline bpes-btn-sm" onclick="deleteSection('${sec.id}')"><i class="fas fa-trash me-1"></i> Delete</button>
        </td>
      </tr>`;
  }).join('');
}

// Rebuild every dropdown that lists rooms, sections, subjects or teachers, keeping the current choice.
function fillAdminSelects() {
  const fill = (id, html) => {
    const el = byId(id);
    if (!el) return;
    const prev = el.value;
    el.innerHTML = html;
    if ([...el.options].some(o => o.value === prev)) el.value = prev;
  };
  const sectionOpts = sections.map(sec => `<option value="${sec.id}">${escapeHtml(`${sec.section_name} (${sec.rooms?.name || 'no room'})`)}</option>`).join('');
  const subjectOpts = (subjects || []).map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  const teacherOpts = (teachers || []).filter(t => t.role !== 'admin')
    .map(t => `<option value="${t.id}">${escapeHtml(t.full_name)}</option>`).join('');

  fillStudentSectionFilter();
  fill('enroll-section-input', '<option value="">Select section</option>' + sectionOpts);
  fill('sch-section-input', '<option value="">Select section</option>' + sectionOpts);
  fill('sch-filter-section', '<option value="">All sections</option>' + sectionOpts);
  fill('sch-subject-input', '<option value="">Select subject</option>' + subjectOpts);
  fill('sch-teacher-input', '<option value="">— No teacher yet —</option>' + teacherOpts);
  fill('sec-room-input', '<option value="">Select room</option>' + roomOptions());
}

async function submitSectionForm(e) {
  e.preventDefault();
  const btn = byId('btn-submit-section');
  if (btn) btn.disabled = true;
  try {
    await axios.post(`${API_BASE}/api/sections`, {
      section_name: byId('sec-name-input').value.trim(),
      home_room_id: byId('sec-room-input').value || null,
      grade_level: byId('sec-grade-input').value || null,
    });
    notify('admin', 'Section added', 'success');
    byId('section-form').reset();
    await loadAdminSections();
  } catch (err) {
    notify('admin', errMsg(err, 'Could not add section'), 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function changeSectionGrade(id, grade) {
  try {
    await axios.put(`${API_BASE}/api/sections/${id}`, { grade_level: grade || null });
    notify('admin', 'Grade level updated', 'success');
  } catch (err) {
    notify('admin', errMsg(err, 'Could not change grade level'), 'danger');
  }
  await loadAdminSections();
}

async function changeSectionRoom(id, roomId) {
  try {
    await axios.put(`${API_BASE}/api/sections/${id}`, { home_room_id: roomId || null });
    notify('admin', 'Home room updated', 'success');
  } catch (err) {
    notify('admin', errMsg(err, 'Could not change home room'), 'danger');
  }
  await loadAdminSections(); // also resets the dropdown if the change was refused
}

async function renameSection(id) {
  const sec = sections.find(s => s.id === id);
  const name = sec && prompt('New section name', sec.section_name);
  if (!name || !name.trim() || name.trim() === sec.section_name) return;
  try {
    await axios.put(`${API_BASE}/api/sections/${id}`, { section_name: name.trim() });
    await loadAdminStudents();
  } catch (err) {
    notify('admin', errMsg(err, 'Could not rename section'), 'danger');
  }
  await loadAdminSections();
}

async function deleteSection(id) {
  const sec = sections.find(s => s.id === id);
  if (!sec || !confirm(`Delete section "${sec.section_name}" and all of its schedules?`)) return;
  try {
    await axios.delete(`${API_BASE}/api/sections/${id}`);
    notify('admin', 'Section deleted', 'warning');
  } catch (err) {
    notify('admin', errMsg(err, 'Could not delete section'), 'danger');
  }
  await loadAdminSections();
  await loadAdminStudents();
}

// ── Subjects ─────────────────────────────────────────────────

async function loadAdminSubjects() {
  try {
    const res = await axios.get(`${API_BASE}/api/subjects`);
    subjects = res.data.subjects || [];
  } catch (err) {
    notify('admin', errMsg(err, 'Could not load subjects'), 'danger');
    return;
  }
  if (byId('subjects-count-pill')) byId('subjects-count-pill').textContent = `${subjects.length} subject${subjects.length === 1 ? '' : 's'}`;
  const tbody = byId('adm-subjects-tbody');
  if (tbody) {
    tbody.innerHTML = subjects.length ? subjects.map(s => `
      <tr>
        <td><strong>${escapeHtml(s.name)}</strong></td>
        <td>${s.late_threshold_minutes ?? '—'}</td>
        <td>
          <button class="bpes-btn-outline bpes-btn-sm" onclick="editSubject('${s.id}')"><i class="fas fa-pen me-1"></i> Edit</button>
          <button class="bpes-btn-danger-outline bpes-btn-sm" onclick="deleteSubject('${s.id}')"><i class="fas fa-trash me-1"></i> Delete</button>
        </td>
      </tr>`).join('')
      : '<tr><td colspan="3" class="text-center py-4 text-muted">No subjects yet. Add one to start building schedules.</td></tr>';
  }
  fillAdminSelects();
}

function resetSubjectForm() {
  byId('subject-form').reset();
  byId('sub-id-input').value = '';
  byId('subject-form-title').textContent = 'Add subject';
  byId('btn-submit-subject').querySelector('span').textContent = 'Add subject';
  byId('btn-cancel-subject').classList.add('d-none');
}

function editSubject(id) {
  const s = subjects.find(x => x.id === id);
  if (!s) return;
  byId('sub-id-input').value = s.id;
  byId('sub-name-input').value = s.name;
  byId('sub-late-input').value = s.late_threshold_minutes ?? 15;
  byId('subject-form-title').textContent = 'Edit subject';
  byId('btn-submit-subject').querySelector('span').textContent = 'Save changes';
  byId('btn-cancel-subject').classList.remove('d-none');
  byId('sub-name-input').focus();
}

async function submitSubjectForm(e) {
  e.preventDefault();
  const btn = byId('btn-submit-subject');
  const id = byId('sub-id-input').value;
  const body = {
    name: byId('sub-name-input').value.trim(),
    late_threshold_minutes: byId('sub-late-input').value,
  };
  if (btn) btn.disabled = true;
  try {
    if (id) await axios.put(`${API_BASE}/api/subjects/${id}`, body);
    else await axios.post(`${API_BASE}/api/subjects`, body);
    notify('admin', id ? 'Subject updated' : 'Subject added', 'success');
    resetSubjectForm();
    await loadAdminSubjects();
  } catch (err) {
    notify('admin', errMsg(err, 'Could not save subject'), 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteSubject(id) {
  const s = subjects.find(x => x.id === id);
  if (!s || !confirm(`Delete subject "${s.name}"?`)) return;
  try {
    await axios.delete(`${API_BASE}/api/subjects/${id}`);
    notify('admin', 'Subject deleted', 'warning');
  } catch (err) {
    notify('admin', errMsg(err, 'Could not delete subject'), 'danger');
  }
  await loadAdminSubjects();
}

// ── Rooms ────────────────────────────────────────────────────

// Sections, schedule dropdowns and section labels all read the shared rooms list, so refresh them with it.
async function refreshRooms() {
  const res = await axios.get(`${API_BASE}/api/rooms`);
  rooms = res.data.rooms || [];
  fillAdminSelects();
  await loadAdminSections();
}

// The save already worked, so a failed refresh must not read as a failed save (a retry would add a duplicate room).
async function reloadRooms() {
  try {
    await refreshRooms();
    renderRoomsTable();
  } catch (err) {
    notify('admin', 'Saved, but the room list could not refresh. Reload the page.', 'warning');
  }
}

function renderRoomsTable() {
  if (byId('rooms-count-pill')) byId('rooms-count-pill').textContent = `${rooms.length} room${rooms.length === 1 ? '' : 's'}`;
  const tbody = byId('adm-rooms-tbody');
  if (!tbody) return;
  const dash = '<span class="text-muted">—</span>';
  tbody.innerHTML = rooms.length ? rooms.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.name)}</strong></td>
      <td>${r.location ? escapeHtml(r.location) : dash}</td>
      <td>${r.device_id ? escapeHtml(r.device_id) : dash}</td>
      <td>
        <button class="bpes-btn-outline bpes-btn-sm" onclick="editRoom('${r.id}')"><i class="fas fa-pen me-1"></i> Edit</button>
        <button class="bpes-btn-danger-outline bpes-btn-sm" onclick="deleteRoom('${r.id}')"><i class="fas fa-trash me-1"></i> Delete</button>
      </td>
    </tr>`).join('')
    : '<tr><td colspan="4" class="text-center py-4 text-muted">No rooms yet. Add one to start building schedules.</td></tr>';
}

async function loadAdminRooms() {
  try {
    const res = await axios.get(`${API_BASE}/api/rooms`);
    rooms = res.data.rooms || [];
  } catch (err) {
    notify('admin', errMsg(err, 'Could not load rooms'), 'danger');
    return;
  }
  renderRoomsTable();
  fillAdminSelects();
}

function resetRoomForm() {
  byId('room-form').reset();
  byId('room-id-input').value = '';
  byId('room-form-title').textContent = 'Add room';
  byId('btn-submit-room').querySelector('span').textContent = 'Add room';
  byId('btn-cancel-room').classList.add('d-none');
}

function editRoom(id) {
  const r = rooms.find(x => x.id === id);
  if (!r) return;
  byId('room-id-input').value = r.id;
  byId('room-name-input').value = r.name;
  byId('room-location-input').value = r.location || '';
  byId('room-device-input').value = r.device_id || '';
  byId('room-form-title').textContent = 'Edit room';
  byId('btn-submit-room').querySelector('span').textContent = 'Save changes';
  byId('btn-cancel-room').classList.remove('d-none');
  byId('room-name-input').focus();
}

async function submitRoomForm(e) {
  e.preventDefault();
  const btn = byId('btn-submit-room');
  const id = byId('room-id-input').value;
  const body = {
    name: byId('room-name-input').value.trim(),
    location: byId('room-location-input').value.trim(),
    device_id: byId('room-device-input').value.trim(),
  };
  if (btn) btn.disabled = true;
  try {
    if (id) await axios.put(`${API_BASE}/api/rooms/${id}`, body);
    else await axios.post(`${API_BASE}/api/rooms`, body);
    notify('admin', id ? 'Room updated' : 'Room added', 'success');
    resetRoomForm();
    await reloadRooms();
  } catch (err) {
    notify('admin', errMsg(err, 'Could not save room'), 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function deleteRoom(id) {
  const r = rooms.find(x => x.id === id);
  if (!r || !confirm(`Delete room "${r.name}"?`)) return;
  try {
    await axios.delete(`${API_BASE}/api/rooms/${id}`);
    notify('admin', 'Room deleted', 'warning');
    await reloadRooms();
  } catch (err) {
    notify('admin', errMsg(err, 'Could not delete room'), 'danger');
  }
}


// ── Schedules ────────────────────────────────────────────────

const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function loadAdminSchedules() {
  const tbody = byId('adm-schedules-tbody');
  if (!tbody) return;
  const params = { status: byId('sch-filter-status')?.value || 'active' };
  const sectionId = byId('sch-filter-section')?.value;
  if (sectionId) params.section_id = sectionId;
  try {
    const res = await axios.get(`${API_BASE}/api/schedules`, { params });
    schedules = res.data.schedules || [];
  } catch (err) {
    console.error('Error loading schedules', err);
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-danger">Failed to load schedules</td></tr>';
    return;
  }
  renderSchedulesTable();
  renderFreeTimes();
}

// Free-time chips for the picked day: busy = the section's, the teacher's and the home room's active periods.
// Uses its own unfiltered fetch because the table above may be filtered by section or status.
async function renderFreeTimes() {
  const box = byId('sch-free-times');
  if (!box) return;
  const section = sections.find(s => s.id === byId('sch-section-input').value);
  const day = byId('sch-day-input').value;
  if (!section || !day) { box.textContent = 'Pick a day and a section to see free times'; return; }
  const teacher = byId('sch-teacher-input').value;
  let all;
  try {
    all = (await axios.get(`${API_BASE}/api/schedules`, { params: { status: 'active' } })).data.schedules || [];
  } catch (err) { box.textContent = errMsg(err, 'Could not load free times'); return; }
  const busy = all.filter(s => s.day_of_week === day && (s.section_id === section.id
    || (teacher && s.teacher_id === teacher) || (section.home_room_id && s.room_id === section.home_room_id)))
    .map(s => ({ start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5) }));
  const free = ScheduleSlots.freeWindows(busy);
  box.innerHTML = free.length ? free.map(w => `<button type="button" class="bpes-btn-outline bpes-btn-sm" onclick="pickFreeTime('${w.start}','${w.end}')">${escapeHtml(ScheduleSlots.to12h(w.start))} – ${escapeHtml(ScheduleSlots.to12h(w.end))}</button>`).join('')
    : 'No free time that day';
}

function pickFreeTime(start, end) {
  byId('sch-start-input').value = start;
  byId('sch-end-input').value = end;
  refreshScheduleAvailability();
}

function renderSchedulesTable() {
  const tbody = byId('adm-schedules-tbody');
  if (!tbody) return;
  schedules.sort((a, b) => DAY_ORDER.indexOf(a.day_of_week) - DAY_ORDER.indexOf(b.day_of_week) || a.start_time.localeCompare(b.start_time));
  if (byId('schedules-count-pill')) byId('schedules-count-pill').textContent = `${schedules.length} period${schedules.length === 1 ? '' : 's'}`;
  if (!schedules.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-muted">No class periods found.</td></tr>';
    return;
  }
  const today = manilaDate();
  tbody.innerHTML = schedules.map(s => {
    const co = (s.schedule_co_teachers || []).map(c => `<span class="badge bg-light text-dark border me-1">+ ${escapeHtml(c.instructors?.full_name || '?')}</span>`).join('');
    const subs = (s.schedule_overrides || []).filter(o => o.override_date >= today)
      .map(o => `<div class="small text-warning-emphasis">Sub ${escapeHtml(o.override_date)}: ${escapeHtml(o.instructors?.full_name || '?')}</div>`).join('');
    const archived = s.status === 'archived';
    return `
      <tr${archived ? ' class="text-muted"' : ''}>
        <td><strong>${escapeHtml(s.day_of_week)}</strong>
            <span class="bpes-cell-sub">${shortTime(s.start_time)} – ${shortTime(s.end_time)}</span></td>
        <td>${escapeHtml(s.subjects?.name || '—')}</td>
        <td><span class="badge bg-light text-dark border">${escapeHtml(s.sections?.section_name || '—')}</span>
            <span class="bpes-cell-sub">${escapeHtml(s.rooms?.name || '—')}</span></td>
        <td>${escapeHtml(s.teacher?.full_name || '—')}<div>${co}</div>${subs}</td>
        <td>
          <button class="bpes-btn-outline bpes-btn-sm" onclick="openScheduleDetail('${s.id}')" title="Co-teachers and substitutes"><i class="fas fa-user-group me-1"></i> Manage</button>
          <button class="bpes-btn-outline bpes-btn-sm" onclick="setScheduleStatus('${s.id}', '${archived ? 'active' : 'archived'}')">${archived ? 'Restore' : 'Archive'}</button>
          <button class="bpes-btn-danger-outline bpes-btn-sm" onclick="deleteSchedule('${s.id}')"><i class="fas fa-trash"></i></button>
        </td>
      </tr>`;
  }).join('');
}

// Grey out sections/teachers that are already booked for the chosen day and time.
async function refreshScheduleAvailability() {
  const sectionSel = byId('sch-section-input');
  const teacherSel = byId('sch-teacher-input');
  const hint = byId('sch-availability-hint');
  if (!sectionSel || !teacherSel) return;
  renderFreeTimes();

  const section = sections.find(s => s.id === sectionSel.value);
  byId('sch-room-hint').textContent = !section ? ''
    : section.rooms ? `Room: ${section.rooms.name}` : 'This section has no home room yet. Set one in Sections.';

  const day = byId('sch-day-input').value;
  const start = byId('sch-start-input').value;
  const end = byId('sch-end-input').value;
  const markBusy = (select, busyIds) => {
    [...select.options].forEach(o => {
      if (!o.value) return;
      o.dataset.label ??= o.textContent;
      o.disabled = busyIds.includes(o.value);
      o.textContent = o.dataset.label + (o.disabled ? ' — busy' : '');
    });
    if (select.selectedOptions[0]?.disabled) select.value = '';
  };

  if (!start || !end || end <= start) {
    markBusy(sectionSel, []);
    markBusy(teacherSel, []);
    hint.textContent = 'Choose a day and a start/end time to see who is free.';
    return;
  }
  try {
    const { data } = await axios.get(`${API_BASE}/api/schedules/availability`, { params: { day, start, end } });
    markBusy(sectionSel, data.sections);
    markBusy(teacherSel, data.teachers);
    const roomBusy = section?.home_room_id && data.rooms.includes(section.home_room_id);
    hint.textContent = roomBusy ? `${section.rooms.name} is already in use at that time.` : 'Sections and teachers marked busy are already booked then.';
  } catch (err) {
    hint.textContent = errMsg(err, 'Could not check availability');
  }
}

async function submitScheduleForm(e) {
  e.preventDefault();
  const btn = byId('btn-submit-schedule');
  if (btn) btn.disabled = true;
  try {
    await axios.post(`${API_BASE}/api/schedules`, {
      section_id: byId('sch-section-input').value,
      subject_id: byId('sch-subject-input').value,
      teacher_id: byId('sch-teacher-input').value || null,
      day_of_week: byId('sch-day-input').value,
      start_time: byId('sch-start-input').value,
      end_time: byId('sch-end-input').value,
    });
    notify('admin', 'Class period added', 'success');
    byId('schedule-form').reset();
    await loadAdminSchedules();
    refreshScheduleAvailability();
  } catch (err) {
    notify('admin', errMsg(err, 'Could not add class period'), 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function setScheduleStatus(id, status) {
  try {
    await axios.put(`${API_BASE}/api/schedules/${id}`, { status });
  } catch (err) {
    notify('admin', errMsg(err, 'Could not update class period'), 'danger');
  }
  await loadAdminSchedules();
}

async function deleteSchedule(id) {
  if (!confirm('Delete this class period?')) return;
  try {
    await axios.delete(`${API_BASE}/api/schedules/${id}`);
  } catch (err) {
    notify('admin', errMsg(err, 'Could not delete class period'), 'danger');
  }
  await loadAdminSchedules();
}

// ── Co-teachers & substitutes (modal) ────────────────────────

let activeScheduleId = null;

function openScheduleDetail(id) {
  activeScheduleId = id;
  byId('sch-sub-date').value = '';
  renderScheduleDetail();
  bootstrap.Modal.getOrCreateInstance(byId('schedule-detail-modal')).show();
}

function renderScheduleDetail(error = '') {
  const s = schedules.find(x => x.id === activeScheduleId);
  if (!s) return;
  byId('sch-modal-title').textContent =
    `${s.subjects?.name || 'Class'} · ${s.day_of_week} ${shortTime(s.start_time)}–${shortTime(s.end_time)}`;
  byId('sch-sub-date').min = manilaDate();

  const chip = (label, onclick) => `<span class="badge bg-light text-dark border me-1 mb-1">${escapeHtml(label)}
    <a href="#" class="text-danger ms-1" onclick="${onclick}; return false;" title="Remove"><i class="fas fa-xmark"></i></a></span>`;
  const co = s.schedule_co_teachers || [];
  byId('sch-modal-co').innerHTML = co.length
    ? co.map(c => chip(c.instructors?.full_name || '?', `removeCoTeacher('${c.teacher_id}')`)).join('')
    : '<span class="small text-muted">None</span>';
  const subs = s.schedule_overrides || [];
  byId('sch-modal-subs').innerHTML = subs.length
    ? subs.map(o => chip(`${o.override_date}: ${o.instructors?.full_name || '?'}`, `removeSubstitute('${o.override_date}')`)).join('')
    : '<span class="small text-muted">None</span>';

  const toOptions = list => list.map(t => `<option value="${t.id}">${escapeHtml(t.full_name)}</option>`).join('');
  const others = teachers.filter(t => t.role !== 'admin' && t.id !== s.teacher_id);
  byId('sch-co-select').innerHTML = toOptions(others.filter(t => !co.some(c => c.teacher_id === t.id)));
  byId('sch-sub-select').innerHTML = toOptions(others);

  let box = byId('sch-modal-error');
  if (!box) {
    box = document.createElement('div');
    box.id = 'sch-modal-error';
    box.className = 'text-danger small mt-2';
    byId('sch-sub-select').closest('.modal-body').appendChild(box);
  }
  box.textContent = error;
}

// Run a schedule sub-resource call; the API returns the updated schedule, which replaces the cached one.
async function scheduleDetailCall(request) {
  try {
    const res = await request();
    const updated = res.data.schedule;
    if (updated) schedules = schedules.map(s => (s.id === updated.id ? updated : s));
    renderScheduleDetail();
    renderSchedulesTable();
  } catch (err) {
    renderScheduleDetail(errMsg(err, 'Request failed'));
  }
}

const detailUrl = path => `${API_BASE}/api/schedules/${activeScheduleId}/${path}`;

function addCoTeacher() {
  const teacher_id = byId('sch-co-select').value;
  if (teacher_id) scheduleDetailCall(() => axios.post(detailUrl('co-teachers'), { teacher_id }));
}

async function removeCoTeacher(teacherId) {
  await scheduleDetailCall(() => axios.delete(detailUrl(`co-teachers/${teacherId}`)));
  await loadAdminSchedules();
  renderScheduleDetail();
}

function addSubstitute() {
  const override_date = byId('sch-sub-date').value;
  const sub_teacher_id = byId('sch-sub-select').value;
  if (!override_date || !sub_teacher_id) return renderScheduleDetail('Pick a date and a teacher');
  scheduleDetailCall(() => axios.post(detailUrl('overrides'), { override_date, sub_teacher_id }));
}

async function removeSubstitute(date) {
  await scheduleDetailCall(() => axios.delete(detailUrl(`overrides/${date}`)));
  await loadAdminSchedules();
  renderScheduleDetail();
}

// ── Audit log ─────────────────────────────────────────────────

const AUDIT_ACTIONS = {
  create: 'Create', update: 'Update', delete: 'Delete', reset_password: 'Reset password',
  change_password: 'Change password', approve: 'Approve', decline: 'Decline', override: 'Override',
};
const AUDIT_ENTITIES = {
  student: 'Student', teacher: 'Teacher', section: 'Section', subject: 'Subject', room: 'Room',
  schedule: 'Schedule', schedule_override: 'Schedule override', no_class_day: 'No-class day',
  leave_request: 'Leave request', attendance: 'Attendance', admin: 'Admin',
};
let auditNextBefore = null;

// reset = true starts from the newest row; false appends the next page.
async function loadAudit(reset) {
  const tbody = byId('audit-tbody');
  const more = byId('audit-more');
  if (!tbody) return;
  const entity = byId('audit-entity').value;
  const role = byId('audit-role').value;
  const params = { limit: 50 };
  if (entity) params.entity = entity;
  if (role) params.actor_role = role;
  if (!reset && auditNextBefore) params.before = auditNextBefore;
  if (reset) {
    auditNextBefore = null;
    tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-muted">Loading...</td></tr>';
  }
  more.classList.add('d-none');
  try {
    const { data } = await axios.get(`${API_BASE}/api/audit`, { params });
    const html = data.rows.map(r => `
      <tr>
        <td class="text-nowrap">${escapeHtml(new Date(r.created_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }))}</td>
        <td>${escapeHtml(r.actor_name || '—')} <span class="bpes-badge bpes-badge-unassigned">${escapeHtml(({ admin: 'Admin', teacher: 'Teacher', instructor: 'Teacher', student: 'Student' })[r.actor_role] || r.actor_role || '')}</span></td>
        <td class="text-nowrap">${escapeHtml(AUDIT_ACTIONS[r.action] || r.action)}</td>
        <td class="text-nowrap">${escapeHtml(AUDIT_ENTITIES[r.entity] || r.entity)}</td>
        <td style="white-space: normal; word-break: break-word;">${escapeHtml(r.summary || '')}</td>
      </tr>`).join('');
    if (reset) tbody.innerHTML = html || '<tr><td colspan="5" class="text-center py-4 text-muted">No activity recorded yet</td></tr>';
    else tbody.insertAdjacentHTML('beforeend', html);
    auditNextBefore = data.next_before || null;
    more.classList.toggle('d-none', !auditNextBefore);
  } catch (err) {
    if (reset) tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-muted">The audit log is not available right now. Please try again later.</td></tr>';
    notify('admin', escapeHtml(errMsg(err, 'Could not load the audit log')), 'danger');
  }
}

// ── No-class days ─────────────────────────────────────────────
// The server cancels the day's unfinished sessions on POST; DELETE only lifts the day, it never un-cancels.

async function loadNoClassDays() {
  const tbody = byId('ncd-tbody');
  if (!tbody) return;
  try {
    const { data } = await axios.get(`${API_BASE}/api/no-class-days`);
    tbody.innerHTML = data.days.length
      ? data.days.map(d => `
        <tr>
          <td class="text-nowrap"><strong>${escapeHtml(d.day)}</strong></td>
          <td>${escapeHtml(d.reason)}</td>
          <td><button class="bpes-btn-danger-outline bpes-btn-sm" onclick="removeNoClassDay('${escapeHtml(d.day)}')"><i class="fas fa-trash me-1"></i> Delete</button></td>
        </tr>`).join('')
      : '<tr><td colspan="3" class="text-center py-4 text-muted">No upcoming no-class days.</td></tr>';
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-center py-4 text-muted">Could not load no-class days.</td></tr>';
    notify('admin', escapeHtml(errMsg(err, 'Could not load no-class days')), 'danger');
  }
}

// Returns true when the day was saved.
async function postNoClassDay(day, reason, until) {
  try {
    await axios.post(`${API_BASE}/api/no-class-days`, until ? { day, until, reason } : { day, reason });
    notify('admin', `No classes on ${escapeHtml(until && until !== day ? `${day} to ${until}` : day)}: ${escapeHtml(reason)}`, 'success');
    await loadNoClassDays();
    return true;
  } catch (err) {
    notify('admin', escapeHtml(errMsg(err, 'Could not save the no-class day')), 'danger');
    return false;
  }
}

async function addNoClassDay(e) {
  e.preventDefault();
  const day = byId('ncd-date').value;
  const until = byId('ncd-until').value;
  const reason = byId('ncd-reason').value.trim();
  if (!day || !reason) return;
  if (await postNoClassDay(day, reason, until)) e.target.reset();
}

async function removeNoClassDay(day) {
  if (!confirm(`Remove the no-class day on ${day}? Periods already cancelled stay cancelled.`)) return;
  try {
    await axios.delete(`${API_BASE}/api/no-class-days/${encodeURIComponent(day)}`);
    notify('admin', `Removed no-class day ${escapeHtml(day)}`, 'warning');
  } catch (err) {
    notify('admin', escapeHtml(errMsg(err, 'Could not remove the no-class day')), 'danger');
  }
  await loadNoClassDays();
}

function openSuspendModal() {
  byId('suspend-reason').value = '';
  bootstrap.Modal.getOrCreateInstance(byId('suspend-modal')).show();
}

async function confirmSuspendToday(e) {
  e.preventDefault();
  const reason = byId('suspend-reason').value.trim();
  if (!reason) return;
  const btn = byId('suspend-confirm-btn');
  btn.disabled = true; // one click, one POST
  bootstrap.Modal.getOrCreateInstance(byId('suspend-modal')).hide(); // hide first so the result toast is not behind the backdrop
  await postNoClassDay(manilaDate(), reason);
  btn.disabled = false;
}
