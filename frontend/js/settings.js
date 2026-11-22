// Shared Settings panel for the admin, teacher and student portals.
// Uses axios (bearer token already set by app.js), notify() and escapeHtml() from app.js.
window.BpesSettings = (() => {
  const errMsg = (err, fallback) => err.response?.data?.error || err.response?.data?.message || fallback;

  // Password input with an eye button; the button never carries the value, it only flips the input type.
  const pwField = (id, label, attrs) => `
    <label class="form-label" for="${id}">${label}</label>
    <div class="bpes-pw-field mb-3">
      <input id="${id}" type="password" class="form-control" ${attrs} required>
      <button type="button" class="bpes-pw-toggle" aria-label="Show password" aria-pressed="false" aria-controls="${id}">
        <i class="fas fa-eye" aria-hidden="true"></i>
      </button>
    </div>`;

  const MAX_PICK = 10 * 1024 * 1024, MAX_UPLOAD = 1024 * 1024, TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const BAD_TYPE = 'Choose a JPG, PNG or WebP picture.', TOO_BIG = 'Picture is too large.';

  // Circle content: the picture, or the initial. A failed <img> falls back to the initial (listener below).
  const initialOf = name => (name || '?').charAt(0).toUpperCase();
  const avatarInner = (url, name) => url
    ? `<img class="bpes-avatar-img" src="${escapeHtml(url)}" alt="" decoding="async" data-initial="${escapeHtml(initialOf(name))}">`
    : escapeHtml(initialOf(name));
  document.addEventListener('error', ev => {
    const img = ev.target;
    if (img.classList?.contains('bpes-avatar-img')) img.replaceWith(document.createTextNode(img.dataset.initial || '?'));
  }, true);

  // Center-crop to a square 256px JPEG: small upload, and the re-encode drops EXIF/location data.
  function prepPicture(file) {
    return new Promise((resolve, reject) => {
      const src = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(src);
        try {
          const side = Math.min(img.naturalWidth, img.naturalHeight), c = document.createElement('canvas'), g = c.getContext('2d');
          c.width = c.height = 256;
          g.fillStyle = '#fff'; g.fillRect(0, 0, 256, 256); // JPEG has no alpha: transparent PNG/WebP would turn black
          g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
          c.toBlob(b => (b ? resolve(b) : reject(new Error('read'))), 'image/jpeg', 0.85);
        } catch (e) { reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('read')); };
      img.src = src;
    });
  }

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
    const roleLabel = { admin: 'Administrator', teacher: 'Teacher', student: 'Student' }[role] || '';
    const picture = `<div class="bpes-set-id">
         <span class="bpes-avatar bpes-avatar-lg" id="settings-avatar-preview" aria-hidden="true">${avatarInner(me.avatar_url, me.full_name)}</span>
         <div class="bpes-set-id-body">
           <div class="bpes-set-name">${e(me.full_name)}</div>
           <div class="bpes-set-role">${e(roleLabel)}</div>
           <div class="bpes-set-actions">
             <input id="settings-avatar-file" class="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp">
             <label class="bpes-btn-primary bpes-pick bpes-set-btn" for="settings-avatar-file" id="settings-avatar-pick">Change picture</label>
             <button type="button" id="settings-avatar-remove" class="bpes-set-remove"${me.avatar_url ? '' : ' hidden'}>Remove picture</button>
           </div>
         </div>
       </div>
       <div class="bpes-set-help">JPG, PNG or WebP. Cropped to a square.</div>
       <div id="settings-avatar-status" class="small mt-1" role="status" aria-live="polite"></div>`;
    const profile = role === 'student'
      ? `<dl class="bpes-set-dl">
           <dt>Name</dt><dd>${e(me.full_name)}</dd>
           <dt>LRN</dt><dd>${e(me.student_id || '—')}</dd>
           <dt>Section</dt><dd>${e(me.section || '—')}</dd>
         </dl>`
      : `<form id="settings-profile-form">
           ${role === 'teacher' ? `<label class="form-label" for="settings-email">Login email</label>
           <input id="settings-email" class="form-control mb-3" value="${e(me.email || '')}" readonly>` : ''}
           <label class="form-label" for="settings-name">Full name</label>
           <input id="settings-name" class="form-control" value="${e(me.full_name)}" required maxlength="120">
           <div class="bpes-set-foot"><button type="submit" class="bpes-btn-primary bpes-set-btn">Save name</button></div>
         </form>`;
    el.innerHTML = `
      <div class="bpes-settings">
        <section class="bpes-card bpes-set-card" aria-labelledby="settings-h-profile">
          <h3 class="bpes-set-title" id="settings-h-profile">Profile</h3>
          ${picture}
          <hr class="bpes-set-hr">
          ${profile}
        </section>
        <section class="bpes-card bpes-set-card" aria-labelledby="settings-h-password">
          <h3 class="bpes-set-title" id="settings-h-password">Change password</h3>
          <form id="settings-password-form">
            ${pwField('settings-current', 'Current password', 'autocomplete="current-password"')}
            ${pwField('settings-new', 'New password', `autocomplete="new-password" minlength="${minLen}" aria-describedby="settings-new-help"`)}
            <div class="bpes-set-help" id="settings-new-help">Use at least ${minLen} characters.</div>
            <div class="bpes-set-foot"><button type="submit" class="bpes-btn-primary bpes-set-btn">Change password</button></div>
          </form>
        </section>
      </div>`;
    el.dataset.mounted = '1';
    if (me.must_change_password) notify(role, 'Please change your password.', 'warning');

    const fileIn = el.querySelector('#settings-avatar-file'), rmBtn = el.querySelector('#settings-avatar-remove');
    const pickLbl = el.querySelector('#settings-avatar-pick'), status = el.querySelector('#settings-avatar-status');
    const say = (msg, bad) => { status.textContent = msg; status.className = 'small mt-1 ' + (bad ? 'text-danger' : 'text-muted'); notify(role, msg, bad ? 'error' : 'success'); };
    const busy = on => { fileIn.disabled = rmBtn.disabled = on; pickLbl.classList.toggle('disabled', on); };
    const applyAvatar = url => {
      el.querySelector('#settings-avatar-preview').innerHTML = avatarInner(url, me.full_name);
      rmBtn.hidden = !url;
      window.dispatchEvent(new CustomEvent('bpes:profile-changed', { detail: { avatar_url: url } }));
    };
    const failText = err => err.response?.status === 415 ? BAD_TYPE : err.response?.status === 413 ? TOO_BIG : 'Could not save your picture. Try again later.';

    fileIn.addEventListener('change', async () => {
      const file = fileIn.files[0];
      if (!file) return;
      if (!TYPES.includes(file.type)) { fileIn.value = ''; return say(BAD_TYPE, true); }
      if (file.size > MAX_PICK) { fileIn.value = ''; return say(TOO_BIG, true); }
      busy(true); status.textContent = 'Uploading…';
      const token = getAuthToken();
      try {
        let blob;
        try { blob = await prepPicture(file); } catch (e) { return say('That file could not be read as a picture.', true); }
        if (blob.size > MAX_UPLOAD) return say(TOO_BIG, true);
        const { data } = await axios.post(`${API_BASE}/api/account/avatar`, blob, { headers: { 'Content-Type': 'image/jpeg' } });
        if (getAuthToken() !== token) return; // a different user signed in meanwhile
        applyAvatar(data.avatar_url);
        say('Picture updated.');
      } catch (err) { say(failText(err), true); }
      finally { fileIn.value = ''; busy(false); }
    });

    rmBtn.addEventListener('click', async () => {
      if (!confirm('Remove your profile picture?')) return;
      busy(true); status.textContent = 'Removing…';
      const token = getAuthToken();
      try {
        await axios.delete(`${API_BASE}/api/account/avatar`);
        if (getAuthToken() !== token) return;
        applyAvatar(null);
        say('Picture removed.');
      } catch (err) { say('Could not remove your picture. Try again later.', true); }
      finally { busy(false); }
    });

    el.querySelector('#settings-profile-form')?.addEventListener('submit', async ev => {
      ev.preventDefault();
      const full_name = el.querySelector('#settings-name').value.trim();
      try {
        await axios.put(`${API_BASE}/api/account/profile`, { full_name });
        notify(role, 'Name saved.');
        el.querySelector('.bpes-set-name').textContent = full_name;
        window.dispatchEvent(new CustomEvent('bpes:profile-changed', { detail: { full_name } }));
      } catch (err) { notify(role, errMsg(err, 'Could not save your name.'), 'error'); }
    });

    const pwForm = el.querySelector('#settings-password-form');
    const setShown = (btn, show) => {
      btn.previousElementSibling.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
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

  return { mount, avatarInner };
})();

