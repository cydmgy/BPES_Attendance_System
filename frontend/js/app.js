// ============================================================
// BPES Portal - Core Application Router & State Management
// ============================================================

function getApiBase() {
  if (typeof window === 'undefined') return 'http://localhost:3000';
  const hostname = window.location.hostname || 'localhost';
  const protocol = window.location.protocol.startsWith('http') ? window.location.protocol : 'http:';
  const port = window.location.port;

  // If running locally
  if (hostname === 'localhost' || hostname === '127.0.0.1' || !window.location.protocol.startsWith('http')) {
    // If the frontend is already served directly by Express on port 3000
    if (port === '3000') {
      return window.location.origin;
    }
    // Route API requests to the Express backend server on port 3000 to eliminate 405 Method Not Allowed errors
    return `${protocol}//${hostname}:3000`;
  }

  return window.location.origin;
}

const API_BASE = getApiBase();

// 'YYYY-MM-DD' in school time (Asia/Manila), whatever the browser's zone. Accepts a Date or ISO string.
function manilaDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(value));
}

// 'Good morning' / 'Good afternoon' / 'Good evening' by the school's (Manila) clock.
function greetingWord() {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', hour12: false }).format(new Date())) % 24;
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

// 'Today, 2:35 PM' on the Manila clock.
function manilaTodayLabel() {
  return `Today, ${new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' })}`;
}

// Swap only the greeting word, so 'Good morning, Ana!' becomes 'Good afternoon, Ana!' at noon.
function refreshGreeting(id) {
  const el = document.getElementById(id);
  if (el) el.textContent = el.textContent.replace(/^Good (morning|afternoon|evening|day)/, greetingWord());
}

// One live clock per page: runs update now and every 30 s; loadPage() stops it, so logins never stack timers.
let liveClockTimer = null;
function stopLiveClock() { clearInterval(liveClockTimer); liveClockTimer = null; }
function startLiveClock(update) {
  stopLiveClock();
  update();
  liveClockTimer = setInterval(update, 30000);
}

// Sidebar and drawer entries are <div onclick>: make them reachable and usable from the keyboard.
function enhanceNavAccessibility() {
  document.querySelectorAll('.bpes-sidebar-item').forEach(el => {
    if (el.dataset.kb) return;
    el.dataset.kb = '1';
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
    });
  });
}

// Phones show table rows as cards: every cell carries its column name (the CSS reads data-label).
function labelTableCells() {
  document.querySelectorAll('table.bpes-table').forEach(table => {
    const heads = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach(tr => {
      if (tr.firstElementChild?.hasAttribute('colspan')) return; // empty-state row
      [...tr.children].forEach((td, i) => {
        if (heads[i] !== undefined && td.dataset.label !== heads[i]) td.dataset.label = heads[i];
      });
    });
  });
}

(function watchTables() {
  const start = () => {
    const app = document.getElementById('app');
    if (!app) return;
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; labelTableCells(); });
    }).observe(app, { childList: true, subtree: true }); // childList only: setting data-label cannot retrigger it
    labelTableCells();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

let activePortal = 'welcome';

let rooms = [];
let subjects = [];
let systemDataToken = null; // the auth token the lists above were loaded with

