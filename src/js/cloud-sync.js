// ══════════ CLOUD SYNC (Firebase, invite-only) ══════════
// The Portfolio Manager is local-first: saveLocal()/loadLocal() in
// persistence.js remain the source of truth, and the app works with no
// account exactly as it always has. This file adds a second copy in
// Firestore, for a signed-in and invited user, so the same portfolio can be
// opened from another device. If Firebase is unreachable the local copy is
// untouched - sync is additive, never a dependency.
//
// The actual Firebase calls (auth, Firestore reads/writes) live in a
// <script type="module"> block in the template, because the modular SDK needs
// ES module imports and this file is concatenated into a classic script. That
// module exposes window.CloudAuth and window.CloudDB and fires a
// 'firebase-ready' event once loaded; everything below calls through those,
// never through Firebase directly, so it stays testable without a network.

// Only these travel to Firestore. A blanket copy of localStorage would upload
// the user's own paid API keys (tdApiKey, pi_claude_key, pi_groq_key,
// aikey_*) into a database that was never meant to hold anyone's credentials.
const CS_SYNC_KEYS = ['indEQ', 'usEQ', 'crypto', 'fd', 'mf', 'txns', 'usdInr'];

// Email as Firestore will see it, and as the allowlist document ID must read.
// Firestore document IDs are case-sensitive; a mismatch here is a silent
// permissions failure, not an error message.
function _csNormEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// The document written to users/{uid}/state/portfolio. Built by allowlist,
// not by copying S wholesale, so a field added to S later does not silently
// start leaving the device until someone deliberately adds it here.
function _csBuildPayload(state) {
  const out = {};
  for (const k of CS_SYNC_KEYS) out[k] = (state && state[k] !== undefined) ? state[k] : (Array.isArray(DEFAULT_STATE_LIKE(k)) ? [] : null);
  return out;
}
// Helper so _csBuildPayload has a sane empty value per key without importing
// the app's DEFAULT_STATE (this file must load standalone for tests).
function DEFAULT_STATE_LIKE(k) { return k === 'usdInr' ? null : []; }

// Which copy wins when both a local save and a cloud save exist. Newer wins;
// a missing timestamp loses to one that exists, since "unknown" is worse than
// "known older" only when there is nothing else to go on - here it just means
// don't let an absent clock overwrite a real one.
function _csShouldPreferRemote(localTs, remoteTs) {
  const l = (typeof localTs === 'number' && isFinite(localTs)) ? localTs : null;
  const r = (typeof remoteTs === 'number' && isFinite(remoteTs)) ? remoteTs : null;
  if (r == null) return false;              // nothing to prefer
  if (l == null) return true;               // only the remote has a timestamp
  return r > l;
}

// Debounce so a field of typing does not become a field of writes against a
// 20,000-write daily quota. Trailing-edge: the last call in a burst wins.
function _csDebounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  wrapped.flush = (...args) => { clearTimeout(t); fn(...args); };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

// ── Orchestration (talks to window.CloudAuth / window.CloudDB) ─────────────
let _csUser = null;          // { uid, email, emailVerified } while signed in
let _csSyncing = false;      // guards the pull from re-triggering itself as a push

function csCurrentUser() { return _csUser; }
function csIsSignedIn() { return !!(_csUser && _csUser.emailVerified); }

// Pushed on every saveLocal(), debounced. Exported so persistence.js can call
// it without this file needing to know saveLocal's internals.
const csPush = _csDebounce(async function () {
  if (!csIsSignedIn() || _csSyncing) return;
  if (typeof window === 'undefined' || !window.CloudDB) return;
  try {
    await window.CloudDB.saveState(_csUser.uid, _csBuildPayload(S));
  } catch (e) {
    try { _logErr(e, 'cloudSync:push'); } catch (_) {}
    if (e && e.code === 'permission-denied') _csNotifyNotInvited();
  }
}, 2500);

// Signing up is open to anyone (Firebase Auth itself is not invite-gated) -
// it's the Firestore security rules that only let allowlisted emails read or
// write sync data. A non-allowlisted verified user can still use the app,
// just entirely off localStorage like before; this tells them so once,
// rather than letting sync fail silently and look broken.
let _csNotInvitedShown = false;
function _csNotifyNotInvited() {
  if (_csNotInvitedShown) return;
  _csNotInvitedShown = true;
  try { if (typeof toast === 'function') toast("Signed in, but this account isn't on the invite list yet - your data stays local only.", 'info'); } catch (_) {}
}

