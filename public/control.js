(() => {
  function initControlChannel(options) {
    const { group, onMessage } = options || {};
    const usp = new URLSearchParams(location.search);
    let clientId = usp.get('client');
    if (!clientId) {
      clientId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      usp.set('client', clientId);
      history.replaceState(null, '', `${location.pathname}?${usp.toString()}`);
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/control?group=${encodeURIComponent(group || 'all')}&client=${encodeURIComponent(clientId)}`;

    let ws;
    function connect() {
      ws = new WebSocket(url);
      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (_) {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'navigate') {
          handleNavigate(msg, clientId);
        } else if (msg.type === 'reload') {
          location.reload();
        }
        if (onMessage) {
          try {
            onMessage(msg);
          } catch (_) {
            /* ignore */
          }
        }
      };
      ws.onclose = () => {
        setTimeout(connect, 1500);
      };
    }
    connect();
  }

  function handleNavigate(msg, clientId) {
    if (!msg || !msg.target) return;
    try {
      const current = new URL(location.href);
      const dest = new URL(msg.target, current.origin);

      const preserve = new Set(msg.preserveParams || []);
      ['doc','name','form','panel','debug'].forEach((param)=>{
        if (!dest.searchParams.has(param) && current.searchParams.has(param)) {
          preserve.add(param);
        }
      });
      if (msg.preserveClient !== false) {
        preserve.add('client');
      }
      preserve.forEach((param) => {
        if (param === 'client' && !dest.searchParams.has('client')) {
          dest.searchParams.set('client', clientId);
          return;
        }
        const value = current.searchParams.get(param);
        if (value && !dest.searchParams.has(param)) {
          dest.searchParams.set(param, value);
        }
      });
      location.href = dest.toString();
    } catch (err) {
      console.error('Navigate failed', err);
    }
  }

  window.ControlChannel = { init: initControlChannel };
})();