// Leave requests are a whole day or a half day. Old requests that named one subject keep showing it.
const leaveTypeLabel = type => ({ half_day_am: 'Half day (morning)', half_day_pm: 'Half day (afternoon)' })[type] || 'Whole day';
const leaveLabel = req => leaveTypeLabel(req.leave_type) + (req.subjects?.name ? ` - ${req.subjects.name} only` : '');
// Old requests saved a leading "[Subject] " in the reason; hide it.
const FILED_BY_RE = /\s*\[Filed by:\s*([^\]]+)\]\s*$/;
// Who filed the request for the student (a trailing "[Filed by: X]" tag), or null.
const leaveFiledBy = req => { const m = String(req.reason || '').match(FILED_BY_RE); return m ? (m[1].trim() || null) : null; };
// Strip the tag first, or a reason that is only the tag would be eaten by the leading-bracket pattern.
const leaveReasonText = req => String(req.reason || '').replace(FILED_BY_RE, '').replace(/^\[.*?\]\s*/, '').replace(/\s*\(Proof:[^)]*\)\s*$/, ''); // proof was removed; hide it on old requests
// Leave attachments: one button per file, opened through a short-lived signed URL.
const LEAVE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The ids go into onclick attributes, so only well-formed UUIDs are rendered.
function leaveAttachmentLinks(req) {
  if (!req || !LEAVE_UUID_RE.test(req.id || '')) return '';
  return (req.leave_attachments || []).filter(a => LEAVE_UUID_RE.test(a.id || '')).map(a => `
    <button type="button" class="btn btn-link p-0 text-start d-flex align-items-center gap-2 bpes-attach-link"
      style="font-size:13px;min-width:44px;min-height:44px;white-space:normal;overflow-wrap:anywhere"
      onclick="openLeaveAttachment('${req.id}','${a.id}')">
      <i class="fas fa-paperclip" aria-hidden="true"></i><span>${escapeHtml(a.file_name)}</span>
    </button>`).join('');
}

// The tab opens inside the click (popup blockers allow that), then goes to the signed URL once it arrives.
async function openLeaveAttachment(leaveId, attId) {
  const win = window.open('about:blank', '_blank');
  if (win) win.opener = null;
  try {
    const res = await axios.get(`${API_BASE}/api/leave/${leaveId}/attachments/${attId}`);
    if (!res.data?.url) throw new Error('No file link returned');
    if (win) win.location = res.data.url; else window.location.href = res.data.url;
  } catch (err) {
    if (win) win.close();
    notify(getAuthRole() || 'student', escapeHtml(err.response?.data?.error || err.message || 'Could not open the file.'), 'error');
  }
}

let students = [];
let teachers = [];

let studentUser = {
  id: '',
  name: 'Student',
  student_id: '',
  rfid: '',
  course: 'Elementary',
  section: '—',
  year: 1
};

let currentTeacherUser = {
  id: '',
  name: 'Faculty Member',
  email: ''
};

// ── Session State Management ──────────────────────────────────

function getAuthRole() {
  return sessionStorage.getItem('auth_role') || null;
}

function getAuthToken() {
  return sessionStorage.getItem('auth_token') || null;
}

function getAuthUser() {
  return sessionStorage.getItem('auth_user') || null;
}

function restoreAuthSession() {
  const token = getAuthToken();
  const role = getAuthRole();
  const savedUserJson = sessionStorage.getItem('auth_user');

  if (token) {
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  }

  if (savedUserJson) {
    try {
      const user = JSON.parse(savedUserJson);
      if (role === 'student') {
        studentUser = { ...studentUser, ...user };
        if (user.full_name) {
          studentUser.name = user.full_name;
          studentUser.full_name = user.full_name;
        }
      } else if (role === 'teacher') {
        currentTeacherUser = { ...currentTeacherUser, ...user };
      }
    } catch (e) {
      console.warn('Failed to parse saved auth_user', e);
    }
  }
}

// ── DOM Initialization ────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  restoreAuthSession();
  
  // Verify backend connectivity and load initial system collections
  await loadSystemData();

  // Route to the appropriate initial page
  const hash = window.location.hash ? window.location.hash.replace('#', '') : '';
  const initialPage = resolveAuthorizedPage(hash);
  await loadPage(initialPage);
});

window.addEventListener('hashchange', () => {
  const hash = window.location.hash.replace('#', '');
  const target = hash === 'instructor' ? 'teacher' : hash;
  if (target && target !== activePortal) {
    loadPage(target);
  }
});

