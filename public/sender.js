(() => {
  const usp = new URLSearchParams(location.search);

  // overlay modes: own (default), all, none/0
  const ov = (usp.get('overlay') || 'own').toLowerCase();
  const overlayMode = (ov === 'all') ? 'all' : ((ov === 'none' || ov === '0') ? 'none' : 'own');

  const theme = (usp.get('theme') || 'light').toLowerCase();
  document.body.setAttribute('data-theme', theme === 'dark' ? 'dark' : '');

  const MAX_RANGE = Math.max(1, parseInt(usp.get('max') || '8', 10));
  let docId = usp.get('doc') || 'doc1';
  let datName = usp.get('name') || 'doc_text';              // source in wwwdocs/
  const renderMode = (usp.get('render') || 'text').toLowerCase(); // text|html|markdown

  let clientId = usp.get('client');
  if (!clientId) {
    clientId = (crypto.randomUUID?.() || (Date.now() + '-' + Math.random().toString(36).slice(2)));
    usp.set('client', clientId);
    history.replaceState(null, '', `${location.pathname}?${usp.toString()}`);
  }

  if (window.ControlChannel) {
    window.ControlChannel.init({ group: 'sender' });
  }

  // ====== Управление кеглем (A− / A+) с хранением в localStorage ======
  const root = document.documentElement;
  const fsKey = `fs:${docId}`;          // per-document на устройстве
  const minFs = 14, maxFs = 26;         // границы, px
  function getCssNum(varName, fallback){
    const v = getComputedStyle(root).getPropertyValue(varName).trim();
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  let baseFs = parseInt(localStorage.getItem(fsKey) || getCssNum('--fs', 16), 10);
  const baseLh0 = getCssNum('--lh', 1.8);

  function applyFs(){
    root.style.setProperty('--fs', baseFs + 'px');
    const lh = Math.max(1.4, +(baseLh0 + (baseFs - 16)*0.02).toFixed(2));
    root.style.setProperty('--lh', String(lh));
    try { localStorage.setItem(fsKey, String(baseFs)); } catch(e){}
  }
  window.addEventListener('DOMContentLoaded', () => {
    const minus = document.getElementById('fsMinus');
    const plus  = document.getElementById('fsPlus');
    if (minus && plus){
      minus.addEventListener('click', ()=>{ baseFs = Math.max(minFs, baseFs - 1); applyFs(); });
      plus .addEventListener('click', ()=>{ baseFs = Math.min(maxFs, baseFs + 1); applyFs(); });
    }
    applyFs();
  });

  // ====== элементы UI ======
  const topbar = document.getElementById('topbar');
  const padder = document.getElementById('padder');
  const docSelect = document.getElementById('docSelect');
  const sourceSelect = document.getElementById('sourceSelect');
  const clientLbl = document.getElementById('clientLbl');
  const contentEl = document.getElementById('content');
  const statusEl = document.getElementById('status');
  const clearBtn = document.getElementById('clearBtn');
  const resetBtn = document.getElementById('resetDoc');
  const debugMode = usp.get('debug') !== '0';

  clientLbl.textContent = clientId;

  if (!debugMode){
    if (docSelect){ docSelect.disabled = true; }
    if (sourceSelect){ sourceSelect.disabled = true; }
    if (resetBtn){ resetBtn.classList.add('hidden'); }
  }

  if (docSelect){
    populateDocOptions(docId);
    docSelect.addEventListener('change', (ev)=>{
      const next = ev.target.value;
      if (!next || next === docId) return;
      usp.set('doc', next);
      location.href = `${location.pathname}?${usp.toString()}`;
      });
  }

  if (sourceSelect){
    populateSourceOptions(datName);
    sourceSelect.addEventListener('change', (ev)=>{
      const next = ev.target.value;
      if (!next || next === datName) return;
      usp.set('name', next);
      location.href = `${location.pathname}?${usp.toString()}`;
      });
  }

  function fixTop(){ const h = Math.ceil(topbar.getBoundingClientRect().height); padder.style.height = h+'px'; document.documentElement.style.setProperty('--topH', h+'px'); }
  new ResizeObserver(fixTop).observe(topbar); fixTop();

  let ws = null, locked = false, tokens = [], anchor = null, currentColor = 'c1';

  function status(s){ statusEl.textContent = s; }
  function setLocked(v){
    locked = !!v;
    contentEl.style.pointerEvents = locked ? 'none' : '';
    clearBtn.disabled = locked;
    status(locked ? 'Thank you for your voices' : '');
  }
  document.querySelectorAll('.sw').forEach(el => el.addEventListener('click', () => {
    currentColor = el.getAttribute('data-c'); status('Color: ' + currentColor.toUpperCase());
  }));

  // ====== REST ======
  async function fetchTokens(){
    const r = await fetch(`/api/tokens?doc=${encodeURIComponent(docId)}&name=${encodeURIComponent(datName)}`, {cache:'no-store'});
    if (!r.ok) return [];
    const data = await r.json();
    return data.tokens || [];
  }
  async function fetchRaw(){
    const r = await fetch(`/api/text?name=${encodeURIComponent(datName)}`, {cache:'no-store'});
    return r.ok ? await r.text() : '';
  }

  // лёгкая санитизация, если понадобится render=html
  function sanitizeHtml(html){
    html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, '');
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/\s(on\w+|style)\s*=\s*"(?:[^"\\]|\\.)*"/gi, '');
    html = html.replace(/\s(on\w+|style)\s*=\s*'(?:[^'\\]|\\.)*'/gi, '');
    return html;
  }

  const RE_SPLIT = /([\s]+|[.,:;!?()"'\[\]{}\u00ab\u00bb\u201c\u201d\u2014\u2013\u2026-])/u;
  const PUNCT_RE = /^[.,:;!?()"'\[\]{}\u00ab\u00bb\u201c\u201d\u2014\u2013\u2026-]+$/u;

  // рендер «плоского» текста (для text.txt)
  function renderTextPlain(){
    const before = performance.now();
    contentEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    tokens.forEach((t,i)=>{
      const span = document.createElement('span');
      span.className='tok'; span.dataset.i=String(i);
      const isPunc = (t === '\n') || PUNCT_RE.test(t);
      if (isPunc) span.dataset.punc='1';
      span.textContent = (i>0 && tokens[i-1] !== '\n' && !isPunc ? ' ' : '') + t + (t === '\n' ? '\n' : '');
      frag.appendChild(span);
    });
    contentEl.appendChild(frag);
    void before; // keep for debug if needed
  }

  // рендер HTML с сохранением структуры (если используешь render=html)
  function renderHtmlPreservingStructure(rawHtml){
    contentEl.innerHTML = sanitizeHtml(rawHtml);

    const walker = document.createTreeWalker(
      contentEl,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const p = node.parentNode;
          if (!p) return NodeFilter.FILTER_REJECT;
          const tn = p.nodeName;
          if (tn === 'SCRIPT' || tn === 'STYLE') return NodeFilter.FILTER_REJECT;
          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
          if (!node.nodeValue.trim() && !/\s+/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    let tokIdx = 0;
    const total = tokens.length;
    const toProcess = [];
    while (walker.nextNode()) toProcess.push(walker.currentNode);

    for (const textNode of toProcess){
      if (tokIdx >= total) break;

      const parent = textNode.parentNode;
      const parts = textNode.nodeValue.split(RE_SPLIT).filter(Boolean);
      const frag = document.createDocumentFragment();

      for (const part of parts){
        if (/^\s+$/.test(part)){
          frag.appendChild(document.createTextNode(part));
          continue;
        }
        if (tokIdx >= total){
          frag.appendChild(document.createTextNode(part));
          continue;
        }
        const sp = document.createElement('span');
        sp.className = 'tok';
        sp.dataset.i = String(tokIdx);
        if (PUNCT_RE.test(part)) sp.dataset.punc = '1';
        sp.textContent = part;
        frag.appendChild(sp);
        tokIdx++;
      }
      parent.replaceChild(frag, textNode);
    }

    if (tokIdx < total){
      const tail = document.createDocumentFragment();
      for (let i = tokIdx; i < total; i++){
        const t = tokens[i];
        const sp = document.createElement('span');
        sp.className='tok'; sp.dataset.i=String(i);
        const isPunc = (t === '\n') || PUNCT_RE.test(t);
        if (isPunc) sp.dataset.punc='1';
        sp.textContent = (i>0 && tokens[i-1] !== '\n' && !isPunc ? ' ' : '') + t + (t === '\n' ? '\n' : '');
        tail.appendChild(sp);
      }
      contentEl.appendChild(tail);
    }
  }

  function clearTemp(){ contentEl.querySelectorAll('.tok[data-temp="1"]').forEach(el=>el.removeAttribute('data-temp')); }
  function paintRange(start, end, color){
    const s=Math.min(start,end)|0, e=Math.max(start,end)|0;
    for (let i=s;i<=e;i++){
      const el = contentEl.querySelector(`.tok[data-i="${i}"]`);
      if (!el || el.dataset.punc==='1') continue;
      if (color) el.setAttribute('data-color', color);
      else el.removeAttribute('data-color');
    }
  }
  function clearLocal(){ contentEl.querySelectorAll('.tok').forEach(el=>{ el.removeAttribute('data-color'); el.removeAttribute('data-temp'); }); }

  function clampRange(a,b){
    let s=a, e=b;
    if (Math.abs(e - s) + 1 > MAX_RANGE){ e = s + (e > s ? (MAX_RANGE-1) : -(MAX_RANGE-1)); }
    const step = e>=s ? 1 : -1;
    let last = s;
    for (let i=s; step>0? i<=e : i>=e; i+=step){
      const el = contentEl.querySelector(`.tok[data-i="${i}"]`); if (!el) break;
      if (el.dataset.punc==='1'){ break; }
      last = i;
    }
    return [s, last];
  }

  contentEl.addEventListener('mousedown', (e)=>{
    if (locked) return;
    const t=e.target.closest('.tok'); if(!t || t.dataset.punc==='1' || !('i' in t.dataset)) return;
    anchor = +t.dataset.i;
    clearTemp(); t.setAttribute('data-temp','1');
    e.preventDefault();
  });
  contentEl.addEventListener('mousemove', (e)=>{
    if (locked || anchor==null) return;
    const t=e.target.closest('.tok'); if(!t) return;
    clearTemp();
    let j = ('i' in t.dataset) ? +t.dataset.i : anchor;
    const [s,e2] = clampRange(anchor, j);
    for (let k=Math.min(s,e2);k<=Math.max(s,e2);k++){
      const el = contentEl.querySelector(`.tok[data-i="${k}"]`);
      if (el && el.dataset.punc!=='1') el.setAttribute('data-temp','1');
    }
  });
  function finishDrag(ev){
    if (locked || anchor==null) return;
    const t = ev.target.closest('.tok'); let j = (t && 'i' in t.dataset) ? +t.dataset.i : anchor;
    const [s,e2] = clampRange(anchor, j);
    clearTemp();
    let allSame = true;
    for (let i=Math.min(s,e2); i<=Math.max(s,e2); i++){
      const el = contentEl.querySelector(`.tok[data-i="${i}"]`);
      if (!el || el.dataset.punc==='1') continue;
      if (el.getAttribute('data-color') !== currentColor){ allSame=false; break; }
    }
    const newColor = allSame ? '' : currentColor;
    paintRange(s, e2, newColor);
    sendHighlightRange(s, e2, newColor);
    anchor = null;
  }
  contentEl.addEventListener('mouseup', finishDrag);
  contentEl.addEventListener('mouseleave', finishDrag);

  if (resetBtn){
    resetBtn.addEventListener('click', async ()=>{
      try{
        status('Resetting...');;
        await fetch(`/api/reset?doc=${encodeURIComponent(docId)}&name=${encodeURIComponent(datName)}`);
        tokens = await fetchTokens();
        if (renderMode === 'html' || renderMode === 'markdown'){
          const raw = await fetchRaw();
          renderHtmlPreservingStructure(raw);
        } else {
          renderTextPlain();
        }
        if (overlayMode==='own'){ await paintOwnFromServer(); }
        status('Document reset.');
      }catch(err){
        console.error('Reset failed', err);
        status('Reset failed', 'error');
      }
    });
  }

  clearBtn.addEventListener('click', ()=>{ if (!locked){ clearLocal(); sendClearAll(); } });

  async function fetchMyRanges(){
    const r = await fetch(`/api/myranges?doc=${encodeURIComponent(docId)}&client=${encodeURIComponent(clientId)}`, {cache:'no-store'});
    if (!r.ok) return [];
    const data = await r.json();
    return data.ranges || [];
  }
  async function paintOwnFromServer(){
    const ranges = await fetchMyRanges();
    clearLocal();
    for (const r of ranges){ paintRange(r.start|0, r.end|0, r.color||''); }
  }

  // ====== send (throttle) ======
  let tmr=null, pending=null;
  function sendHighlightRange(s,e,color){
    pending = {s,e,color}; if (tmr) return;
    tmr = setTimeout(()=>{ tmr=null;
      const p=pending; pending=null; if(!p) return;
      ws && ws.readyState===1 && ws.send(JSON.stringify({
        type:'highlight', action:'set_range', docId, clientId, t:Date.now(),
        start: p.s, end: p.e, color: p.color
      }));
    }, 90);
  }
  function sendClearAll(){
    ws && ws.readyState===1 && ws.send(JSON.stringify({ type:'highlight', action:'clear_all', docId, clientId, t:Date.now() }));
  }

  // ====== WS ======
  function connectWS(){
    const proto = location.protocol==='https:'?'wss':'ws';
    const wsUrl = `${proto}://${location.hostname}:${location.port || (location.protocol==='https:'?443:80) }/?doc=${encodeURIComponent(docId)}&client=${encodeURIComponent(clientId)}`;
    ws = new WebSocket(wsUrl);
    ws.onopen = ()=>{ status('Connected'); };
    ws.onmessage = async (ev)=>{
        try{
        const m = JSON.parse(ev.data);
        if (m.type==='hello' && typeof m.locked==='boolean') setLocked(m.locked);
        if (m.type==='init'){
          if (overlayMode==='all' && Array.isArray(m.ranges)){
            clearLocal();
            for (const r of m.ranges){ paintRange(r.start|0, r.end|0, r.color||''); }
          } else if (overlayMode==='own'){
            await paintOwnFromServer();
          }
        }
        if (m.type==='control' && m.action==='lock') setLocked(true);
        if (m.type==='control' && m.action==='unlock') setLocked(false);
      }catch(_){}
    };
    ws.onclose = ()=>{ status('Reconnecting…'); setTimeout(connectWS, 900); };
  }

  // ====== boot ======
  (async ()=>{
    tokens = await fetchTokens();
    if (renderMode === 'html' || renderMode === 'markdown'){
      const raw = await fetchRaw();
      renderHtmlPreservingStructure(raw);
    } else {
      renderTextPlain();
    }
    connectWS();
    if (overlayMode==='own'){ await paintOwnFromServer(); }
  })();
})();


async function populateDocOptions(current){
  const select = document.getElementById('docSelect');
  if (!select) return;
  try{
    const res = await fetch('/api/docs', {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    const docs = Array.isArray(data.docs) ? data.docs : [];
    if (current && !docs.includes(current)) docs.push(current);
    docs.sort((a,b)=>a.localeCompare(b));
    select.innerHTML = '';
    docs.forEach((doc)=>{
      const opt = document.createElement('option');
      opt.value = doc;
      opt.textContent = doc;
      if (doc === current) opt.selected = true;
      select.appendChild(opt);
    });
  }catch(err){
    console.error('Failed to load docs list', err);
  }
}

async function populateSourceOptions(current){
  const select = document.getElementById('sourceSelect');
  if (!select) return;
  try{
    const res = await fetch('/api/sources', {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    const sources = Array.isArray(data.sources) ? data.sources : [];
    if (current && !sources.includes(current)) sources.push(current);
    sources.sort((a,b)=>a.localeCompare(b));
    select.innerHTML = '';
    sources.forEach((name)=>{
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === current) opt.selected = true;
      select.appendChild(opt);
    });
  }catch(err){
    console.error('Failed to load source list', err);
  }
}
