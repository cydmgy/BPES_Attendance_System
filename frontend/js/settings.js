// Shared Settings panel for the admin, teacher and student portals.
// Uses axios (bearer token already set by app.js), notify() and escapeHtml() from app.js.
window.BpesSettings = (() => {
  const errMsg = (err, fallback) => err.response?.data?.error || err.response?.data?.message || fallback;

  async function mount(el, role) {
    if (!el || el.dataset.mounted) return;
    let me;
    try {
      me = (await axios.get(`${API_BASE}/api/account/me`)).data;
    } catch (err) {
      notify(role, errMsg(err, 'Could not load your account.'), 'error');
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
          <div class="bpes-card-header"><h3 class="bpes-card-title">Change ${role === 'student' ? 'PIN' : 'password'}</h3></div>
          <form id="settings-password-form" class="p-3">
            <label class="form-label small text-muted" for="settings-current">Current ${role === 'student' ? 'PIN' : 'password'}</label>
            <input id="settings-current" type="password" class="form-control mb-3" autocomplete="current-password" required>
            <label class="form-label small text-muted" for="settings-new">New ${role === 'student' ? 'PIN' : 'password'} (at least ${minLen} characters)</label>
            <input id="settings-new" type="password" class="form-control mb-3" autocomplete="new-password" minlength="${minLen}" required>
            <button type="submit" class="bpes-btn-primary px-4 py-2">Change ${role === 'student' ? 'PIN' : 'password'}</button>
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

    el.querySelector('#settings-password-form').addEventListener('submit', async ev => {
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