function resolveAuthorizedPage(requestedPage) {
  const target = requestedPage === 'instructor' ? 'teacher' : requestedPage;
  const role = getAuthRole();

  // Public pages accessible to anyone
  if (target === 'welcome') {
    return target;
  }

  // If already authenticated and trying to visit login or root, go to portal
  if (role) {
    if (target === 'student' && role === 'student') return 'student';
    if (target === 'teacher' && role === 'teacher') return 'teacher';
    if (target === 'admin' && role === 'admin') return 'admin';
    if (!target || target === 'login') return role;
  }

  // If requesting specific protected role portal while not logged in
  if (target === 'student' || target === 'teacher' || target === 'admin') {
    return 'login';
  }

  if (target === 'login') return 'login';

  // Default initial landing page for unauthenticated visitors is welcome
  return 'welcome';
}

// ── System Data Loader (Axios) ────────────────────────────────

async function loadSystemData() {
  try {
    const pingRes = await axios.get(`${API_BASE}/api/ping`, { timeout: 3000 }).catch(() => null);
    if (!(pingRes && pingRes.data && pingRes.data.status === 'online')) {
      console.warn(`[BPES Portal] Backend offline at ${API_BASE}. Run 'node server.js' to connect.`);
      return;
    }

    const isAdminRole = getAuthRole() === 'admin';
    // Rooms and subjects need a login: without a token the server answers 401 and the lists would stay empty.
    const loggedIn = !!getAuthToken();
    let listFailed = false;
    const fetchList = (path, key) => loggedIn
      ? axios.get(`${API_BASE}/api/${path}`, { timeout: 4000 }).catch(() => { listFailed = true; return { data: { [key]: [] } }; })
      : { data: { [key]: [] } };
    const [roomsRes, subjRes, stdRes, tchRes] = await Promise.all([
      fetchList('rooms', 'rooms'),
      fetchList('subjects', 'subjects'),
      // The full student and teacher lists are admin-only (the server refuses everyone else).
      isAdminRole ? axios.get(`${API_BASE}/api/students`, { timeout: 4000 }).catch(() => ({ data: { students: [] } })) : { data: { students: [] } },
      isAdminRole ? axios.get(`${API_BASE}/api/teachers`, { timeout: 4000 }).catch(() => ({ data: { teachers: [] } })) : { data: { teachers: [] } }
    ]);

    rooms = roomsRes.data.rooms || [];
    subjects = subjRes.data.subjects || [];
    students = stdRes.data.students || [];
    teachers = tchRes.data.teachers || [];
    systemDataToken = listFailed ? null : getAuthToken();
    if (listFailed) notify(getAuthRole(), 'Could not load rooms and subjects. Refresh the page to try again.', 'danger');

  } catch (err) {
    console.error('Data initialization error:', err);
  }
}

function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isPass = input.type === 'password';
  input.type = isPass ? 'text' : 'password';
  const icon = btn.querySelector('i');
  if (icon) {
    icon.className = isPass ? 'fas fa-eye-slash' : 'fas fa-eye';
  }
}

// ── Authentication Feedback Modal Popups ──────────────────────

function showAuthErrorPopup({ title, message, type = 'error', isNotFound = false }) {
  const backdrop = document.getElementById('bpes-auth-modal-backdrop');
  const iconWrap = document.getElementById('bpes-auth-modal-icon-wrap');
  const titleEl = document.getElementById('bpes-auth-modal-title');
  const msgEl = document.getElementById('bpes-auth-modal-message');
  const actionsEl = document.getElementById('bpes-auth-modal-actions');

  if (!backdrop) {
    // Fallback if modal HTML is not mounted
    alert(`${title}\n\n${message}`);
    return;
  }

  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;

  if (iconWrap) {
    if (isNotFound) {
      iconWrap.className = 'bpes-auth-modal-icon not-found mb-3';
      iconWrap.innerHTML = '<i class="fas fa-user-xmark"></i>';
    } else {
      iconWrap.className = 'bpes-auth-modal-icon incorrect-pw mb-3';
      iconWrap.innerHTML = '<i class="fas fa-key"></i>';
    }
  }

  if (actionsEl) {
    if (isNotFound) {
      actionsEl.innerHTML = `
        <button type="button" class="bpes-btn-primary w-100 py-3" style="border-radius: var(--radius-input);" onclick="closeAuthErrorPopup()">
          Check LRN &amp; Try Again
        </button>
      `;
    } else {
      actionsEl.innerHTML = `
        <button type="button" class="bpes-btn-primary w-100 py-3" style="border-radius: var(--radius-input);" onclick="closeAuthErrorPopup(true)">
          <i class="fas fa-rotate-left me-2"></i> Try Again
        </button>
      `;
    }
  }

  backdrop.classList.add('active');
}

