/**
 * Sortagram sync client. No third-party login: a device starts a sync code
 * (e.g. "amber-tide-cedar-4821") or joins one from another device. The code IS the
 * credential, so it is shown prominently and the person is told to save it.
 *
 * Auth is a bearer token in localStorage (not a cookie): cookies are blocked
 * cross-site in many mobile / in-app browsers.
 *
 * Talks to the app only through window hooks: getStashState(), persistStashState(next),
 * renderStashAll(), showStashToast(msg).
 * Fires: 'stash-sync-changed' (sign-in state changed), 'stash-sync-remote-update' (new data pulled).
 */
const Sync = (function () {
  const API_BASE = window.STASHBOARD_API_BASE;
  const PENDING_KEY = 'stash_pending';
  const LAST_SYNC_KEY = 'stash_lastSync';
  const MIGRATED_KEY = 'stash_migratedTimestamps';
  const TOKEN_KEY = 'stash_authToken';
  const PERIODIC_MS = 60000;
  const MAX_BACKOFF_MS = 60000;
  const BATCH = 200;

  let user = null;
  let authToken = null;
  try { authToken = localStorage.getItem(TOKEN_KEY); } catch (e) {}
  let pushTimer = null;
  let backoffMs = 2000;
  let periodicHandle = null;
  let syncing = null;

  const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }));
  const toast = (m) => { if (window.showStashToast) window.showStashToast(m); };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function setToken(token) {
    authToken = token;
    try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers.Authorization = 'Bearer ' + authToken;
    const ctl = new AbortController();
    // Render's free tier can take ~1 min to wake up, so allow a long first request.
    const timer = setTimeout(() => ctl.abort(), 70000);
    let res;
    try { res = await fetch(API_BASE + path, { ...opts, headers, signal: ctl.signal }); }
    catch (e) { throw new Error(e.name === 'AbortError' ? 'The sync server took too long to respond' : 'Can\u2019t reach the sync server. Check your connection.'); }
    finally { clearTimeout(timer); }
    if (res.status === 401 && authToken) { user = null; setToken(null); stopPeriodicSync(); emit('stash-sync-changed'); }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || ('Request failed: ' + res.status));
    }
    return res.json();
  }

  function getPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '{"topics":[],"items":[]}'); }
    catch (e) { return { topics: [], items: [] }; }
  }
  function setPending(p) { try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch (e) {} }

  // ---------- record normalisation ----------
  // Server records arrive with ISO date strings; the app works with epoch milliseconds.
  const ms = (v) => { if (v == null || v === '') return null; const n = typeof v === 'number' ? v : new Date(v).getTime(); return isNaN(n) ? null : n; };

  function normTopic(t, idx) {
    return {
      id: t.id, name: t.name || '',
      colorIndex: Number.isFinite(+t.colorIndex) && t.colorIndex !== null ? +t.colorIndex : idx || 0,
      isCreator: t.isCreator === null || t.isCreator === undefined ? String(t.name || '').charAt(0) === '@' : !!t.isCreator,
      updatedAt: ms(t.updatedAt) || 0, deletedAt: ms(t.deletedAt)
    };
  }
  function normItem(i) {
    let topicIds = i.topicIds;
    if (typeof topicIds === 'string') { try { topicIds = JSON.parse(topicIds); } catch (e) { topicIds = []; } }
    return {
      id: i.id, title: i.title || '', platform: i.platform || 'other', url: i.url || '', thumb: i.thumb || '',
      notes: i.notes || '', topicIds: Array.isArray(topicIds) ? topicIds : [], favorite: !!i.favorite,
      createdAt: ms(i.createdAt) || Date.now(), updatedAt: ms(i.updatedAt) || 0, deletedAt: ms(i.deletedAt)
    };
  }

  function migrateIfNeeded(state) {
    let done = false;
    try { done = !!localStorage.getItem(MIGRATED_KEY); } catch (e) {}
    if (done) return;
    queueAllLocal(state);
    window.persistStashState(state);
    try { localStorage.setItem(MIGRATED_KEY, '1'); } catch (e) {}
  }

  // Queue everything on this device. Used when turning sync on, because changes made while
  // signed out were never queued individually.
  function queueAllLocal(state) {
    const now = Date.now();
    state.topics.forEach((t) => { if (!t.updatedAt) t.updatedAt = now; });
    state.items.forEach((i) => { if (!i.updatedAt) i.updatedAt = now; });
    queueChanges('topics', state.topics, true);
    queueChanges('items', state.items, true);
  }

  // ---------- panel UI ----------
  function closePanel() { const h = document.getElementById('stashSyncHost'); if (h) h.remove(); }
  const overlay = 'position:fixed;inset:0;background:rgba(10,10,14,.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:16px;';
  const card = 'background:var(--surface,#fff);color:var(--ink,#14141B);width:min(360px,100%);max-height:90vh;overflow:auto;border-radius:16px;padding:20px;box-shadow:0 24px 60px rgba(0,0,0,.3);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;';
  const btnMain = 'width:100%;padding:11px;border:none;border-radius:999px;background:var(--accent-fill,#C8433A);color:var(--accent-ink,#fff);font-weight:600;font-size:.9rem;';
  const btnSide = 'width:100%;padding:11px;border:1px solid var(--border,#E6E6EC);border-radius:999px;background:transparent;color:inherit;font-size:.9rem;';
  const btnText = 'width:100%;padding:8px;border:none;background:none;color:var(--ink-soft,#6B6B76);font-size:.85rem;';
  const para = 'font-size:.85rem;line-height:1.5;color:var(--ink-soft,#6B6B76);margin:0 0 14px;';

  function mountPanel(html) {
    closePanel();
    const host = document.createElement('div');
    host.id = 'stashSyncHost';
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.style.cssText = overlay;
    host.innerHTML = '<div style="' + card + '">' + html + '</div>';
    host.addEventListener('click', (e) => { if (e.target === host) closePanel(); });
    document.body.appendChild(host);
    return host;
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

  async function afterSignIn(data) {
    setToken(data.token);
    user = { syncCode: data.syncCode };
    try { localStorage.removeItem(LAST_SYNC_KEY); } catch (e) {}
    queueAllLocal(window.getStashState());
    window.persistStashState(window.getStashState());
    emit('stash-sync-changed');
    await fullSync();
    startPeriodicSync();
  }

  function openStartPanel() {
    const host = mountPanel(
      '<h3 style="margin:0 0 10px;font-size:1.05rem;">Sync across devices</h3>' +
      '<p style="' + para + '">No account or email. Start a sync code here, then enter the same code on your other device. Only people who have the code can see your stash.</p>' +
      '<button type="button" id="syncStartBtn" style="' + btnMain + 'margin-bottom:8px;">Start syncing (new code)</button>' +
      '<button type="button" id="syncJoinToggleBtn" style="' + btnSide + 'margin-bottom:8px;">I already have a code</button>' +
      '<div id="syncJoinRow" style="display:none;gap:6px;margin-bottom:8px;">' +
      '<input id="syncJoinInput" autocapitalize="none" autocomplete="off" spellcheck="false" placeholder="e.g. amber-tide-4821" style="flex:1;min-width:0;padding:9px 10px;border:1px solid var(--border,#E6E6EC);border-radius:10px;background:var(--surface-2,#FBFBFC);color:inherit;font-size:16px;">' +
      '<button type="button" id="syncJoinBtn" style="padding:9px 14px;border:none;border-radius:10px;background:var(--accent-fill,#C8433A);color:var(--accent-ink,#fff);font-weight:600;">Join</button></div>' +
      '<p id="syncPanelError" role="alert" style="color:var(--danger,#DC2626);font-size:.8rem;margin:4px 0 0;"></p>' +
      '<button type="button" id="syncPanelClose" style="' + btnText + 'margin-top:8px;">Cancel</button>');

    const errEl = host.querySelector('#syncPanelError');
    const startBtn = host.querySelector('#syncStartBtn');
    const joinBtn = host.querySelector('#syncJoinBtn');
    const joinInput = host.querySelector('#syncJoinInput');
    host.querySelector('#syncPanelClose').addEventListener('click', closePanel);

    startBtn.addEventListener('click', async () => {
      errEl.textContent = ''; startBtn.disabled = true; startBtn.textContent = 'Starting\u2026 (can take a minute the first time)';
      try {
        const data = await api('/auth/start', { method: 'POST' });
        await afterSignIn(data);
        showCodePanel(data.syncCode, true);
      } catch (err) { errEl.textContent = err.message; startBtn.disabled = false; startBtn.textContent = 'Start syncing (new code)'; }
    });
    host.querySelector('#syncJoinToggleBtn').addEventListener('click', () => {
      host.querySelector('#syncJoinRow').style.display = 'flex';
      joinInput.focus();
    });
    const join = async () => {
      const code = joinInput.value.trim();
      if (!code) { errEl.textContent = 'Enter a code first'; return; }
      errEl.textContent = ''; joinBtn.disabled = true; joinBtn.textContent = '\u2026';
      try {
        const data = await api('/auth/join', { method: 'POST', body: JSON.stringify({ syncCode: code }) });
        await afterSignIn(data);
        closePanel();
        toast('Synced \u2014 this device is now linked');
      } catch (err) { errEl.textContent = err.message; joinBtn.disabled = false; joinBtn.textContent = 'Join'; }
    };
    joinBtn.addEventListener('click', join);
    joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  }

  function showCodePanel(code, isNew) {
    const host = mountPanel(
      '<h3 style="margin:0 0 10px;font-size:1.05rem;">' + (isNew ? 'Sync is on' : 'Your sync code') + '</h3>' +
      '<p style="' + para + 'margin-bottom:12px;">' + (isNew
        ? 'Save this code somewhere safe. It\u2019s the only way to link another device, and it can\u2019t be recovered if lost.'
        : 'Enter this on another device to link it. Anyone with this code can see your stash, so keep it private.') + '</p>' +
      '<div style="display:flex;gap:6px;margin-bottom:12px;">' +
      '<code style="flex:1;padding:10px 12px;background:var(--surface-2,#FBFBFC);border:1px solid var(--border,#E6E6EC);border-radius:10px;font-size:.95rem;text-align:center;user-select:all;word-break:break-all;">' + esc(code) + '</code>' +
      '<button type="button" id="syncCopyBtn" style="padding:0 14px;border:1px solid var(--border,#E6E6EC);border-radius:10px;background:transparent;color:inherit;">Copy</button></div>' +
      '<button type="button" id="syncPanelDone" style="' + btnMain + '">Done</button>' +
      (isNew ? '' : '<button type="button" id="syncOffBtn" style="' + btnText + 'margin-top:8px;">Turn off sync on this device</button>'));
    host.querySelector('#syncCopyBtn').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      try { await navigator.clipboard.writeText(code); b.textContent = 'Copied'; }
      catch (err) { b.textContent = 'Press & hold the code'; }
    });
    host.querySelector('#syncPanelDone').addEventListener('click', closePanel);
    const off = host.querySelector('#syncOffBtn');
    if (off) off.addEventListener('click', () => {
      if (off.dataset.armed !== '1') {
        off.dataset.armed = '1';
        off.textContent = 'Tap again to confirm. Your items stay on this device.';
        off.style.color = 'var(--danger,#DC2626)';
        return;
      }
      turnOffSync();
      closePanel();
      toast('Sync turned off on this device');
    });
  }

  function openPanel() { if (user) showCodePanel(user.syncCode, false); else openStartPanel(); }

  function turnOffSync() {
    stopPeriodicSync();
    clearTimeout(pushTimer);
    setToken(null);
    user = null;
    try { localStorage.removeItem(LAST_SYNC_KEY); localStorage.removeItem(PENDING_KEY); } catch (e) {}
    emit('stash-sync-changed');
  }

  // ---------- sync core ----------
  // Two devices can each create a topic with the same name (e.g. both tapped the "Recipes" starter).
  // Collapse them onto the smallest id so every device makes the same choice (no ping-pong).
  function dedupeTopics(state) {
    const groups = {};
    state.topics.forEach((t) => {
      const key = (t.isCreator ? 'c:' : 't:') + t.name.trim().toLowerCase();
      (groups[key] = groups[key] || []).push(t);
    });
    const remap = {};
    const tombstones = [];
    Object.keys(groups).forEach((k) => {
      const g = groups[k];
      if (g.length < 2) return;
      g.sort((a, b) => (a.id < b.id ? -1 : 1));
      const keep = g[0];
      g.slice(1).forEach((dup) => { remap[dup.id] = keep.id; tombstones.push(dup); });
    });
    if (!tombstones.length) return false;
    const now = Date.now();
    const touched = [];
    state.items.forEach((it) => {
      if (!it.topicIds.some((id) => remap[id])) return;
      it.topicIds = it.topicIds.map((id) => remap[id] || id).filter((id, i, a) => a.indexOf(id) === i);
      it.updatedAt = now;
      touched.push(it);
    });
    tombstones.forEach((t) => { t.deletedAt = now; t.updatedAt = now; });
    queueChanges('topics', tombstones, true);
    queueChanges('items', touched, true);
    state.topics = state.topics.filter((t) => !remap[t.id]);
    return true;
  }

  function mergeIncoming(state, { topics = [], items = [] }) {
    const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));
    const lt = byId(state.topics);
    const li = byId(state.items);
    topics.map((t, i) => normTopic(t, i)).forEach((t) => {
      const l = lt[t.id];
      if (!l || t.updatedAt > (l.updatedAt || 0)) lt[t.id] = t;
    });
    items.map(normItem).forEach((i) => {
      const l = li[i.id];
      if (!l || i.updatedAt > (l.updatedAt || 0)) li[i.id] = i;
    });
    state.topics = Object.values(lt).filter((t) => !t.deletedAt);
    state.items = Object.values(li).filter((i) => !i.deletedAt);
    dedupeTopics(state);
    return state;
  }

  function applyIncoming(data) {
    const state = mergeIncoming(window.getStashState(), data);
    window.persistStashState(state);
    emit('stash-sync-remote-update');
  }

  async function pull() {
    let since = '1970-01-01T00:00:00Z';
    try { since = localStorage.getItem(LAST_SYNC_KEY) || since; } catch (e) {}
    const data = await api('/api/sync?since=' + encodeURIComponent(since));
    if (data.topics.length || data.items.length) applyIncoming(data);
    try { localStorage.setItem(LAST_SYNC_KEY, data.syncedAt); } catch (e) {}
  }

  async function push() {
    for (;;) {
      const pending = getPending();
      if (!pending.topics.length && !pending.items.length) return;
      const batch = { topics: pending.topics.slice(0, BATCH), items: pending.items.slice(0, BATCH) };
      const data = await api('/api/sync', { method: 'POST', body: JSON.stringify(batch) });
      if (data.current && (data.current.topics.length || data.current.items.length)) applyIncoming(data.current);
      // Remove only what we sent and only if it wasn't edited again during the request.
      const cur = getPending();
      const sent = (list) => (r) => list.some((b) => b.id === r.id && b.updatedAt === r.updatedAt);
      cur.topics = cur.topics.filter((r) => !sent(batch.topics)(r));
      cur.items = cur.items.filter((r) => !sent(batch.items)(r));
      setPending(cur);
      backoffMs = 2000;
    }
  }

  function fullSync() {
    if (!authToken) return Promise.resolve();
    if (syncing) return syncing;
    syncing = (async () => {
      let pushErr = null;
      try { await push(); } catch (e) { pushErr = e; }
      await pull();             // still pull when the push failed
      if (pushErr) throw pushErr;
    })().finally(() => { syncing = null; });
    return syncing;
  }

  // Batch queue: one localStorage write for many records (imports can be 1000 items).
  function queueChanges(kind, records, silent) {
    const pending = getPending();
    const arr = pending[kind];
    const index = {};
    arr.forEach((r, i) => { index[r.id] = i; });
    records.forEach((record) => {
      const copy = JSON.parse(JSON.stringify(record));
      if (index[copy.id] !== undefined) arr[index[copy.id]] = copy; else { index[copy.id] = arr.length; arr.push(copy); }
    });
    setPending(pending);
    if (!silent) pushSoon();
  }
  function queueChange(kind, record) { queueChanges(kind, [record]); }

  function pushSoon() {
    if (!authToken) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(attemptPush, 1500);
  }
  async function attemptPush() {
    try { await push(); }
    catch (err) {
      if (!authToken) return;
      console.warn('Push failed, retrying in', backoffMs, 'ms', err);
      clearTimeout(pushTimer);
      pushTimer = setTimeout(attemptPush, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }

  function startPeriodicSync() {
    stopPeriodicSync();
    periodicHandle = setInterval(() => { if (!document.hidden) pull().catch(console.warn); }, PERIODIC_MS);
  }
  function stopPeriodicSync() { if (periodicHandle) clearInterval(periodicHandle); periodicHandle = null; }

  window.addEventListener('online', () => { if (authToken) { attemptPush(); pull().catch(console.warn); } });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && authToken) { pushSoon(); pull().catch(console.warn); }
  });

  async function init() {
    migrateIfNeeded(window.getStashState());
    if (!authToken) return;
    try {
      const data = await api('/auth/me');
      user = data.user;
      emit('stash-sync-changed');
      startPeriodicSync();
      await fullSync();
    } catch (e) {
      // Offline or server asleep: keep the token (only a 401 clears it); edits keep queueing and
      // are sent on the next 'online' / visibility event.
    }
  }

  // Asks the server (which holds the Gemini key) to read a link and suggest a title, creator and topics.
  function linkInfo(url, topicNames) {
    if (!authToken) return Promise.reject(new Error('Turn on sync to use auto-fill'));
    return api('/api/link-info', { method: 'POST', body: JSON.stringify({ url, existingTopics: topicNames || [] }) });
  }

  return {
    init, openPanel, linkInfo, signOut: turnOffSync, queueChange, queueChanges, pushSoon,
    get user() { return user; },
    get hasToken() { return !!authToken; },
    _test: { mergeIncoming, normItem, normTopic, dedupeTopics, getPending }
  };
})();

window.Sync = Sync;
