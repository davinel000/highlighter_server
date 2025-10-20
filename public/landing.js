(() => {
  const AGREEMENT_NAME = 'agreement.md';

  const statusEl = document.getElementById('landingStatus');
  const agreementEl = document.getElementById('agreement');
  const agreeBtn = document.getElementById('agreeBtn');
  const disagreeBtn = document.getElementById('disagreeBtn');

  if (window.ControlChannel) {
    window.ControlChannel.init({ group: 'sender', onMessage: handleControlMessage });
  }

  loadAgreement();
  bootstrap();

  agreeBtn.addEventListener('click', onAgreeClick);
  disagreeBtn.addEventListener('click', () => {
    setStatus('You need to agree to continue.');
  });

  async function bootstrap() {
    setStatus('Checking agreement status…');
    const clientId = await waitForClientId();
    if (!clientId) {
      setStatus('Unable to identify this device. Refresh the page.');
      return;
    }
    try {
      const status = await fetchAgreementStatus(clientId, true);
      if (status?.accepted) {
        redirectToDefault();
        return;
      }
      setStatus('Please review the agreement to continue.');
    } catch (err) {
      console.warn('Agreement status check failed', err);
      setStatus('Agreement status unavailable. Please review and accept to continue.');
    }
  }

  async function loadAgreement() {
    try {
      const res = await fetch(`/api/text?name=${encodeURIComponent(AGREEMENT_NAME)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      agreementEl.innerHTML = html;
    } catch (err) {
      agreementEl.textContent = 'Unable to load agreement text.';
      console.error('Agreement load failed', err);
    }
  }

  async function onAgreeClick() {
    const clientId = getClientId();
    if (!clientId) {
      setStatus('Unable to identify this device. Refresh and try again.');
      return;
    }
    const originalLabel = agreeBtn.textContent;
    agreeBtn.disabled = true;
    agreeBtn.textContent = 'Saving…';
    setStatus('Recording your agreement…');
    let succeeded = false;
    try {
      await postAgreement(clientId);
      await fetchAgreementStatus(clientId, true);
      setStatus('Thank you!');
      succeeded = true;
      redirectToDefault();
    } catch (err) {
      console.error('Agreement accept failed', err);
      setStatus('Unable to record agreement. Please try again.');
    } finally {
      if (succeeded) {
        agreeBtn.textContent = 'Accepted';
        agreeBtn.disabled = true;
      } else {
        agreeBtn.disabled = false;
        agreeBtn.textContent = originalLabel;
      }
    }
  }

  function getClientId() {
    if (window.ControlChannel?.getClientId) {
      return window.ControlChannel.getClientId();
    }
    const usp = new URLSearchParams(location.search);
    return usp.get('client');
  }

  async function waitForClientId(timeout = 3000) {
    const started = Date.now();
    let id = getClientId();
    while (!id && Date.now() - started < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      id = getClientId();
    }
    return id;
  }

  async function fetchAgreementStatus(clientId, force = false) {
    if (window.ControlChannel?.fetchAgreementStatus) {
      return window.ControlChannel.fetchAgreementStatus(clientId, force);
    }
    const res = await fetch(`/api/agreement/status?client=${encodeURIComponent(clientId)}`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  async function postAgreement(clientId) {
    const payload = {
      clientId,
      meta: {
        ua: navigator.userAgent,
        agreedAt: Date.now(),
        path: location.pathname,
      },
    };
    const res = await fetch('/api/agreement/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`HTTP ${res.status} ${detail}`);
    }
    return res.json().catch(() => ({}));
  }

  async function redirectToDefault() {
    try {
      const res = await fetch('/api/router/default', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const target = data.default;
      if (target) {
        if (window.ControlChannel?.redirectWithClient) {
          window.ControlChannel.redirectWithClient(target, ['doc', 'name', 'form', 'panel', 'debug']);
        } else {
          window.location.assign(target);
        }
      } else {
        setStatus('Waiting for the session to start.');
      }
    } catch (err) {
      console.error('Failed to fetch default target', err);
      setStatus('Unable to determine destination.');
    }
  }

  function handleControlMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'navigate' && msg.target) {
      if (window.ControlChannel?.redirectWithClient) {
        window.ControlChannel.redirectWithClient(msg.target, msg.preserveParams);
      } else {
        window.location.assign(msg.target);
      }
    }
    if (msg.type === 'reload') {
      window.location.reload();
    }
  }

  function setStatus(text) {
    statusEl.textContent = text || '';
  }
})();
