(() => {
  const usp = new URLSearchParams(location.search);

  const theme = (usp.get('theme') || '').toLowerCase();
  document.body.setAttribute('data-theme', theme === 'dark' ? 'dark' : '');

  const panelIdRaw = usp.get('panel') || 'main';
  let panelId = panelIdRaw.trim() || 'main';

  let clientId = usp.get('client');
  if (!clientId) {
    clientId = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    usp.set('client', clientId);
    history.replaceState(null, '', `${location.pathname}?${usp.toString()}`);
  }

  if (window.ControlChannel) {
    window.ControlChannel.init({ group: 'buttons' });
  }

  const panelSelect = document.getElementById('panelSelect');
  const clientLbl = document.getElementById('clientLbl');
  const statusEl = document.getElementById('status');
  const cooldownPill = document.getElementById('cooldownPill');
  const cooldownLbl = document.getElementById('cooldownLbl');
  const buttonsGrid = document.getElementById('buttonsGrid');
  const debugMode = usp.get('debug') !== '0';

  clientLbl.textContent = clientId;

  if (!debugMode && panelSelect){
    panelSelect.disabled = true;
  }

  if (panelSelect){
    populatePanelOptions(panelId);
    panelSelect.addEventListener('change', (ev)=>{
      const next = ev.target.value;
      if (!next || next === panelId) return;
      usp.set('panel', next);
      location.href = `${location.pathname}?${usp.toString()}`;
    });
  }

  const refs = new Map();
  const state = {
    locked: false,
    cooldown: 0,
    lastSeq: 0,
  };

  function setStatus(text, tone = 'info') {
    statusEl.textContent = text || '';
    statusEl.dataset.tone = tone;
  }

  function setLocked(locked) {
    state.locked = locked;
    refs.forEach((ref) => {
      ref.minus.disabled = locked;
      ref.plus.disabled = locked;
    });
    if (locked) {
      setStatus('Panel is locked.', 'warn');
    } else {
      setStatus('');
    }
  }

  function updateCooldownDisplay(value) {
    state.cooldown = Math.max(0, value || 0);
    if (state.cooldown > 0) {
      cooldownLbl.textContent = `${Math.round(state.cooldown)}s`;
      cooldownPill.hidden = false;
    } else {
      cooldownPill.hidden = true;
    }
  }

  function formatCounts(minus, plus) {
    return '- ' + minus + ' / + ' + plus;
  }

  function buildButtons(buttons) {
    refs.clear();
    buttonsGrid.innerHTML = '';
    buttons.forEach((btn) => {
      const row = document.createElement('div');
      row.className = 'btn-row';
      row.dataset.id = btn.id;

      const minusBtn = document.createElement('button');
      minusBtn.className = 'btn ctrl-btn';
      minusBtn.dataset.direction = 'minus';
      minusBtn.dataset.id = btn.id;
      minusBtn.type = 'button';
      minusBtn.textContent = '−';

      const labelBox = document.createElement('div');
      labelBox.className = 'label';
      const labelText = document.createElement('span');
      labelText.className = 'label-text';
      labelText.textContent = btn.label;
      const countText = document.createElement('span');
      countText.className = 'count';
      countText.textContent = formatCounts(btn.minus, btn.plus);
      labelBox.append(labelText, countText);

      const plusBtn = document.createElement('button');
      plusBtn.className = 'btn ctrl-btn';
      plusBtn.dataset.direction = 'plus';
      plusBtn.dataset.id = btn.id;
      plusBtn.type = 'button';
      plusBtn.textContent = '+';

      row.append(minusBtn, labelBox, plusBtn);
      buttonsGrid.appendChild(row);

      refs.set(btn.id, { minus: minusBtn, plus: plusBtn, count: countText });

      minusBtn.addEventListener('click', () => trigger(btn.id, 'minus'));
      plusBtn.addEventListener('click', () => trigger(btn.id, 'plus'));
    });

    setLocked(state.locked);
  }

  function applyButtonCounts(buttons) {
    Object.entries(buttons || {}).forEach(([id, data]) => {
      const ref = refs.get(id);
      if (ref) {
        ref.count.textContent = formatCounts(data.minus, data.plus);
      }
    });
  }

  async function fetchConfig() {
    try {
      const res = await fetch(`/api/triggers/config?panel=${encodeURIComponent(panelId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      buildButtons(data.buttons || []);
      setLocked(Boolean(data.locked));
      updateCooldownDisplay(data.cooldown || 0);
      if (data.nextSeq) {
        state.lastSeq = Math.max(state.lastSeq, Number(data.nextSeq) - 1);
      }
    } catch (err) {
      console.error('Failed to load button config', err);
      setStatus('Failed to load controls.', 'error');
      setLocked(true);
    }
  }

  function parseErrorDetail(detail) {
    if (!detail) return { message: 'Unexpected error', error: 'unknown' };
    if (typeof detail === 'string') return { message: detail, error: 'unknown' };
    const { message, error, retry_in } = detail;
    return { message: message || 'Unexpected error', error: error || 'unknown', retry_in };
  }

  async function trigger(buttonId, direction) {
    if (state.locked) {
      setStatus('Panel is locked.', 'warn');
      return;
    }
    const ref = refs.get(buttonId);
    if (ref) {
      ref.minus.disabled = true;
      ref.plus.disabled = true;
    }
    try {
      const res = await fetch('/api/triggers/fire', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panelId, clientId, buttonId, direction }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const detail = body?.detail || body;
        const info = parseErrorDetail(detail);
        if (info.error === 'cooldown' && info.retry_in !== undefined) {
          setStatus(`Please wait ${Math.ceil(info.retry_in)}s before pressing again.`, 'warn');
        } else if (info.error === 'locked') {
          setLocked(true);
        } else {
          setStatus(info.message, 'error');
        }
        return;
      }
      const data = await res.json();
      const event = data.event || {};
      state.lastSeq = Math.max(state.lastSeq, event.seq || state.lastSeq);
      await fetchState();
    } catch (err) {
      console.error('Trigger failed', err);
      setStatus('Failed to send command.', 'error');
    } finally {
      if (ref) {
        ref.minus.disabled = state.locked;
        ref.plus.disabled = state.locked;
      }
    }
  }

  async function fetchState() {
    try {
      const since = state.lastSeq ? `&since=${state.lastSeq}` : '';
      const res = await fetch(`/api/triggers/state?panel=${encodeURIComponent(panelId)}${since}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      applyButtonCounts(data.buttons || {});
      if (Array.isArray(data.events)) {
        data.events.forEach((event) => {
          state.lastSeq = Math.max(state.lastSeq, event.seq || 0);
        });
      }
      updateCooldownDisplay(data.cooldown || 0);
      if (typeof data.locked === 'boolean') {
        setLocked(data.locked);
      }
    } catch (err) {
      console.error('Failed to fetch state', err);
    }
  }

  fetchConfig().then(fetchState);
  setInterval(fetchState, 2000);
})();


async function populatePanelOptions(current){
  const select = document.getElementById('panelSelect');
  if (!select) return;
  try{
    const res = await fetch('/api/panels', {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    const panels = Array.isArray(data.panels) ? data.panels : [];
    if (current && !panels.includes(current)) panels.push(current);
    panels.sort((a,b)=>a.localeCompare(b));
    select.innerHTML = '';
    panels.forEach((id)=>{
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      if (id === current) opt.selected = true;
      select.appendChild(opt);
    });
  }catch(err){
    console.error('Failed to load panel list', err);
  }
}