function closeAuthErrorPopup(focusPassword = false) {
  const backdrop = document.getElementById('bpes-auth-modal-backdrop');
  if (backdrop) {
    backdrop.classList.remove('active');
  }
  if (focusPassword) {
    const passInput = document.getElementById('login-password');
    if (passInput) {
      passInput.value = '';
      passInput.focus();
    }
  } else {
    const userInput = document.getElementById('login-username');
    if (userInput) userInput.focus();
  }
}

// ── Unified Authentication Handlers ──────────────

async function handleUnifiedLogin(e) {
  e.preventDefault();
  const alertEl = document.getElementById('login-alert-box');
  const btn = document.getElementById('unified-login-btn');
  const userInput = document.getElementById('login-username');
  const passInput = document.getElementById('login-password');

  const username = (userInput?.value || '').trim();
  const password = (passInput?.value || '').trim();

  if (!username || !password) {
    showAuthErrorPopup({
      title: 'Missing Credentials',
      message: 'Please enter both your LRN (teachers: email) and password to sign in.',
      type: 'warning',
      isNotFound: false
    });
    return;
  }

  if (alertEl) alertEl.innerHTML = '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span> Signing in...';
  }

  try {
    // 1. Administrator authentication
    if (username.toLowerCase() === 'admin') {
      try {
        const res = await axios.post(`${API_BASE}/api/auth/admin`, { username, password });
        if (res.data.success) {
          sessionStorage.setItem('auth_role', 'admin');
          sessionStorage.setItem('auth_token', res.data.token);
          sessionStorage.setItem('auth_user', JSON.stringify(res.data.user || { role: 'admin' }));
          axios.defaults.headers.common['Authorization'] = `Bearer ${res.data.token}`;
          await loadPage('admin');
          return;
        }
      } catch (adminErr) {
        const code = adminErr.response?.data?.code;
        const msg = adminErr.response?.data?.error || 'Invalid administrator password.';
        showAuthErrorPopup({
          title: code === 'ACCOUNT_NOT_FOUND' ? 'Account Not Found' : 'Incorrect Password',
          message: msg,
          isNotFound: code === 'ACCOUNT_NOT_FOUND'
        });
        return;
      }
    }

    // 2. If username contains '@', authenticate via teacher email
    if (username.includes('@')) {
      try {
        const res = await axios.post(`${API_BASE}/api/auth/teacher`, { email: username, password });
        if (res.data.success) {
          sessionStorage.setItem('auth_role', 'teacher');
          sessionStorage.setItem('auth_token', res.data.token);
          sessionStorage.setItem('auth_user', JSON.stringify(res.data.user));
          currentTeacherUser = { ...currentTeacherUser, ...res.data.user };
          axios.defaults.headers.common['Authorization'] = `Bearer ${res.data.token}`;
          await loadPage('teacher');
          return;
        }
      } catch (tchErr) {
        const code = tchErr.response?.data?.code;
        const msg = tchErr.response?.data?.error || 'Invalid teacher credentials.';
        showAuthErrorPopup({
          title: code === 'ACCOUNT_NOT_FOUND' ? 'Account Not Found' : 'Incorrect Password',
          message: msg,
          isNotFound: code === 'ACCOUNT_NOT_FOUND'
        });
        return;
      }
    }

    // 3. Authenticate Student by LRN
    let studentResponse = null;
    let studentErrData = null;
    try {
      studentResponse = await axios.post(`${API_BASE}/api/auth/student`, {
        student_id: username,
        pin: password
      });
    } catch (stdErr) {
      studentErrData = stdErr.response?.data || { error: stdErr.message };
    }

    if (studentResponse && studentResponse.data && studentResponse.data.success) {
      sessionStorage.setItem('auth_role', 'student');
      sessionStorage.setItem('auth_token', studentResponse.data.token);
      sessionStorage.setItem('auth_user', JSON.stringify(studentResponse.data.user));
      studentUser = { ...studentUser, ...studentResponse.data.user };
      axios.defaults.headers.common['Authorization'] = `Bearer ${studentResponse.data.token}`;
      await loadPage('student');
      return;
    }

    // If student account was found but password was incorrect:
    if (studentErrData && studentErrData.code === 'INCORRECT_PASSWORD') {
      showAuthErrorPopup({
        title: 'Incorrect Password',
        message: 'The LRN or password you entered is incorrect. Please check both and try again.',
        isNotFound: false
      });
      return;
    }

    // A server problem: show the server's message
    if (studentErrData && studentErrData.code !== 'ACCOUNT_NOT_FOUND') {
      showAuthErrorPopup({
        title: 'Login Problem',
        message: studentErrData.error || 'Unable to sign in right now.',
        isNotFound: false
      });
      return;
    }

    // 4. No student with that LRN (teachers sign in with their email above)
    showAuthErrorPopup({
      title: 'Account Does Not Exist',
      message: `We could not find a student with the LRN "${username}". Please check the number (teachers sign in with their email address), or ask the school administrator to enroll you.`,
      isNotFound: true
    });

  } catch (err) {
    console.error('Unified login error:', err);
    showAuthErrorPopup({
      title: 'Login Error',
      message: err.message || 'Unable to complete sign in. Please verify your connection.',
      isNotFound: false
    });
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>Sign in</span>';
    }
  }
}

