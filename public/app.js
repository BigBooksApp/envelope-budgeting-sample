import { CONFIG } from './config.js';

// ---------------------------------------------------------------- helpers
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => (n == null ? '—' : (Number.isInteger(n) ? usd0 : usd2).format(n));
const money0 = (n) => (n == null ? '—' : usd0.format(n));
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const prettyType = (t) => String(t).replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDay = (isoDate) => new Date(isoDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// ------------------------------------------------------------------- PKCE
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function randomString(len = 64) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'[b % 64]).join('');
}
async function s256(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(digest);
}

// ---------------------------------------------------------------- session
const TOKEN_KEY = 'bb_token';
const getToken = () => {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY));
    return t && t.access_token && Date.now() < t.expiresAt ? t : null;
  } catch { return null; }
};
const setToken = (json) =>
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
    access_token: json.access_token,
    id_token: json.id_token || null,
    expiresAt: Date.now() + ((Number(json.expires_in) || 300) - 30) * 1000,
  }));
const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

// ------------------------------------------------------------- OAuth flow
async function beginLogin() {
  const verifier = randomString();
  const state = randomString(24);
  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('pkce_state', state);
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: CONFIG.CLIENT_ID,
    redirect_uri: CONFIG.REDIRECT_URI,
    scope: CONFIG.SCOPES,
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: 'S256',
  });
  window.location.assign(`${CONFIG.AUTHORIZE_URL}?${p}`);
}

// Returns true if we consumed an OAuth redirect (success or handled error).
async function completeRedirect() {
  const q = new URLSearchParams(window.location.search);
  if (q.has('error')) {
    cleanUrl();
    throw new Error(`Authorization failed: ${q.get('error')} ${q.get('error_description') || ''}`);
  }
  if (!q.has('code')) return false;

  const state = q.get('state');
  const verifier = sessionStorage.getItem('pkce_verifier');
  if (!verifier || state !== sessionStorage.getItem('pkce_state')) {
    cleanUrl();
    throw new Error('OAuth state mismatch — please try signing in again.');
  }
  const res = await fetch(CONFIG.TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: q.get('code'),
      redirect_uri: CONFIG.REDIRECT_URI,
      client_id: CONFIG.CLIENT_ID,
      code_verifier: verifier,
    }),
  });
  const text = await res.text();
  if (!res.ok) { cleanUrl(); throw new Error(`Token exchange failed (${res.status}). ${text.slice(0, 300)}`); }
  setToken(JSON.parse(text));
  sessionStorage.removeItem('pkce_verifier');
  sessionStorage.removeItem('pkce_state');
  cleanUrl();
  return true;
}
const cleanUrl = () => history.replaceState({}, '', CONFIG.REDIRECT_URI);

// ----------------------------------------------------------- API requests
class AuthExpired extends Error {}

// Every call is recorded so the provenance drawer can show which request
// produced a given figure — the point of a sample over a product clone.
const apiLog = [];
const recordCall = (method, path, query) => {
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : '';
  apiLog.push({ method, path: qs ? `${path}?${qs}` : path });
  return apiLog[apiLog.length - 1].path;
};

async function api(method, path, { query, party, body } = {}) {
  const token = getToken();
  if (!token) throw new AuthExpired('Not signed in');
  recordCall(method, path, query);

  const url = new URL(CONFIG.API + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const headers = { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' };
  if (party) headers['X-Acting-Party-ID'] = party;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new Error(`Network/CORS error calling ${path}. Is this origin registered as a redirect URI on the BigBooks OAuth client? (${e.message})`);
  }
  if (res.status === 401) { clearToken(); throw new AuthExpired('Session expired'); }
  const text = await res.text();
  if (!res.ok) throw new Error(describeError(res.status, path, text));
  return text ? JSON.parse(text) : null;
}
const apiGet = (path, opts) => api('GET', path, opts);

// BigBooks error bodies are { errors: [...], code: "..." } — switch on code, show the message.
function describeError(status, path, text) {
  try {
    const body = JSON.parse(text);
    if (body && Array.isArray(body.errors)) return `${status} ${body.code || ''} from ${path}: ${body.errors.join('; ')}`;
  } catch { /* fall through to the raw body */ }
  return `${status} from ${path}: ${text.slice(0, 300) || '(empty body)'}`;
}

function decodeJwt(jwt) {
  try {
    const p = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(p))));
  } catch { return null; }
}
function partyFromClaims(claims) {
  if (!claims) return null;
  for (const k of ['bigbooks:party', 'bigbooks:party_id', 'party', 'party_id']) {
    const v = claims[k];
    if (typeof v === 'string' && v) return { id: v, name: claims.name || claims.email };
    if (v && typeof v === 'object' && v.id) return { id: v.id, name: v.name || claims.name };
  }
  return null;
}