async function csPull() {
  if (!csIsSignedIn() || typeof window === 'undefined' || !window.CloudDB) return null;
  try { return await window.CloudDB.loadState(_csUser.uid); }
  catch (e) {
    try { _logErr(e, 'cloudSync:pull'); } catch (_) {}
    if (e && e.code === 'permission-denied') _csNotifyNotInvited();
    return null;
  }
}

// Reconcile local and remote on sign-in. Never silently discards either side:
// first sign-in with local data uploads it (a fresh cloud doc has no
// timestamp, so _csShouldPreferRemote is false and the local push wins on the
// next saveLocal); a genuine conflict is left to the caller to resolve, via
// onConflict, rather than picked automatically.
async function csReconcile(onConflict) {
  const remote = await csPull();
  if (!remote || !remote.data) { csPush.flush(); return 'uploaded-local'; }
  const localTs = (typeof _csLastLocalSaveTs === 'function') ? _csLastLocalSaveTs() : null;
  if (_csShouldPreferRemote(localTs, remote.updatedAtMs)) {
    const localHas = _holdingsCount && _holdingsCount() > 0;
    if (localHas && typeof onConflict === 'function') {
      return onConflict(remote, localTs);   // caller decides; does not apply anything itself
    }
    _csApplyRemote(remote.data);
    return 'applied-remote';
  }
  csPush.flush();
  return 'kept-local';
}
function _csApplyRemote(data) {
  _csSyncing = true;
  try {
    for (const k of CS_SYNC_KEYS) if (data[k] !== undefined && data[k] !== null) S[k] = data[k];
    if (typeof saveLocal === 'function') saveLocal();
    if (typeof renderAll === 'function') renderAll();
    else if (typeof renderDashboard === 'function') renderDashboard();
  } finally { _csSyncing = false; }
}

let _csReconciledUid = null;   // guards against reconciling twice for one sign-in

function csOnAuthChange(user) {
  const wasVerifiedUid = (_csUser && _csUser.emailVerified) ? _csUser.uid : null;
  _csUser = user;
  if (typeof renderPmAuthGate === 'function') renderPmAuthGate();
  const nowVerifiedUid = (user && user.emailVerified) ? user.uid : null;
  if (nowVerifiedUid && nowVerifiedUid !== wasVerifiedUid && nowVerifiedUid !== _csReconciledUid) {
    _csReconciledUid = nowVerifiedUid;
    csReconcile(_csDefaultConflictHandler).catch(function(e){ try{ _logErr(e,'cloudSync:reconcile'); }catch(_){} });
  }
  if (!user) _csReconciledUid = null;
}

// A conflict (both local and cloud carry real, differently-timed data) is rare
// - it means the same account was used on two devices without syncing between
// them - and picking one side automatically risks the wrong one. A plain
// confirm() is blunt but honest: it names both timestamps and asks, rather
// than silently choosing. Replace with a proper modal if this needs to look
// nicer; the decision it must convey should not change.
function _csDefaultConflictHandler(remote, localTs) {
  const remoteWhen = remote.updatedAtMs ? new Date(remote.updatedAtMs).toLocaleString() : 'unknown time';
  const localWhen  = localTs ? new Date(localTs).toLocaleString() : 'unknown time';
  const useRemote = window.confirm(
    'Your portfolio was also saved from another device.\n\n' +
    'This device:   last saved ' + localWhen + '\n' +
    'Cloud copy:  last saved ' + remoteWhen + '\n\n' +
    'OK = use the cloud copy (replaces what is on this device)\n' +
    'Cancel = keep this device\'s copy (replaces the cloud copy)'
  );
  if (useRemote) { _csApplyRemote(remote.data); return 'applied-remote'; }
  csPush.flush();
  return 'kept-local';
}

// ══════════ SIGN-IN GATE (Portfolio Manager) ══════════
// The Stock Analyser stays open to everyone - it holds no personal data. Only
// the Portfolio Manager, which holds actual holdings, sits behind sign-in.
// This module renders that gate and wires its form; csOnAuthChange (above)
// calls renderPmAuthGate() whenever the sign-in state changes.

