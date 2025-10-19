(() => {
  const navGroup = document.getElementById('navGroup');
  const navTarget = document.getElementById('navTarget');
  const navButtons = document.querySelectorAll('[data-nav]');
  const sendNavigate = document.getElementById('sendNavigate');
  const sendReload = document.getElementById('sendReload');
  const openTarget = document.getElementById('openTarget');
  const debugToggle = document.getElementById('debugToggle');
  const highlightDocSelect = document.getElementById('highlightDoc');
  const highlightSourceSelect = document.getElementById('highlightSource');
  const routerStatus = document.getElementById('routerStatus');

  const formIdInput = document.getElementById('formId');
  const formCooldown = document.getElementById('formCooldown');
  const formAllowRepeat = document.getElementById('formAllowRepeat');
  const formQuestion = document.getElementById('formQuestion');
  const formSave = document.getElementById('formSave');
  const formLock = document.getElementById('formLock');
  const formUnlock = document.getElementById('formUnlock');
  const formClear = document.getElementById('formClear');
  const formStatus = document.getElementById('formStatus');
  const formResultsTable = document.getElementById('formResults').querySelector('tbody');

  const panelIdInput = document.getElementById('panelId');
  const panelCooldown = document.getElementById('panelCooldown');
  const panelLocked = document.getElementById('panelLocked');
  const panelSave = document.getElementById('panelSave');
  const panelLock = document.getElementById('panelLock');
  const panelUnlock = document.getElementById('panelUnlock');
  const panelReset = document.getElementById('panelReset');
  const panelStatus = document.getElementById('panelStatus');
  const panelCountsTable = document.getElementById('panelCounts').querySelector('tbody');
  const panelEventsTable = document.getElementById('panelEvents').querySelector('tbody');

  const state = {
    formId: formIdInput.value.trim() || 'feedback',
    panelId: panelIdInput.value.trim() || 'main',
  };

  const navState = {
    preset: 'highlight',
    debug: true,
    highlightDoc: null,
    highlightSource: null,
  };

  const NAV_PRESETS = {
    highlight: buildHighlightTarget,
    form: buildFormTarget,
    buttons: buildButtonsTarget,
    cloud: buildCloudTarget,
  };

  navState.debug = debugToggle ? !!debugToggle.checked : true;

  if (debugToggle) {
    debugToggle.addEventListener('change', () => {
      navState.debug = !!debugToggle.checked;
      applyPreset(navState.preset);
    });
  }

  navButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-nav');
      if (NAV_PRESETS[key]) {
        navState.preset = key;
        navTarget.value = NAV_PRESETS[key]();
      }
    });
  });

  if (highlightDocSelect) {
    highlightDocSelect.addEventListener('change', () => {
      navState.highlightDoc = highlightDocSelect.value;
      if (navState.preset === 'highlight') {
        navTarget.value = buildHighlightTarget();
      }
    });
  }

  if (highlightSourceSelect) {
    highlightSourceSelect.addEventListener('change', () => {
      navState.highlightSource = highlightSourceSelect.value;
      if (navState.preset === 'highlight') {
        navTarget.value = buildHighlightTarget();
      }
    });
  }

  openTarget.addEventListener('click', () => {
    const finalTarget = ensureTarget(navTarget.value.trim());
    if (!finalTarget) return;
    window.open(new URL(finalTarget, location.origin), '_blank');
  });

  sendNavigate.addEventListener('click', async () => {
    const finalTarget = ensureTarget(navTarget.value.trim());
    if (!finalTarget) {
      alert('Provide a target URL (relative path).');
      return;
    }
    const payload = {
      action: 'navigate',
      group: navGroup.value || 'all',
      target: finalTarget,
      preserveClient: true,
      preserveParams: ['debug'],
    };
    await postJSON('/api/router/send', payload);
    updateRouterStatus();
  });

  sendReload.addEventListener('click', async () => {
    const finalTarget = ensureTarget(navTarget.value.trim());
    const payload = {
      action: 'reload',
      group: navGroup.value || 'all',
      target: finalTarget,
      preserveClient: true,
      preserveParams: ['debug'],
    };
    await postJSON('/api/router/send', payload);
    updateRouterStatus();
  });

  async function updateRouterStatus() {
    try {
      const data = await fetchJSON('/api/router/status');
      routerStatus.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      routerStatus.textContent = `Failed to load router status: ${err}`;
    }
  }

  function buildHighlightTarget() {
    const doc = navState.highlightDoc || highlightDocSelect.value || 'doc1';
    const source = navState.highlightSource || highlightSourceSelect.value || 'text.txt';
    return `/docs/index_sender.html?doc=${encodeURIComponent(doc)}&name=${encodeURIComponent(source)}&render=markdown&overlay=own&debug=${navState.debug ? '1' : '0'}`;
  }

  function buildFormTarget() {
    const form = formIdInput.value.trim() || 'feedback';
    return `/docs/form.html?form=${encodeURIComponent(form)}&debug=${navState.debug ? '1' : '0'}`;
  }

  function buildButtonsTarget() {
    const panel = panelIdInput.value.trim() || 'main';
    return `/docs/buttons.html?panel=${encodeURIComponent(panel)}&debug=${navState.debug ? '1' : '0'}`;
  }

  function buildCloudTarget() {
    const doc = navState.highlightDoc || highlightDocSelect.value || 'doc1';
    return `/docs/cloud.html?doc=${encodeURIComponent(doc)}&debug=${navState.debug ? '1' : '0'}`;
  }

  function applyPreset(preset) {
    const builder = NAV_PRESETS[preset];
    if (builder) {
      navTarget.value = builder();
    }
  }

  function ensureTarget(raw) {
    if (!raw) return '';
    try {
      const url = new URL(raw, location.origin);
      url.searchParams.set('debug', navState.debug ? '1' : '0');
      return url.pathname + url.search + url.hash;
    } catch (err) {
      alert('Invalid target URL.');
      return '';
    }
  }

  async function loadHighlightOptions() {
    if (!highlightDocSelect || !highlightSourceSelect) {
      navState.highlightDoc = navState.highlightDoc || 'doc1';
      navState.highlightSource = navState.highlightSource || 'text.txt';
      applyPreset('highlight');
      return;
    }
    try {
      const [docsRes, srcRes] = await Promise.all([
        fetchJSON('/api/docs'),
        fetchJSON('/api/sources'),
      ]);
      const docs = Array.isArray(docsRes.docs) ? docsRes.docs : [];
      const sources = Array.isArray(srcRes.sources) ? srcRes.sources : [];

      highlightDocSelect.innerHTML = '';
      docs.sort((a, b) => a.localeCompare(b));
      docs.forEach((doc) => {
        const opt = document.createElement('option');
        opt.value = doc;
        opt.textContent = doc;
        highlightDocSelect.appendChild(opt);
      });
      if (docs.length) {
        if (!navState.highlightDoc || !docs.includes(navState.highlightDoc)) {
          navState.highlightDoc = docs[0];
        }
        highlightDocSelect.value = navState.highlightDoc;
      }

      highlightSourceSelect.innerHTML = '';
      sources.sort((a, b) => a.localeCompare(b));
      sources.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        highlightSourceSelect.appendChild(opt);
      });
      if (sources.length) {
        if (!navState.highlightSource || !sources.includes(navState.highlightSource)) {
          navState.highlightSource = sources[0];
        }
        highlightSourceSelect.value = navState.highlightSource;
      }

      applyPreset('highlight');
    } catch (err) {
      console.error('Failed to load docs/sources', err);
    }
  }

  // ----- Forms -----
  async function loadFormConfig() {
    try {
      const data = await fetchJSON(`/api/forms/config?form=${encodeURIComponent(state.formId)}`);
      formCooldown.value = data.cooldown != null ? data.cooldown : 0;
      formAllowRepeat.checked = Boolean(data.allowRepeat);
      formQuestion.value = data.question || '';
      formStatus.textContent = data.locked ? 'Locked' : 'Open';
      formStatus.dataset.tone = data.locked ? 'warn' : 'info';
      formIdInput.value = state.formId;
    } catch (err) {
      formStatus.textContent = `Failed to load config: ${err}`;
      formStatus.dataset.tone = 'error';
    }
  }

  async function loadFormResults() {
    try {
      const data = await fetchJSON(`/api/forms/results?form=${encodeURIComponent(state.formId)}`);
      const rows = data.results || [];
      formResultsTable.innerHTML = '';
      rows.forEach((item) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${item.seq ?? ''}</td>
                        <td>${item.clientId ?? ''}</td>
                        <td>${escapeHTML(item.question ?? '')}</td>
                        <td>${escapeHTML(item.answer ?? '')}</td>
                        <td>${item.submitted ?? ''}</td>
                        <td>${item.submitted_iso ?? ''}</td>`;
        formResultsTable.appendChild(tr);
      });
    } catch (err) {
      formStatus.textContent = `Failed to load results: ${err}`;
      formStatus.dataset.tone = 'error';
    }
  }

  formIdInput.addEventListener('change', () => {
    state.formId = formIdInput.value.trim() || 'feedback';
    loadFormConfig();
    loadFormResults();
    if (navState.preset === 'form') {
      navTarget.value = buildFormTarget();
    }
  });

  formSave.addEventListener('click', async () => {
    const payload = {
      formId: state.formId,
      question: formQuestion.value,
      cooldown: Number(formCooldown.value || 0),
      allowRepeat: formAllowRepeat.checked,
    };
    try {
      await postJSON('/api/forms/config', payload);
      formStatus.textContent = 'Configuration saved.';
      formStatus.dataset.tone = 'info';
      await loadFormConfig();
    } catch (err) {
      formStatus.textContent = `Save failed: ${err}`;
      formStatus.dataset.tone = 'error';
    }
  });

  formLock.addEventListener('click', async () => {
    await fetchJSON(`/api/forms/control?action=lock&form=${encodeURIComponent(state.formId)}`);
    await loadFormConfig();
  });

  formUnlock.addEventListener('click', async () => {
    await fetchJSON(`/api/forms/control?action=unlock&form=${encodeURIComponent(state.formId)}`);
    await loadFormConfig();
  });

  formClear.addEventListener('click', async () => {
    if (!confirm('Clear all responses for this form?')) return;
    await postJSON(`/api/forms/clear?form=${encodeURIComponent(state.formId)}`);
    await loadFormConfig();
    await loadFormResults();
  });

  // ----- Buttons -----
  async function loadPanelState() {
    try {
      const config = await fetchJSON(`/api/triggers/config?panel=${encodeURIComponent(state.panelId)}`);
      panelCooldown.value = config.cooldown != null ? config.cooldown : 0;
      panelLocked.checked = Boolean(config.locked);
      panelStatus.textContent = config.locked ? 'Locked' : 'Open';
      panelStatus.dataset.tone = config.locked ? 'warn' : 'info';
      panelIdInput.value = state.panelId;
    } catch (err) {
      panelStatus.textContent = `Config error: ${err}`;
      panelStatus.dataset.tone = 'error';
    }

    try {
      const data = await fetchJSON(`/api/triggers/state?panel=${encodeURIComponent(state.panelId)}`);
      renderPanelCounts(data.buttons || {});
      renderPanelEvents(data.events || []);
    } catch (err) {
      panelStatus.textContent = `State error: ${err}`;
      panelStatus.dataset.tone = 'error';
    }
  }

  function renderPanelCounts(buttons) {
    panelCountsTable.innerHTML = '';
    Object.entries(buttons).forEach(([id, info]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${id}</td><td>${info.minus ?? 0}</td><td>${info.plus ?? 0}</td>`;
      panelCountsTable.appendChild(tr);
    });
  }

  function renderPanelEvents(events) {
    panelEventsTable.innerHTML = '';
    events.forEach((event) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${event.seq ?? ''}</td>
                      <td>${event.buttonId ?? ''}</td>
                      <td>${escapeHTML(event.label ?? '')}</td>
                      <td>${event.direction ?? ''}</td>
                      <td>${event.clientId ?? ''}</td>
                      <td>${event.timestamp ?? ''}</td>
                      <td>${event.timestamp_iso ?? ''}</td>`;
      panelEventsTable.appendChild(tr);
    });
  }

  panelIdInput.addEventListener('change', () => {
    state.panelId = panelIdInput.value.trim() || 'main';
    loadPanelState();
    if (navState.preset === 'buttons') {
      navTarget.value = buildButtonsTarget();
    }
  });

  panelSave.addEventListener('click', async () => {
    const payload = {
      panelId: state.panelId,
      cooldown: Number(panelCooldown.value || 0),
      locked: panelLocked.checked,
    };
    await postJSON('/api/triggers/config', payload);
    await loadPanelState();
  });

  panelLock.addEventListener('click', async () => {
    await fetchJSON(`/api/triggers/control?action=lock&panel=${encodeURIComponent(state.panelId)}`);
    await loadPanelState();
  });

  panelUnlock.addEventListener('click', async () => {
    await fetchJSON(`/api/triggers/control?action=unlock&panel=${encodeURIComponent(state.panelId)}`);
    await loadPanelState();
  });

  panelReset.addEventListener('click', async () => {
    if (!confirm('Reset counts and events for this panel?')) return;
    await postJSON(`/api/triggers/reset?panel=${encodeURIComponent(state.panelId)}`);
    await loadPanelState();
  });

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : null,
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`HTTP ${res.status} ${detail}`);
    }
    if (res.headers.get('content-type')?.includes('application/json')) {
      return res.json();
    }
    return {};
  }

  function escapeHTML(str) {
    return String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  loadHighlightOptions();
  loadFormConfig();
  loadFormResults();
  loadPanelState();
  updateRouterStatus();

  setInterval(loadFormResults, 15000);
  setInterval(loadPanelState, 8000);
  setInterval(updateRouterStatus, 10000);
})();