// Signed-in user's card (sidebar + phone drawer): every [data-profile-card] element is filled from one place.
window.BpesProfile = (() => {
  const LABEL = { admin: 'Admin', teacher: 'Teacher', student: 'Student' };
  let info = null;

  function paint() {
    const big = document.getElementById('student-avatar-big'); // student dashboard's large avatar
    if (big) big.innerHTML = info ? BpesSettings.avatarInner(info.avatar_url, info.name) : '';
    document.querySelectorAll('[data-profile-card]').forEach(el => {
      el.hidden = !info;
      if (!info) return;
      el.setAttribute('aria-label', `${info.name}, ${info.sub}. Open settings`);
      el.innerHTML = `<span class="bpes-avatar" aria-hidden="true">${BpesSettings.avatarInner(info.avatar_url, info.name)}</span>
        <span class="bpes-profile-text"><span class="bpes-profile-name" title="${escapeHtml(info.name)}">${escapeHtml(info.name)}</span><span class="bpes-profile-sub">${escapeHtml(info.role)}</span>${info.lrn ? `<span class="bpes-profile-sub bpes-profile-lrn">LRN ${escapeHtml(info.lrn)}</span>` : ''}</span>`;
    });
  }

  function set(role, name, lrn) {
    const label = LABEL[role] || 'User';
    const showLrn = role === 'student' && lrn;
    info = { avatar_url: info?.avatar_url || null, name: name || label, role: label, lrn: showLrn ? lrn : '', sub: showLrn ? `${label} · LRN ${lrn}` : label };
    paint();
  }

  // Paint at once from the login response, then refine from /api/account/me; a failed call keeps the first paint.
  async function load() {
    const role = getAuthRole(), token = getAuthToken();
    let u = {};
    try { u = JSON.parse(sessionStorage.getItem('auth_user')) || {}; } catch (e) { /* use defaults */ }
    set(role, u.full_name || u.name, u.student_id);
    try {
      const me = (await axios.get(`${API_BASE}/api/account/me`)).data;
      if (getAuthToken() === token) { set(role, me.full_name, me.student_id); info.avatar_url = me.avatar_url || null; paint(); }
    } catch (e) { /* keep the fallback */ }
  }

  window.addEventListener('bpes:profile-changed', ev => {
    if (!info) return;
    if (ev.detail?.full_name) info.name = ev.detail.full_name;
    if (ev.detail && 'avatar_url' in ev.detail) info.avatar_url = ev.detail.avatar_url;
    paint();
  });

  return { load, paint, clear() { info = null; paint(); } };
})();

function openProfileSettings() {
  toggleMobileDrawer(false);
  const role = getAuthRole();
  if (role === 'admin') showAdminTab('settings');
  else if (role === 'teacher') showTeacherTab('settings');
  else if (role === 'student') showStudentTab('settings');
}

// Shared tab opener for the student and teacher portals (admin uses ADMIN_TABS).
function openSettingsTab(role, pre, [sidebarTitle, sidebarDesc, mobileTitle, welcomeDesc]) {
  if (sidebarTitle) sidebarTitle.textContent = 'Settings';
  if (sidebarDesc) sidebarDesc.textContent = 'Your account details and password.';
  if (mobileTitle) mobileTitle.textContent = 'Settings';
  if (welcomeDesc) welcomeDesc.textContent = 'Manage your account.';
  BpesSettings.mount(document.getElementById(`${pre}-tab-settings`), role);
}