// Access tokens carry no party claim, so the documented bootstrap is GET /oauth2/userInfo.
// We check the id_token first because it often already carries the claim — one less round trip.
async function fetchParty() {
  const token = getToken();
  const fromToken = partyFromClaims(decodeJwt(token.id_token || '')) ||
                    partyFromClaims(decodeJwt(token.access_token || ''));
  if (fromToken) return fromToken;

  const res = await fetch(CONFIG.USERINFO_URL, {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
  }).catch((e) => {
    throw new Error(`Could not resolve your party: the userInfo call was blocked. The CORS allow-list is built from your client's registered redirect URIs — check that ${CONFIG.REDIRECT_URI} is registered exactly. (${e.message})`);
  });
  if (res.status === 401) { clearToken(); throw new AuthExpired('Session expired'); }
  if (!res.ok) throw new Error(`userInfo failed (${res.status})`);
  const party = partyFromClaims(await res.json());
  if (party) return party;
  throw new Error('No bigbooks:party claim in the token or userInfo. Ensure the "openid" scope is granted.');
}

// ------------------------------------------------------------ period math
// Mirrors the server's TimePeriod bucketing so our after_date/before_date land
// on exactly one bucket: MONTH = calendar month, QUARTER = calendar quarter,
// YEAR = calendar year.
function periodBounds(period, anchor) {
  const y = anchor.getFullYear();
  switch (period) {
    case 'YEAR': return { start: new Date(y, 0, 1), end: new Date(y, 11, 31) };
    case 'QUARTER': {
      const q = Math.floor(anchor.getMonth() / 3) * 3;
      return { start: new Date(y, q, 1), end: new Date(y, q + 3, 0) };
    }
    default: return { start: new Date(y, anchor.getMonth(), 1), end: new Date(y, anchor.getMonth() + 1, 0) };
  }
}
function stepPeriod(period, anchor, delta) {
  const d = new Date(anchor);
  if (period === 'YEAR') d.setFullYear(d.getFullYear() + delta);
  else if (period === 'QUARTER') d.setMonth(d.getMonth() + delta * 3, 1);
  else d.setMonth(d.getMonth() + delta, 1);
  return d;
}
function periodLabel(period, anchor) {
  const { start } = periodBounds(period, anchor);
  if (period === 'YEAR') return String(start.getFullYear());
  if (period === 'QUARTER') return `Q${Math.floor(start.getMonth() / 3) + 1} ${start.getFullYear()}`;
  return start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ------------------------------------------------------------- data loading
// Two endpoints, same shape: { accounts: [...], budgetPeriods: [{date, amount, accountId}] }.
//   estimates → what you assigned      actuals → what actually moved
// Both round amounts to whole units server-side.
async function loadEnvelopes(party, period, anchor) {
  const { start, end } = periodBounds(period, anchor);
  const query = { after_date: iso(start), before_date: iso(end) };
  const [estimates, actuals] = await Promise.all([
    apiGet(`/v1/budgeting/estimates/${period}`, { party, query }),
    apiGet(`/v1/budgeting/actuals/${period}`, { party, query }),
  ]);

  // actuals returns every budgeting account (revenue + expense), including ones with
  // no activity, so it is the authoritative account list. estimates covers only
  // accounts that have a budget — union them so a budgeted-but-idle envelope shows.
  const accounts = new Map();
  for (const a of [...(actuals?.accounts || []), ...(estimates?.accounts || [])]) accounts.set(a.id, a);

  const sum = (rows) => {
    const totals = new Map();
    for (const r of rows || []) totals.set(r.accountId, (totals.get(r.accountId) || 0) + Number(r.amount || 0));
    return totals;
  };
  const assigned = sum(estimates?.budgetPeriods);
  const activity = sum(actuals?.budgetPeriods);

  return [...accounts.values()].map((a) => ({
    id: a.id,
    name: a.name,
    accountType: a.accountType,
    category: a.expenseType || a.revenueType || null,
    assigned: assigned.get(a.id) || 0,
    activity: activity.get(a.id) || 0,
  })).sort((a, b) => (b.assigned - a.assigned) || (b.activity - a.activity) || a.name.localeCompare(b.name));
}

// The entries behind one envelope's "activity" figure, for the provenance drawer.
// This endpoint covers the account AND its sub-accounts, which is why a parent
// category's number can exceed the sum of its own direct entries.
async function loadEnvelopeEntries(accountId, period, anchor) {
  const { start, end } = periodBounds(period, anchor);
  const data = await apiGet(`/v1/entries/account/${accountId}/dates`, {
    query: { page_size: 100, page_number: 0, after_date: iso(start), before_date: iso(end) },
  });
  const journals = new Map((data?.journals || []).map((j) => [j.id, j]));
  return (data?.entries || [])
    .map((e) => ({
      id: e.id,
      date: e.date,
      journalId: e.journalId,
      accountId: e.accountId,
      pending: e.pending,
      // signedAmount is natural-sign per account type: a spend on an expense
      // account is positive, income on a revenue account is positive.
      amount: Number(e.signedAmount),
      name: journals.get(e.journalId)?.name || '(unnamed transaction)',
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// -------------------------------------------------------------- mutations
// PUT is a full upsert: a null amount DELETES the account's budgets in the range.
// That is exactly what clearing the input should do, so we lean on it deliberately
// — but note the guide's warning: a serializer that emits nulls by default will
// delete budgets it only meant to leave alone.
function saveEnvelope(accountId, amount, period, anchor) {
  const { start, end } = periodBounds(period, anchor);
  return api('PUT', '/v1/budgeting/budget', {
    body: {
      amount: amount === null ? null : amount,
      account: accountId,
      afterDate: iso(start),
      beforeDate: iso(end),
    },
  });
}

function autofill(party, period, anchor, rolloverSurplus, rolloverDeficit) {
  const { start } = periodBounds(period, anchor);
  return api('POST', '/v1/budgeting/autofill', {
    party,
    body: { localDate: iso(start), timePeriod: period, rolloverSurplus, rolloverDeficit },
  });
}

// -------------------------------------------------------------- rendering
// Zero-based budgeting in one line: everything you expect to earn, minus
// everything you assigned to an envelope, should be zero.
function totals(envelopes) {
  const t = { plannedIncome: 0, assigned: 0, receivedIncome: 0, spent: 0 };
  for (const e of envelopes) {
    if (e.accountType === 'REVENUE') { t.plannedIncome += e.assigned; t.receivedIncome += e.activity; }
    else { t.assigned += e.assigned; t.spent += e.activity; }
  }
  t.toAssign = t.plannedIncome - t.assigned;
  return t;
}

function renderHero(t) {
  $('#hero-value').textContent = money0(t.toAssign);
  $('#hero-value').classList.toggle('over', t.toAssign < 0);

  // Status color never carries the meaning alone — every state ships an icon and a label.
  const box = $('#hero-status');
  const [cls, icon, label] =
    t.plannedIncome === 0 && t.assigned === 0 ? ['idle', '○', 'Nothing budgeted for this period yet']
    : t.toAssign === 0 ? ['good', '✓', 'Every dollar is assigned']
    : t.toAssign > 0 ? ['warning', '⚠', `${money0(t.toAssign)} of planned income is still unassigned`]
    : ['critical', '!', `Assigned ${money0(-t.toAssign)} more than you plan to earn`];
  box.className = `hero-status ${cls}`;
  box.innerHTML = `<span class="icon" aria-hidden="true">${icon}</span><span>${escapeHtml(label)}</span>`;

  const bar = $('#zerobar');
  bar.hidden = t.plannedIncome <= 0;
  if (bar.hidden) return;
  const pct = Math.min(100, (t.assigned / t.plannedIncome) * 100);
  const fill = $('#zerobar-fill');
  fill.style.width = `${pct}%`;
  fill.className = t.toAssign < 0 ? 'over full' : pct >= 99.5 ? 'full' : '';
  $('#zerobar-legend').textContent =
    `${money0(t.assigned)} assigned of ${money0(t.plannedIncome)} planned income`;
}

function renderTiles(t) {
  const tiles = [
    { k: 'Planned income', v: t.plannedIncome },
    { k: 'Assigned to envelopes', v: t.assigned },
    { k: 'Income received', v: t.receivedIncome },
    { k: 'Spent so far', v: t.spent },
  ];
  $('#tiles').innerHTML = tiles.map((x) =>
    `<div class="tile"><div class="k">${x.k}</div><div class="v">${money0(x.v)}</div></div>`).join('');
}

// One envelope row: name, the assignable amount, what moved, and a meter whose
// fill carries severity (accent → warning → critical) over a lighter track of
// the same ramp. The state line below repeats it in words.
function envelopeRow(e) {
  const isIncome = e.accountType === 'REVENUE';
  const left = e.assigned - e.activity;
  const pct = e.assigned > 0 ? (e.activity / e.assigned) * 100 : (e.activity > 0 ? 100 : 0);

  const [cls, icon, label] =
    e.assigned === 0 && e.activity === 0 ? ['idle', '○', 'Nothing assigned or spent']
    : e.assigned === 0 ? ['critical', '!', `${money0(e.activity)} ${isIncome ? 'received with nothing planned' : 'spent from an unbudgeted category'}`]
    : isIncome
      ? (left < 0 ? ['good', '✓', `${money0(-left)} over plan`]
        : left === 0 ? ['good', '✓', 'Fully received']
        : ['warning', '○', `${money0(left)} still expected`])
      : (left < 0 ? ['critical', '!', `${money0(-left)} over`]
        : left === 0 ? ['good', '✓', 'Fully spent']
        : pct >= 85 ? ['warning', '⚠', `${money0(left)} left`]
        : ['good', '✓', `${money0(left)} left`]);

  // The meter's fill carries the same state its label states in words — an envelope
  // spent exactly to plan is the goal, so it stays on the accent, not the warning step.
  const meterCls = isIncome || e.assigned === 0 ? '' : left < 0 ? 'critical' : left > 0 && pct >= 85 ? 'warning' : '';

  return `
    <div class="env" data-id="${e.id}">
      <div class="env-top">
        <div class="env-name">
          <button type="button" data-drawer="${e.id}" aria-expanded="false">${escapeHtml(e.name)}</button>
          ${e.category ? `<span class="type">${escapeHtml(prettyType(e.category))}</span>` : ''}
        </div>
        <div class="env-fields">
          <label class="field">
            <span class="k">${isIncome ? 'Expected' : 'Assigned'}</span>
            <input class="amount" type="text" inputmode="decimal" data-amount="${e.id}"
                   value="${e.assigned ? e.assigned : ''}" placeholder="0"
                   aria-label="${isIncome ? 'Expected income' : 'Amount assigned'} for ${escapeHtml(e.name)}" />
          </label>
          <span class="field"><span class="k">${isIncome ? 'Received' : 'Spent'}</span><span class="v">${money0(e.activity)}</span></span>
        </div>
      </div>
      <div class="meter"><span class="${meterCls} ${pct >= 99.5 ? 'full' : ''}" style="width:${Math.min(100, pct)}%"></span></div>
      <div class="env-state ${cls}"><span aria-hidden="true">${icon}</span><span>${escapeHtml(label)}</span></div>
      <div class="drawer" data-drawer-for="${e.id}" hidden></div>
    </div>`;
}

function render() {
  const t = totals(state.envelopes);
  renderHero(t);
  renderTiles(t);

  const income = state.envelopes.filter((e) => e.accountType === 'REVENUE');
  const expenses = state.envelopes.filter((e) => e.accountType !== 'REVENUE');
  const visible = (rows) => (state.showAll ? rows : rows.filter((e) => e.assigned !== 0 || e.activity !== 0));

  const incomeRows = visible(income);
  const expenseRows = visible(expenses);
  $('#income-note').textContent = incomeRows.length ? '' : 'No income categories with a plan or activity.';
  $('#income').innerHTML = incomeRows.map(envelopeRow).join('');
  $('#expenses').innerHTML = expenseRows.length
    ? expenseRows.map(envelopeRow).join('')
    : `<p class="muted">No expense categories with an assignment or spending this period. Tick “Show unbudgeted categories” to assign to one.</p>`;
}

// The provenance drawer: the entries behind the number, with the journal and
// account ids that produced them and the request that fetched them.
async function toggleDrawer(accountId) {
  const btn = $(`[data-drawer="${accountId}"]`);
  const host = $(`[data-drawer-for="${accountId}"]`);
  if (!host.hidden) {
    host.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  host.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  host.innerHTML = `<div class="register"><div class="empty">Loading entries…</div></div>`;

  try {
    const entries = state.demo ? demoEntries(accountId) : await loadEnvelopeEntries(accountId, state.period, state.anchor);
    const { start, end } = periodBounds(state.period, state.anchor);
    const source = `GET /v1/entries/account/${accountId}/dates?after_date=${iso(start)}&before_date=${iso(end)}`;
    host.innerHTML = `
      <div class="register">
        <table>
          <thead><tr><th>Date</th><th>Transaction</th><th>Journal id</th><th class="num">Signed amount</th></tr></thead>
          <tbody>
            ${entries.length ? entries.map((e) => `
              <tr>
                <td>${fmtDay(e.date)}</td>
                <td>${escapeHtml(e.name)}${e.pending ? ' <span class="muted">pending</span>' : ''}</td>
                <td><code>${escapeHtml(e.journalId.slice(0, 8))}…</code></td>
                <td class="num">${money(e.amount)}</td>
              </tr>`).join('')
              : `<tr><td colspan="4" class="empty">No entries in this period.</td></tr>`}
          </tbody>
        </table>
      </div>
      <p class="muted">Assigned comes from <code>/v1/budgeting/estimates/${state.period}</code> · spent from
      <code>/v1/budgeting/actuals/${state.period}</code> (rounded to whole units server-side) · these rows from
      <code>${escapeHtml(source)}</code>, which covers this account <em>and its sub-accounts</em>.</p>`;
  } catch (e) {
    if (e instanceof AuthExpired) return showConnect('Your session expired. Please sign in again.', 'Session expired');
    host.innerHTML = `<div class="register"><div class="empty">${escapeHtml(e.message)}</div></div>`;
  }
}

// -------------------------------------------------------------- editing
function parseAmount(raw) {
  const cleaned = String(raw).replace(/[$,\s]/g, '');
  if (!cleaned) return null;                       // empty clears the budget (PUT with null amount)
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : undefined;   // undefined = reject
}

async function commitAmount(input) {
  const id = input.dataset.amount;
  const envelope = state.envelopes.find((e) => e.id === id);
  const amount = parseAmount(input.value);
  if (amount === undefined) { input.value = envelope.assigned || ''; return showError('Enter a non-negative number, or clear the field to remove the budget.'); }
  if ((amount || 0) === envelope.assigned) { input.value = envelope.assigned || ''; return; }
  hideError();

  const previous = envelope.assigned;
  envelope.assigned = amount || 0;
  // The top line recomputes on every change. Only the hero and tiles re-render here —
  // a full render would replace the input the user is still interacting with.
  const t = totals(state.envelopes);
  renderHero(t);
  renderTiles(t);

  if (state.demo) { render(); return; }
  input.classList.add('saving');
  input.disabled = true;
  try {
    await saveEnvelope(id, amount, state.period, state.anchor);
    // The server spreads the amount evenly across the period's days and rounds each
    // day to cents, so the figure it reports back can differ by a few cents. Re-read
    // rather than trusting the optimistic value.
    await reload({ quiet: true });
  } catch (e) {
    envelope.assigned = previous;
    render();
    if (e instanceof AuthExpired) return showConnect('Your session expired. Please sign in again.', 'Session expired');
    showError(escapeHtml(e.message));
  } finally {
    input.classList.remove('saving');
    input.disabled = false;
  }
}

let toastTimer;
function flash(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
}

// ------------------------------------------------------------------ state
const state = { party: null, period: 'MONTH', anchor: new Date(), envelopes: [], showAll: false, demo: false };

function showError(msg) { const e = $('#error'); e.hidden = false; e.innerHTML = msg; }
function hideError() { $('#error').hidden = true; }
function showConnect(msg, title) {
  $('#app').hidden = true; $('#connect').hidden = false;
  $('#signout').hidden = true; $('#autofill-btn').hidden = true;
  if (title) $('#connect-title').textContent = title;
  if (msg) $('#connect-msg').textContent = msg;
  $('#connect-btn').disabled = !CONFIG.CLIENT_ID;
}
function showApp() {
  $('#connect').hidden = true; $('#app').hidden = false;
  $('#signout').hidden = false; $('#autofill-btn').hidden = false;
}

async function reload({ quiet } = {}) {
  $('#period-label').textContent = periodLabel(state.period, state.anchor);
  if (!quiet) hideError();
  try {
    state.envelopes = await loadEnvelopes(state.party, state.period, state.anchor);
    const empty = state.envelopes.length === 0;
    $('#empty').hidden = !empty;
    $('#budget').hidden = empty;
    if (!empty) render();
  } catch (e) {
    if (e instanceof AuthExpired) return showConnect('Your session expired. Please sign in again.', 'Session expired');
    showError(escapeHtml(e.message));
  }
}

async function startSession() {
  showApp();
  try {
    state.party = (await fetchParty()).id;
  } catch (e) {
    if (e instanceof AuthExpired) return showConnect('Your session expired. Please sign in again.', 'Session expired');
    return showError(escapeHtml(e.message));
  }
  await reload();
}

// ------------------------------------------------------------------- init
function wireUi() {
  $$('.period button').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.period button').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.period = btn.dataset.period;
      if (state.demo) { runDemo(); return; }
      if (state.party) reload();
    });
  });
  $('#prev-period').addEventListener('click', () => { state.anchor = stepPeriod(state.period, state.anchor, -1); state.demo ? runDemo() : reload(); });
  $('#next-period').addEventListener('click', () => { state.anchor = stepPeriod(state.period, state.anchor, 1); state.demo ? runDemo() : reload(); });
  $('#this-period').addEventListener('click', () => { state.anchor = new Date(); state.demo ? runDemo() : reload(); });

  $('#show-all').addEventListener('change', (ev) => { state.showAll = ev.target.checked; render(); });
  $('#connect-btn').addEventListener('click', () => beginLogin().catch((e) => showError(escapeHtml(e.message))));
  $('#signout').addEventListener('click', () => { clearToken(); showConnect(); });

  // Delegated so re-rendered rows keep working.
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-drawer]');
    if (btn) toggleDrawer(btn.dataset.drawer);
  });
  document.addEventListener('change', (ev) => {
    if (ev.target.matches('[data-amount]')) commitAmount(ev.target);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target.matches('[data-amount]')) ev.target.blur();
  });

  const dlg = $('#autofill-dialog');
  $('#autofill-btn').addEventListener('click', () => dlg.showModal());
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'run') return;
    if (state.demo) return flash('Auto-fill is disabled in demo mode.');
    hideError();
    $('#autofill-btn').disabled = true;
    try {
      await autofill(state.party, state.period, state.anchor, $('#rollover-surplus').checked, $('#rollover-deficit').checked);
      await reload();
      flash('Envelopes auto-filled from history.');
    } catch (e) {
      if (e instanceof AuthExpired) return showConnect('Your session expired. Please sign in again.', 'Session expired');
      showError(escapeHtml(e.message));
    } finally {
      $('#autofill-btn').disabled = false;
    }
  });
}

