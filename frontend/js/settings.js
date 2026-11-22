// Shared Settings panel for the admin, teacher and student portals.
// Uses axios (bearer token already set by app.js), notify() and escapeHtml() from app.js.
window.BpesSettings = (() => {
  const errMsg = (err, fallback) => err.response?.data?.error || err.response?.data?.message || fallback;

  // Password input with an eye button; the button never carries the value, it only flips the input type.
  const pwField = (id, label, attrs) => `
    <label class="form-label small text-muted" for="${id}">${label}</label>
    <div class="bpes-pw-field mb-3">
      <input id="${id}" type="password" class="form-control" ${attrs} required>
      <button type="button" class="bpes-pw-toggle" aria-label="Show password" aria-pressed="false" aria-controls="${id}">
        <i class="fas fa-eye" aria-hidden="true"></i>
      </button>
    </div>`;

  async function mount(el, role) {
    if (!el || el.dataset.mounted) return;
    let me;
    try {
      me = (await axios.get(`${API_BASE}/api/account/me`)).data;
    } catch (err) {
      notify(role, errMsg(err, 'Could not load your account.'), 'error');
      el.innerHTML = '<div class="text-muted p-3">Could not load your account. Try again later.</div>';
      return;
    }
    const minLen = role === 'student' ? 4 : 6;
    const e = escapeHtml;
    const profile = role === 'student'
      ? `<dl class="row mb-0 small">
           <dt class="col-sm-4 text-muted">Name</dt><dd class="col-sm-8">${e(me.full_name)}</dd>
           <dt class="col-sm-4 text-muted">LRN</dt><dd class="col-sm-8">${e(me.student_id || '—')}</dd>
           <dt class="col-sm-4 text-muted">Section</dt><dd class="col-sm-8">${e(me.section || '—')}</dd>
         </dl>`
      : `<form id="settings-profile-form">
           ${role === 'teacher' ? `<label class="form-label small text-muted">Login email</label>
           <input class="form-control mb-3" value="${e(me.email || '')}" readonly>` : ''}
           <label class="form-label small text-muted" for="settings-name">Full name</label>
           <input id="settings-name" class="form-control mb-3" value="${e(me.full_name)}" required maxlength="120">
           <button type="submit" class="bpes-btn-primary px-4 py-2">Save name</button>
         </form>`;
    el.innerHTML = `
      <div class="row g-4">
        <div class="col-lg-6"><div class="bpes-card h-100">
          <div class="bpes-card-header"><h3 class="bpes-card-title">Profile</h3></div>
          <div class="p-3">${profile}</div>
        </div></div>
        <div class="col-lg-6"><div class="bpes-card h-100">
          <div class="bpes-card-header"><h3 class="bpes-card-title">Change password</h3></div>
          <form id="settings-password-form" class="p-3">
            ${pwField('settings-current', 'Current password', 'autocomplete="current-password"')}
            ${pwField('settings-new', `New password (at least ${minLen} characters)`, `autocomplete="new-password" minlength="${minLen}"`)}
            <button type="submit" class="bpes-btn-primary px-4 py-2">Change password</button>
          </form>
        </div></div>
      </div>`;
    el.dataset.mounted = '1';
    if (me.must_change_password) notify(role, 'Please change your password.', 'warning');

    el.querySelector('#settings-profile-form')?.addEventListener('submit', async ev => {
      ev.preventDefault();
      const full_name = el.querySelector('#settings-name').value.trim();
      try {
        await axios.put(`${API_BASE}/api/account/profile`, { full_name });
        notify(role, 'Name saved.');
      } catch (err) { notify(role, errMsg(err, 'Could not save your name.'), 'error'); }
    });

    const pwForm = el.querySelector('#settings-password-form');
    const setShown = (btn, show) => {
      btn.previousElementSibling.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.firstElementChild.className = show ? 'fas fa-eye-slash' : 'fas fa-eye';
    };
    pwForm.addEventListener('click', ev => {
      const btn = ev.target.closest('.bpes-pw-toggle');
      if (btn) setShown(btn, btn.getAttribute('aria-pressed') !== 'true');
    });
    pwForm.addEventListener('reset', () => pwForm.querySelectorAll('.bpes-pw-toggle').forEach(b => setShown(b, false)));

    pwForm.addEventListener('submit', async ev => {
      ev.preventDefault();
      const current_password = el.querySelector('#settings-current').value;
      const new_password = el.querySelector('#settings-new').value;
      if (new_password.length < minLen) return notify(role, `New value must be at least ${minLen} characters.`, 'error');
      try {
        await axios.post(`${API_BASE}/api/account/change-password`, { current_password, new_password });
        ev.target.reset();
        notify(role, 'Password changed.');
        window.dispatchEvent(new Event('bpes:password-changed'));
      } catch (err) { notify(role, errMsg(err, 'Could not change the password.'), 'error'); }
    });
  }

  return { mount };
})();

// Shared tab opener for the student and teacher portals (admin uses ADMIN_TABS).
function openSettingsTab(role, pre, [sidebarTitle, sidebarDesc, mobileTitle, welcomeDesc]) {
  if (sidebarTitle) sidebarTitle.textContent = 'Settings';
  if (sidebarDesc) sidebarDesc.textContent = 'Your account details and password.';
  if (mobileTitle) mobileTitle.textContent = 'Settings';
  if (welcomeDesc) welcomeDesc.textContent = 'Manage your account.';
  BpesSettings.mount(document.getElementById(`${pre}-tab-settings`), role);
}