function _csEmailLooksValid(email) {
  // A permissive shape check, not RFC 5322. Firebase itself is the real
  // validator; this only stops an empty or obviously malformed submit.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function _csFriendlyAuthError(code) {
  const map = {
    'auth/invalid-email':        'That does not look like a valid email address.',
    'auth/user-disabled':        'This account has been disabled.',
    'auth/user-not-found':       'No account with that email.',
    'auth/wrong-password':       'Incorrect password.',
    'auth/invalid-credential':   'Incorrect email or password.',
    'auth/email-already-in-use': 'An account already exists for that email.',
    'auth/weak-password':        'Password must be at least 6 characters.',
    'auth/too-many-requests':    'Too many attempts. Wait a few minutes and try again.',
    'auth/network-request-failed': 'Could not reach the sign-in server. Check your connection.',
    'auth/requires-recent-login': 'Please sign out and back in, then try this again.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

async function pmAuthSignIn() {
  const email = document.getElementById('pm-auth-email').value;
  const pass  = document.getElementById('pm-auth-pass').value;
  const out   = document.getElementById('pm-auth-msg');
  if (!_csEmailLooksValid(email)) { out.textContent = 'Enter a valid email address.'; return; }
  out.textContent = 'Signing in…';
  try { await window.CloudAuth.signIn(email, pass); }
  catch (e) { out.textContent = _csFriendlyAuthError(e && e.code); }
}
async function pmAuthReset() {
  const email = document.getElementById('pm-auth-email').value;
  const out   = document.getElementById('pm-auth-msg');
  if (!_csEmailLooksValid(email)) { out.textContent = 'Enter your email above first, then click reset.'; return; }
  try { await window.CloudAuth.resetPassword(email); out.textContent = 'Password reset email sent.'; }
  catch (e) { out.textContent = _csFriendlyAuthError(e && e.code); }
}
async function pmAuthSignOut() {
  try { await window.CloudAuth.signOut(); } catch (e) {}
}
async function pmAuthResendVerification() {
  const out = document.getElementById('pm-auth-msg');
  try { await window.CloudAuth.resendVerification(); if (out) out.textContent = 'Verification email sent again.'; }
  catch (e) { if (out) out.textContent = _csFriendlyAuthError(e && e.code); }
}
// Re-checks emailVerified without a full page reload: clicking the link in
// the verification email verifies the account server-side, but the SDK's
// cached user object here only picks that up via an explicit reload().
async function pmAuthCheckVerified() {
  const out = document.getElementById('pm-auth-msg');
  if (out) out.textContent = 'Checking…';
  try {
    const user = await window.CloudAuth.reloadUser();
    csOnAuthChange(user);
    if (!(user && user.emailVerified) && out) out.textContent = 'Not verified yet - click the link in your email, then try again.';
  } catch (e) { if (out) out.textContent = _csFriendlyAuthError(e && e.code); }
}

// ── Account settings (change email / password) ──────────────────────────────
// Firebase requires a recent sign-in before either of these, so both re-auth
// with the current password first rather than relying on however long ago
// the session started.
function pmOpenAccountSettings() {
  const user = csCurrentUser();
  if (!user) return;
  let modal = document.getElementById('pm-account-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'pm-account-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.addEventListener('click', function (e) { if (e.target === modal) pmCloseAccountSettings(); });
    document.body.appendChild(modal);
  }
  modal.innerHTML = `<div class="pm-auth-card" style="max-width:360px;position:relative">
    <button onclick="pmCloseAccountSettings()" style="position:absolute;top:10px;right:12px;background:none;border:none;font-size:18px;cursor:pointer;color:var(--T3)">&times;</button>
    <div class="pm-auth-ico">⚙️</div>
    <div class="pm-auth-title">Account Settings</div>
    <div class="pm-auth-sub">Signed in as <b>${(user.email || '').replace(/</g,'&lt;')}</b></div>
    <input id="pm-acct-curpass" class="form-input" type="password" placeholder="Current password" autocomplete="current-password" style="width:100%;margin-bottom:10px">
    <input id="pm-acct-newemail" class="form-input" type="email" placeholder="New email" autocomplete="email" style="width:100%;margin-bottom:6px">
    <button class="btn btn-sec" style="width:100%;margin-bottom:10px" onclick="pmAccountUpdateEmail()">Update email</button>
    <input id="pm-acct-newpass" class="form-input" type="password" placeholder="New password" autocomplete="new-password" style="width:100%;margin-bottom:6px">
    <button class="btn btn-sec" style="width:100%;margin-bottom:10px" onclick="pmAccountUpdatePassword()">Update password</button>
    <div id="pm-acct-msg" class="pm-auth-msg"></div>
    <button class="btn btn-pri" style="width:100%;margin-top:4px" onclick="pmCloseAccountSettings();pmAuthSignOut()">Sign out</button>
  </div>`;
  modal.style.display = 'flex';
}
function pmCloseAccountSettings() {
  const modal = document.getElementById('pm-account-modal');
  if (modal) modal.style.display = 'none';
}
async function pmAccountUpdateEmail() {
  const pass = document.getElementById('pm-acct-curpass').value;
  const newEmail = document.getElementById('pm-acct-newemail').value;
  const out = document.getElementById('pm-acct-msg');
  if (!pass) { out.textContent = 'Enter your current password first.'; return; }
  if (!_csEmailLooksValid(newEmail)) { out.textContent = 'Enter a valid new email address.'; return; }
  out.textContent = 'Updating…';
  try {
    await window.CloudAuth.reauthenticate(pass);
    await window.CloudAuth.updateEmail(newEmail);
    out.textContent = 'Check ' + newEmail + ' for a confirmation link to finish the change.';
  } catch (e) { out.textContent = _csFriendlyAuthError(e && e.code); }
}
async function pmAccountUpdatePassword() {
  const pass = document.getElementById('pm-acct-curpass').value;
  const newPass = document.getElementById('pm-acct-newpass').value;
  const out = document.getElementById('pm-acct-msg');
  if (!pass) { out.textContent = 'Enter your current password first.'; return; }
  if (!newPass || newPass.length < 6) { out.textContent = 'New password must be at least 6 characters.'; return; }
  out.textContent = 'Updating…';
  try {
    await window.CloudAuth.reauthenticate(pass);
    await window.CloudAuth.updatePassword(newPass);
    out.textContent = 'Password updated.';
  } catch (e) { out.textContent = _csFriendlyAuthError(e && e.code); }
}

// Three states: signed out, signed in but unverified, signed in and verified.
// Only the third shows the portfolio; the other two show why not, not just
// that it is blocked.
function _csRenderAccountBadge(user) {
  const badge = document.getElementById('pm-account-badge');
  const email = document.getElementById('pm-account-email');
  if (!badge || !email) return;
  if (user && user.emailVerified) {
    email.textContent = user.email || '';
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

function renderPmAuthGate() {
  const gate = document.getElementById('pm-auth-gate');
  const body = document.getElementById('pm-content');
  if (!gate || !body) return;
  const user = csCurrentUser();
  _csRenderAccountBadge(user);

  if (user && user.emailVerified) {
    gate.style.display = 'none';
    body.style.display = '';
    return;
  }
  body.style.display = 'none';
  gate.style.display = 'flex';

  if (user && !user.emailVerified) {
    gate.innerHTML = `<div class="pm-auth-card">
      <div class="pm-auth-ico">📧</div>
      <div class="pm-auth-title">Verify your email</div>
      <div class="pm-auth-sub">A verification link was sent to <b>${(user.email || '').replace(/</g,'&lt;')}</b>.
        Click it, then tap Sign In below.</div>
      <button class="btn btn-pri" onclick="pmAuthCheckVerified()">Sign In</button>
      <button class="btn btn-sec" onclick="pmAuthResendVerification()">Resend verification email</button>
      <button class="btn btn-sec" onclick="pmAuthSignOut()">Use a different account</button>
      <div id="pm-auth-msg" class="pm-auth-msg"></div>
    </div>`;
    return;
  }

  gate.innerHTML = `<div class="pm-auth-card">
    <div class="pm-auth-ico">🔒</div>
    <div class="pm-auth-title">Sign in to Portfolio Manager</div>
    <div class="pm-auth-sub">Your holdings sync to your account so you can open them on another device.
      Access is by invitation only.</div>
    <input id="pm-auth-email" class="form-input" type="email" placeholder="Email" autocomplete="email" style="width:100%;margin-bottom:8px">
    <input id="pm-auth-pass" class="form-input" type="password" placeholder="Password" autocomplete="current-password" style="width:100%;margin-bottom:10px">
    <button class="btn btn-pri" style="width:100%;margin-bottom:6px" onclick="pmAuthSignIn()">Sign in</button>
    <button class="btn btn-sec" style="width:100%" onclick="pmAuthReset()">Forgot password</button>
    <div id="pm-auth-msg" class="pm-auth-msg"></div>
    <div class="pm-auth-tile">
      <div class="pm-auth-tile-title">No account yet?</div>
      <div class="pm-auth-tile-sub">This is invite-only access. Email <b>miyee.india@gmail.com</b> with your
        Full Name, Mobile No and Email ID. Once your account is created you'll get an email with your
        password - you can change your email or password anytime from Account Settings after signing in.</div>
      <a class="btn btn-sec" style="width:100%;margin-top:8px;display:block;text-align:center;text-decoration:none;box-sizing:border-box"
         href="mailto:miyee.india@gmail.com?subject=Portfolio%20Manager%20Access%20Request&body=Full%20Name%3A%0AMobile%20No%3A%0AEmail%20ID%3A">✉️ Email to Request Access</a>
    </div>
  </div>`;
}

// Called once Firebase's module script has loaded and wired window.CloudAuth.
// Until this fires the gate shows a loading state rather than a broken form.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('firebase-ready', function () {
    if (window.CloudAuth && typeof window.CloudAuth.onChange === 'function') {
      window.CloudAuth.onChange(csOnAuthChange);
    }
  });
}