function logout(next = 'welcome') {
  sessionStorage.removeItem('auth_role');
  sessionStorage.removeItem('auth_token');
  sessionStorage.removeItem('auth_user');
  delete axios.defaults.headers.common['Authorization'];
  BpesProfile.clear();
  toggleMobileDrawer(false);
  return loadPage(next);
}

// An expired token answers 401 on any call. logout() clears the token, so only the first failing request gets here.
axios.interceptors.response.use(r => r, error => {
  if (error.response?.status === 401 && getAuthToken() && !String(error.config?.url || '').includes('/api/auth/')) {
    logout('login').then(() => notify('login', 'Your session expired, please sign in again', 'warning'));
  }
  return Promise.reject(error);
});

// ── Idle sign-out and sliding refresh ─────────────────────────
// Only real input counts as activity: polling timers never call onActivity, so they cannot keep a session alive.
const IDLE_MS = 30 * 60 * 1000;
// Tokens last 35 min (idle + this step), so refreshing at most every 5 min on activity always lands in time.
// Measured on this browser's own clock only, so a PC with a wrong clock is not signed out while working.
const REFRESH_EVERY_MS = 5 * 60 * 1000;
let idleTimer = null;
let nextRefreshAt = 0;

function restartIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = getAuthToken() ? setTimeout(() => {
    logout('login').then(() => notify('login', 'Signed out after 30 minutes of inactivity', 'warning'));
  }, IDLE_MS) : null;
}

function onActivity() {
  const token = getAuthToken();
  if (!token) return; // login and welcome pages have no session to keep
  restartIdleTimer();
  if (Date.now() < nextRefreshAt) return;
  nextRefreshAt = Date.now() + REFRESH_EVERY_MS;
  axios.post(`${API_BASE}/api/auth/refresh`).then(res => {
    if (getAuthToken() !== token || !res.data.token) return; // signed out or in as someone else meanwhile
    sessionStorage.setItem('auth_token', res.data.token);
    axios.defaults.headers.common['Authorization'] = `Bearer ${res.data.token}`;
  }).catch(() => { /* the 401 interceptor signs out on the next real call */ });
}
// no 'scroll': re-renders by the polling timers can fire it and would fake activity
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => document.addEventListener(ev, onActivity, { passive: true, capture: true }));