// Offline preview with synthetic data: open the page with #demo in the URL.
// It runs through the same render path — no network, no auth.
const DEMO = [
  { id: 'demo-salary', name: 'Salary', accountType: 'REVENUE', category: 'SALARY', assigned: 5200, activity: 5200 },
  { id: 'demo-side', name: 'Freelance', accountType: 'REVENUE', category: 'SELF_EMPLOYMENT_INCOME', assigned: 600, activity: 340 },
  { id: 'demo-rent', name: 'Rent', accountType: 'EXPENSE', category: 'HOUSING_RENT', assigned: 1850, activity: 1850 },
  { id: 'demo-groceries', name: 'Groceries', accountType: 'EXPENSE', category: 'FOOD_AND_DRINK_GROCERIES', assigned: 900, activity: 874 },
  { id: 'demo-dining', name: 'Dining out', accountType: 'EXPENSE', category: 'FOOD_AND_DRINK_RESTAURANT', assigned: 280, activity: 361 },
  { id: 'demo-utilities', name: 'Utilities', accountType: 'EXPENSE', category: 'UTILITIES', assigned: 240, activity: 212 },
  { id: 'demo-gas', name: 'Gas', accountType: 'EXPENSE', category: 'TRANSPORTATION_GAS', assigned: 180, activity: 158 },
  { id: 'demo-insurance', name: 'Insurance', accountType: 'EXPENSE', category: 'GENERAL_SERVICES_INSURANCE', assigned: 320, activity: 320 },
  { id: 'demo-fun', name: 'Entertainment', accountType: 'EXPENSE', category: 'ENTERTAINMENT', assigned: 150, activity: 96 },
  { id: 'demo-shopping', name: 'Shopping', accountType: 'EXPENSE', category: 'GENERAL_MERCHANDISE', assigned: 200, activity: 47 },
  { id: 'demo-pets', name: 'Pet care', accountType: 'EXPENSE', category: 'GENERAL_MERCHANDISE_PET_SUPPLIES', assigned: 0, activity: 64 },
  { id: 'demo-gym', name: 'Gym', accountType: 'EXPENSE', category: 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS', assigned: 0, activity: 0 },
];
function demoEntries(accountId) {
  const { start } = periodBounds(state.period, state.anchor);
  const envelope = DEMO.find((e) => e.id === accountId);
  if (!envelope || !envelope.activity) return [];
  const names = ['Corner Market', 'Whole Foods', 'Trader Joe\'s', 'Bodega', 'Costco'];
  const count = Math.min(5, Math.max(1, Math.round(envelope.activity / 200)));
  const share = Math.round((envelope.activity / count) * 100) / 100;
  return Array.from({ length: count }, (_, i) => ({
    id: `demo-entry-${i}`,
    date: iso(new Date(start.getFullYear(), start.getMonth(), 3 + i * 5)),
    journalId: `${accountId}-journal-${i}`,
    accountId,
    pending: false,
    amount: share,
    name: `${names[i % names.length]}`,
  })).reverse();
}
function runDemo() {
  state.demo = true;
  showApp();
  $('#signout').hidden = true;
  state.envelopes = DEMO.map((e) => ({ ...e }));
  $('#period-label').textContent = periodLabel(state.period, state.anchor);
  $('#empty').hidden = true;
  $('#budget').hidden = false;
  showError('<strong>Demo data</strong> — synthetic envelopes for previewing the UI. Amounts are editable but nothing is saved. Remove <code>#demo</code> from the URL and sign in for live data.');
  render();
}

async function init() {
  wireUi();
  if (window.location.hash.includes('demo')) return runDemo();
  if (!CONFIG.CLIENT_ID) {
    showConnect('Set CLIENT_ID in public/config.js to a public BigBooks OAuth client, then reload.', 'Configuration needed');
    return;
  }
  try {
    await completeRedirect();
  } catch (e) {
    showConnect(); showError(escapeHtml(e.message)); return;
  }
  if (getToken()) await startSession();
  else showConnect();
}

init();
