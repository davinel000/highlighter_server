(() => {
  const AGREEMENT_NAME = 'agreement.md';
  const AGREED_KEY = 'landing_agreed_v1';

  const statusEl = document.getElementById('landingStatus');
  const agreementEl = document.getElementById('agreement');
  const agreeBtn = document.getElementById('agreeBtn');
  const disagreeBtn = document.getElementById('disagreeBtn');

  if (window.ControlChannel) {
    window.ControlChannel.init({ group: 'sender', onMessage: handleControlMessage });
  }

  loadAgreement();

  if (localStorage.getItem(AGREED_KEY) === '1') {
    redirectToDefault();
  }

  agreeBtn.addEventListener('click', () => {
    localStorage.setItem(AGREED_KEY, '1');
    redirectToDefault();
  });

  disagreeBtn.addEventListener('click', () => {
    localStorage.removeItem(AGREED_KEY);
    setStatus('You need to agree to continue.');
  });

  async function loadAgreement(){
    try{
      const res = await fetch(`/api/text?name=${encodeURIComponent(AGREEMENT_NAME)}`, {cache:'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      agreementEl.innerHTML = html;
    }catch(err){
      agreementEl.textContent = 'Unable to load agreement text.';
      console.error('Agreement load failed', err);
    }
  }

  async function redirectToDefault(){
    try{
      const res = await fetch('/api/router/default', {cache:'no-store'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const target = data.default;
      if (target){
        window.location.assign(target);
      }else{
        setStatus('Waiting for the session to start.');
      }
    }catch(err){
      console.error('Failed to fetch default target', err);
      setStatus('Unable to determine destination.');
    }
  }

  function handleControlMessage(msg){
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'navigate' && msg.target){
      window.location.assign(msg.target);
    }
    if (msg.type === 'reload'){
      window.location.reload();
    }
  }

  function setStatus(text){
    statusEl.textContent = text || '';
  }
})();