// ── Mobile Drawer Global Controls ─────────────────────────────

function toggleMobileDrawer(open) {
  const drawer = document.getElementById('bpes-global-drawer');
  const backdrop = document.getElementById('bpes-global-drawer-backdrop');
  if (drawer && backdrop) {
    drawer.classList.toggle('active', !!open);
    backdrop.classList.toggle('active', !!open);
  }
}

// Highlights the drawer item for the tab that is open now (the sidebar item carries the active class).
function drawerActive(prefix, tab) {
  return document.getElementById(`sidebar-${prefix}-${tab}`)?.classList.contains('active') ? ' active' : '';
}

// Per role: header label, drawer-id prefix (matches the sidebar ids), tab function and [tab, icon, label] items.
const DRAWERS = {
  admin: { label: 'ADMIN / BPES PORTAL', prefix: 'adm', show: 'showAdminTab', items: [
    ['dashboard', 'fa-gauge', 'Dashboard'], ['students', 'fa-users', 'Student Enrollment'],
    ['teachers', 'fa-chalkboard-user', 'Teachers Directory'], ['sections', 'fa-layer-group', 'Sections'],
    ['subjects', 'fa-book', 'Subjects'], ['rooms', 'fa-door-open', 'Rooms'],
    ['schedules', 'fa-calendar-days', 'Schedules'], ['noclass', 'fa-calendar-xmark', 'No class days'],
    ['logs', 'fa-clock-rotate-left', 'Attendance Stream'], ['audit', 'fa-clipboard-list', 'Audit log'],
    ['settings', 'fa-gear', 'Settings']] },
  teacher: { label: 'TEACHER / BPES PORTAL', prefix: 'tch', show: 'showTeacherTab', items: [
    ['dashboard', 'fa-home', 'Dashboard'], ['schedule', 'fa-calendar-week', 'Schedule'],
    ['classes', 'fa-chalkboard-user', 'Classes'], ['attendance', 'fa-check-square', 'Attendance'],
    ['export', 'fa-download', 'Export Attendance'], ['leave', 'fa-file-text', 'Student Leave Requests'],
    ['settings', 'fa-gear', 'Settings']] },
  student: { label: 'STUDENT / BPES PORTAL', prefix: 'std', show: 'showStudentTab', items: [
    ['overview', 'fa-home', 'Dashboard'], ['schedule', 'fa-calendar-week', 'Schedule'],
    ['logs', 'fa-clock', 'Attendance History'], ['leave', 'fa-file-text', 'File Excuse / Leave'],
    ['settings', 'fa-gear', 'Settings']] },
};

function openMobileDrawer(role) {
  const d = DRAWERS[role];
  const contextLabel = document.getElementById('drawer-context-label');
  const titleLabel = document.getElementById('drawer-title-label');
  const navContainer = document.getElementById('drawer-nav-items');

  if (contextLabel) contextLabel.textContent = d.label;
  if (titleLabel) titleLabel.textContent = 'Navigation';
  if (navContainer) {
    navContainer.innerHTML = d.items.map(([tab, icon, label]) => `
      <a href="#" class="bpes-drawer-item${drawerActive(d.prefix, tab)}"${tab === 'settings' ? '' : ` id="drawer-item-${d.prefix}-${tab}"`} onclick="selectDrawerTab('${role}', '${tab}'); return false">
        <i class="fas ${icon}"></i>
        <span>${label}</span>
      </a>`).join('');
  }
  toggleMobileDrawer(true);
}

function selectDrawerTab(role, tab) {
  toggleMobileDrawer(false);
  const show = window[DRAWERS[role].show];
  if (typeof show === 'function') show(tab);
}

function openAdminMobileDrawer() { openMobileDrawer('admin'); }
function openTeacherMobileDrawer() { openMobileDrawer('teacher'); }
function openStudentMobileDrawer() { openMobileDrawer('student'); }

