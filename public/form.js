(() => {
  const usp = new URLSearchParams(location.search);

  const theme = (usp.get('theme') || '').toLowerCase();
  document.body.setAttribute('data-theme', theme === 'dark' ? 'dark' : '');

  const formIdRaw = usp.get('form') || 'feedback';
  let formId = formIdRaw.trim() || 'feedback';

  let clientId = usp.get('client');
  if (!clientId) {
    clientId = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    usp.set('client', clientId);
    history.replaceState(null, '', `${location.pathname}?${usp.toString()}`);
  }

  const debugMode = usp.get('debug') !== '0';
  const agreementFlag = (usp.get('agreement') || '').toLowerCase();
  const skipAgreement = debugMode || agreementFlag === '0' || agreementFlag === 'off' || agreementFlag === 'skip';

  if (window.ControlChannel) {
    window.ControlChannel.init({ group: 'form' });
    if (!skipAgreement) {
      window.ControlChannel.requireAgreement?.({
        redirectTo: '/',
        preserveParams: ['form', 'debug'],
        force: true,
        onError: 'redirect',
      });
    }
  }

  const state = {
    config: null,
    lastSeq: 0,
  };

  const formSelect = document.getElementById('formSelect');
  const clientLbl = document.getElementById('clientLbl');
  const statusEl = document.getElementById('status');
  const questionEl = document.getElementById('question');
  const answerEl = document.getElementById('answer');
  const submitBtn = document.getElementById('submitBtn');
  const formCard = document.getElementById('formCard');
  const successCard = document.getElementById('successCard');
  const anotherBtn = document.getElementById('anotherBtn');
  const successMessage = document.getElementById('successMessage');

  if (formSelect){
    populateForms(formId);
    formSelect.addEventListener('change', (ev)=>{
      const next = ev.target.value;
      if (!next || next === formId) return;
      usp.set('form', next);
      location.href = `${location.pathname}?${usp.toString()}`;
    });
  }

  clientLbl.textContent = clientId;

  if (!debugMode && formSelect){
    formSelect.disabled = true;
  }

  function setStatus(text, tone = 'info') {
    statusEl.textContent = text || '';
    statusEl.dataset.tone = tone;
  }

  function setLocked(locked) {
    submitBtn.disabled = locked;
    answerEl.disabled = locked;
    if (locked) {
      setStatus('Form is closed for submissions.', 'warn');
    } else {
      if (state.config && state.config.cooldown > 0) {
        setStatus(`Cooldown: ${Math.round(state.config.cooldown)}s`, 'info');
      } else {
        setStatus('');
      }
    }
  }

  function hideSuccess() {
    successCard.classList.add('hidden');
    formCard.classList.remove('hidden');
    answerEl.value = '';
    answerEl.focus();
  }

  function showSuccess(message) {
    formCard.classList.add('hidden');
    successCard.classList.remove('hidden');
    successMessage.textContent = message;
    if (state.config && !state.config.allowRepeat) {
      anotherBtn.classList.add('hidden');
    } else {
      anotherBtn.classList.remove('hidden');
    }
  }

  async function loadConfig() {
    try {
      const res = await fetch(`/api/forms/config?form=${encodeURIComponent(formId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.config = data;
      questionEl.textContent = data.question || 'Share your thoughts.';
      if (data.cooldown && data.cooldown > 0) {
        setStatus(`Cooldown: ${Math.round(data.cooldown)}s`, 'info');
      } else {
        setStatus('');
      }
      setLocked(Boolean(data.locked));
    } catch (err) {
      console.error('Failed to load form config', err);
      setStatus('Failed to load form configuration.', 'error');
      setLocked(true);
    }
  }

  function parseErrorDetail(detail) {
    if (!detail) return { message: 'Unexpected error', error: 'unknown' };
    if (typeof detail === 'string') return { message: detail, error: 'unknown' };
    const { message, error, retry_in } = detail;
    return { message: message || 'Unexpected error', error: error || 'unknown', retry_in };
  }

  async function submitAnswer() {
    const value = answerEl.value.trim();
    if (!value) {
      setStatus('Please enter a response before sending.', 'warn');
      answerEl.focus();
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';
    try {
      const res = await fetch('/api/forms/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formId, clientId, answer: value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const detail = body?.detail || body;
        const info = parseErrorDetail(detail);
        if (info.error === 'cooldown' && info.retry_in !== undefined) {
          setStatus(`Please wait ${Math.ceil(info.retry_in)}s before sending again.`, 'warn');
        } else if (info.error === 'locked') {
          setStatus('Form is closed for submissions.', 'warn');
          setLocked(true);
        } else {
          setStatus(info.message, 'error');
        }
        return;
      }
      const data = await res.json();
      showSuccess('Thank you! Your response has been recorded.');
      setStatus('Submission saved.', 'info');
      await loadConfig();
    } catch (err) {
      console.error('Submit failed', err);
      setStatus('Failed to submit. Please try again.', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Send';
    }
  }

  submitBtn.addEventListener('click', submitAnswer);
  answerEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      submitAnswer();
    }
  });

  anotherBtn.addEventListener('click', () => {
    hideSuccess();
    if (state.config && state.config.cooldown > 0) {
      setStatus(`Cooldown: ${Math.round(state.config.cooldown)}s`, 'info');
    } else {
      setStatus('');
    }
  });

  loadConfig();
  answerEl.value = '';
  answerEl.focus();
  setInterval(loadConfig, 15000);
})();


async function populateForms(current){
  const select = document.getElementById('formSelect');
  if (!select) return;
  try{
    const res = await fetch('/api/forms', {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    const forms = Array.isArray(data.forms) ? data.forms : [];
    if (current && !forms.includes(current)) forms.push(current);
    forms.sort((a,b)=>a.localeCompare(b));
    select.innerHTML = '';
    forms.forEach((id)=>{
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id;
      if (id === current) opt.selected = true;
      select.appendChild(opt);
    });
  }catch(err){
    console.error('Failed to load form list', err);
  }
}
