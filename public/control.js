(() => {
  let currentClientId = null;
  let lastAgreementCheck = {
    clientId: null,
    revision: null,
    accepted: false,
    timestamp: 0,
  };

  function ensureClientId() {
    const usp = new URLSearchParams(location.search);
    let clientId = usp.get('client');
    if (!clientId) {
      clientId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      usp.set('client', clientId);
      history.replaceState(null, '', `${location.pathname}?${usp.toString()}`);
    }
    currentClientId = clientId;
    return clientId;
  }

  function getClientId() {
    if (currentClientId) {
      return currentClientId;
    }
    const usp = new URLSearchParams(location.search);
    const fromQuery = usp.get('client');
    if (fromQuery) {
      currentClientId = fromQuery;
    }
    return currentClientId;
  }

  function redirectWithClient(target, preserveParams, clientId) {
    const id = clientId || getClientId();
    try {
      const current = new URL(location.href);
      const dest = new URL(target, current.origin);
      const preserve = new Set(preserveParams || []);
      if (!dest.searchParams.has('client') && id) {
        dest.searchParams.set('client', id);
      }
      preserve.forEach((param) => {
        if (param === 'client') {
          return;
        }
        if (!dest.searchParams.has(param) && current.searchParams.has(param)) {
          dest.searchParams.set(param, current.searchParams.get(param));
        }
      });
      location.assign(dest.toString());
    } catch (err) {
      console.error('Navigate failed', err);
      if (id && target && typeof target === 'string') {
        const url = target.includes('?') ? `${target}&client=${encodeURIComponent(id)}` : `${target}?client=${encodeURIComponent(id)}`;
        location.assign(url);
      } else {
        location.assign(target);
      }
    }
  }

  async function fetchAgreementStatus(clientId, force = false) {
    const id = clientId || getClientId();
    if (!id) {
      throw new Error('clientId unavailable');
    }
    if (
      !force &&
      lastAgreementCheck.clientId === id &&
      lastAgreementCheck.accepted &&
      Date.now() - lastAgreementCheck.timestamp < 5000
    ) {
      return {
        accepted: lastAgreementCheck.accepted,
        revision: lastAgreementCheck.revision,
      };
    }
    const res = await fetch(`/api/agreement/status?client=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    lastAgreementCheck = {
      clientId: id,
      revision: data.revision ?? null,
      accepted: Boolean(data.accepted),
      timestamp: Date.now(),
    };
    return data;
  }

  async function requireAgreement(options) {
    const opts = options || {};
    const clientId = opts.clientId || getClientId();
    const redirectTo = opts.redirectTo || '/';
    const preserve = opts.preserveParams || [];
    const onErrorRedirect = opts.onError === 'redirect';
    try {
      const status = await fetchAgreementStatus(clientId, opts.force === true);
      if (status.accepted) {
        return true;
      }
      if (opts.redirect !== false) {
        redirectWithClient(redirectTo, preserve, clientId);
      }
      return false;
    } catch (err) {
      console.warn('Agreement status check failed', err);
      if (onErrorRedirect) {
        redirectWithClient(redirectTo, preserve, clientId);
      }
      return false;
    }
  }

  function initControlChannel(options) {
    const { group, onMessage } = options || {};
    const clientId = ensureClientId();
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
      ['doc', 'name', 'form', 'panel', 'debug'].forEach((param) => {
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

  window.ControlChannel = {
    init: initControlChannel,
    getClientId,
    requireAgreement,
    fetchAgreementStatus,
    redirectWithClient: (target, preserveParams) => redirectWithClient(target, preserveParams, getClientId()),
  };

  window.requireAgreement = requireAgreement;
})();