// ── Modular Page Router ───────────────────────────────────────

async function loadPage(page) {
  const appContainer = document.getElementById('app');
  if (!appContainer) return;

  // Cleanup active intervals when changing pages
  if (typeof stopAutoRefreshLogs === 'function') stopAutoRefreshLogs();
  if (typeof stopTeacherAutoRefresh === 'function') stopTeacherAutoRefresh();
  if (typeof stopTapPolling === 'function') { stopTapPolling(); rfidCaptureHandler = null; isScanningRfid = false; } // a card tapped later must not reach a stale form
  stopLiveClock();
  toggleMobileDrawer(false);

  let targetPage = (page === 'instructor') ? 'teacher' : (page || 'welcome');
  const currentRole = getAuthRole();

  // Route protection
  if (targetPage === 'student' && currentRole !== 'student') {
    targetPage = 'login';
  } else if (targetPage === 'teacher' && currentRole !== 'teacher') {
    targetPage = 'login';
  } else if (targetPage === 'admin' && currentRole !== 'admin') {
    targetPage = 'login';
  }

  try {
    const response = await fetch(`pages/${targetPage}.html`, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Failed to load page: ${targetPage} (${response.status})`);
    
    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    doc.querySelectorAll('script').forEach(s => s.remove());
    appContainer.innerHTML = doc.body ? doc.body.innerHTML : html;
    activePortal = targetPage;
    restartIdleTimer(); // starts on login and reload, stops once logout() has cleared the token

    // Reference lists load once per login: at page boot the visitor has no token yet, so they came back empty.
    // Loaded here, after the page is in the DOM, so a failure toast has somewhere to show.
    if (targetPage !== 'login' && targetPage !== 'welcome' && systemDataToken !== getAuthToken()) await loadSystemData();
    
    if (window.location.hash !== `#${targetPage}`) {
      history.replaceState(null, '', `#${targetPage}`);
    }

    // Scroll to top smoothly
    window.scrollTo({ top: 0, behavior: 'instant' });

    enhanceNavAccessibility();

    // Initialize specific page controllers
    if (targetPage === 'student' && typeof initStudentPortal === 'function') {
      initStudentPortal();
    } else if (targetPage === 'teacher' && typeof initTeacherPortal === 'function') {
      initTeacherPortal();
    } else if (targetPage === 'admin' && typeof initAdminPortal === 'function') {
      initAdminPortal();
    }
  } catch (err) {
    console.error(`Page routing error for '${targetPage}':`, err);
    appContainer.innerHTML = `
      <div class="container py-5 text-center">
        <div class="bpes-card d-inline-block text-start p-4" style="max-width: 500px;">
          <h5 class="fw-bold text-danger"><i class="fas fa-triangle-exclamation me-2"></i> Error Loading Page</h5>
          <p class="mb-2">Could not load <code>pages/${escapeHtml(targetPage)}.html</code>.</p>
          <button class="bpes-btn-primary bpes-btn-sm mt-3" onclick="loadPage('welcome')">Return to Welcome Page</button>
        </div>
      </div>
    `;
  }
}

// ── Shared UI Utilities ───────────────────────────────────────

// One attendance badge for every portal. Log statuses plus the states a class period can be in
// when a student has no log yet (upcoming / not_checked_in / no_teacher).
const STATUS_BADGES = {
  present:        ['present', 'fa-check', 'Present'],
  late:           ['late', 'fa-clock', 'Late'],
  absent:         ['absent', 'fa-times', 'Absent'],
  excused:        ['excused', 'fa-info-circle', 'Excused'],
  unknown:        ['warning', 'fa-question-circle', 'Unregistered'],
  upcoming:       ['pending', 'fa-hourglass-half', 'Upcoming'],
  not_checked_in: ['warning', 'fa-person-circle-question', 'Not checked in'],
  no_teacher:     ['warning', 'fa-user-slash', 'No teacher'],
  cancelled:      ['cancelled', 'fa-calendar-xmark', 'No classes'],
};

