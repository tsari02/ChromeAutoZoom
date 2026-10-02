// Setup page: ?mode=onboarding (every connected display + the absent class)
// or ?mode=new-display&key=… (compact single-display prompt). No inline
// scripts/handlers (extension CSP). Talks to the SW via runtime.sendMessage.
import { MSG, SETUP_MODE } from '../lib/constants.js';
import { nearestStepIndex, factorAtStep, formatPercent, ZOOM_LADDER } from '../lib/zoom-ladder.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') === SETUP_MODE.NEW_DISPLAY ? SETUP_MODE.NEW_DISPLAY : SETUP_MODE.ONBOARDING;
const key = params.get('key') || null;

const $ = (sel) => document.querySelector(sel);
const rowsEl = $('#rows');
const applyBtn = $('#apply');
const template = $('#row-template');

/** key → current factor chosen in the UI */
const chosen = new Map();
let rows = [];

async function send(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (!res?.ok) throw new Error(res?.error ?? 'No response from AutoZoom');
  return res.result;
}

function setHeader() {
  if (mode === SETUP_MODE.NEW_DISPLAY) {
    $('#title').textContent = 'New display detected';
    $('#subtitle').textContent = 'Choose the default zoom for this monitor. AutoZoom will use it whenever a window is on this screen.';
    $('#hint').textContent = 'Closing this window keeps the suggested zoom.';
    applyBtn.textContent = 'Apply';
    document.title = 'AutoZoom — new display';
  } else {
    document.title = 'AutoZoom — setup';
  }
}

function fillSelect(select, factor) {
  select.replaceChildren(
    ...ZOOM_LADDER.map((f) => {
      const opt = document.createElement('option');
      opt.value = String(f);
      opt.textContent = formatPercent(f);
      return opt;
    }),
  );
  select.value = String(factorAtStep(nearestStepIndex(factor)));
}

function renderRow(row) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.key = row.key;
  node.querySelector('.row-name').textContent = row.name;
  const cls = node.querySelector('.pill-class');
  cls.textContent = row.isInternal ? 'Built-in' : 'External';
  cls.classList.toggle('internal', Boolean(row.isInternal));
  node.querySelector('.pill-status').textContent = row.connected ? '' : 'Not connected';

  const select = node.querySelector('.zoom-select');
  const down = node.querySelector('.step-down');
  const up = node.querySelector('.step-up');
  fillSelect(select, row.zoomFactor);
  chosen.set(row.key, Number(select.value));

  const sync = () => {
    const idx = nearestStepIndex(Number(select.value));
    down.disabled = idx <= 0;
    up.disabled = idx >= ZOOM_LADDER.length - 1;
    chosen.set(row.key, Number(select.value));
  };
  const step = (dir) => {
    const idx = nearestStepIndex(Number(select.value)) + dir;
    select.value = String(factorAtStep(idx));
    sync();
  };
  select.addEventListener('change', sync);
  down.addEventListener('click', () => step(-1));
  up.addEventListener('click', () => step(1));
  sync();
  return node;
}

function render() {
  rowsEl.replaceChildren(...rows.map(renderRow));
  rowsEl.setAttribute('aria-busy', 'false');
  applyBtn.disabled = rows.length === 0;
  if (rows.length === 0) {
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = 'No displays detected. Close this window and open AutoZoom from the toolbar to try again.';
    rowsEl.replaceChildren(p);
  }
  if (mode === SETUP_MODE.ONBOARDING && rows.length === 1) {
    applyBtn.textContent = `Apply ${formatPercent(chosen.get(rows[0].key))}`;
  }
}

async function load() {
  try {
    const data = await send({ type: MSG.GET_SETUP_DATA, mode, key });
    rows = data.rows;
    render();
  } catch (err) {
    rowsEl.setAttribute('aria-busy', 'false');
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = `Couldn't load displays: ${err.message}`;
    rowsEl.replaceChildren(p);
  }
}

let applying = false;
async function apply() {
  if (applying || rows.length === 0) return;
  applying = true;
  applyBtn.disabled = true;
  applyBtn.textContent = 'Applying…';
  try {
    const screens = {};
    for (const [k, factor] of chosen) screens[k] = factor;
    await send({ type: MSG.CONFIRM_SETUP, screens });
    window.close();
  } catch (err) {
    applying = false;
    applyBtn.disabled = false;
    applyBtn.textContent = 'Apply';
    const p = document.createElement('p');
    p.className = 'error';
    p.textContent = `Couldn't save: ${err.message}`;
    rowsEl.append(p);
  }
}

applyBtn.addEventListener('click', apply);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.target?.tagName !== 'SELECT') {
    e.preventDefault();
    apply();
  }
  if (e.key === 'Escape') window.close();
});

// A second unrecognised display may be queued while this window is open:
// the SW appends to session.pendingSetupKeys and we re-render.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.pendingSetupKeys && mode === SETUP_MODE.NEW_DISPLAY) load();
});

setHeader();
load();