function statusBadge(status) {
  const key = String(status || 'present').toLowerCase();
  const [cls, icon, label] = STATUS_BADGES[key] || ['present', 'fa-check', key];
  return `<span class="bpes-badge bpes-badge-${cls}"><i class="fas ${icon}"></i> ${escapeHtml(label)}</span>`;
}

// Shows "No classes: <reason>" in the placeholder when today (Manila) is a no-class day.
// Fails quietly: a missing banner must never break the dashboard.
async function showNoClassBanner(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  try {
    const { data } = await axios.get(`${API_BASE}/api/no-class-days`);
    const today = manilaDate();
    const hit = (data.days || []).find(d => d.day === today);
    if (!hit) return;
    el.innerHTML = `
      <div class="alert alert-secondary shadow-sm mb-4" role="status" style="border-radius: var(--radius-input);">
        <i class="fas fa-calendar-xmark me-2"></i> <strong>No classes today</strong>${hit.reason ? `: ${escapeHtml(hit.reason)}` : ''}
      </div>`;
  } catch (err) { /* banner is optional */ }
}

// 'HH:MM:SS' -> 'HH:MM'
const shortTime = t => String(t || '').slice(0, 5);

// Set an element's text if it exists
const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };


function notify(target, message, type = 'success') {
  const container = document.getElementById(`${target}-alert-box`);
  if (!container) return;
  const icon = type === 'success' ? 'check-circle' : type === 'warning' ? 'triangle-exclamation' : 'circle-exclamation';
  const alertClass = type === 'success' ? 'alert-success' : type === 'warning' ? 'alert-warning' : 'alert-danger';
  container.innerHTML = `
    <div class="alert ${alertClass} alert-dismissible fade show shadow-sm mb-4" role="alert" style="border-radius: var(--radius-input);">
      <i class="fas fa-${icon} me-2"></i> ${message}
      <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    </div>
  `;
  setTimeout(() => { if (container) container.innerHTML = ''; }, 4500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Calendar-style weekly timetable markup (cal = TeacherSchedule.buildWeekCalendar result), shared by the
// student "My week" and the teacher schedule modal. `inner(b)` is a block's text HTML; `cls(b)` its colour class.
const CAL_PX_PER_MIN = 1.4;
function weekCalendarHtml(cal, todayName, inner, cls) {
  const px = m => `${+(m * CAL_PX_PER_MIN).toFixed(1)}px`;
  const block = b => `
    <div class="bpes-cal-block ${cls(b)}${b.height < 45 ? ' is-short' : ''}" title="${escapeHtml(`${b.subject} ${shortTime(b.start_time)}–${shortTime(b.end_time)} ${b.room}`)}"
         style="top:${px(b.top)};height:calc(${px(b.height)} - 2px);left:calc(${b.lane / b.lanes * 100}% + 1px);width:calc(${100 / b.lanes}% - 2px);">${inner(b)}</div>`;
  return `
    <div class="bpes-cal-scroll">
      <div class="bpes-cal" style="--cal-days:${cal.days.length};--cal-h:${px(cal.end - cal.start)};">
        <div class="bpes-cal-head"><span class="visually-hidden">Time</span></div>
        ${cal.days.map(d => `<div class="bpes-cal-head${d === todayName ? ' is-today' : ''}">${escapeHtml(d)}</div>`).join('')}
        <div class="bpes-cal-gutter" aria-hidden="true">${cal.hours.map(h => `<div class="bpes-cal-hour" style="top:${px((h * 60) - cal.start)};">${TeacherSchedule.timeLabel(h)}</div>`).join('')}</div>
        ${cal.days.map(d => `<div class="bpes-cal-col${d === todayName ? ' is-today' : ''}" role="group" aria-label="${escapeHtml(d)}">${cal.blocks[d].map(block).join('')}</div>`).join('')}
      </div>
    </div>`;
}
