(async function(){
  const usp = new URLSearchParams(location.search);
  const theme = (usp.get('theme')||'light').toLowerCase();
  document.body.setAttribute('data-theme', theme==='dark' ? 'dark' : '');

let docId = usp.get('doc') || 'doc1';
const stage = document.getElementById('stage');
const docSelect = document.getElementById('docSelect');
let activeColors = 'all', minFreq = 1, preferLongest = true;
const debugMode = usp.get('debug') !== '0';

  if (window.ControlChannel) {
    window.ControlChannel.init({ group: 'cloud' });
  }

  if (docSelect) {
    await populateDocOptions(docId);
    docSelect.addEventListener('change', (ev)=>{
      const next = ev.target.value;
      if (!next || next === docId) return;
      usp.set('doc', next);
      location.href = `${location.pathname}?${usp.toString()}`;
    });
    if (!debugMode) {
      docSelect.disabled = true;
    }
  }

  async function getPhrases(){
    const r = await fetch(`/api/phrases?doc=${encodeURIComponent(docId)}`, {cache:'no-store'});
    if (!r.ok) return [];
    const data = await r.json();
    // сервер присылает {text,color,clients[],count}
    return (data.phrases||[]).map(p=>({
      text: (p.text||'').trim(),
      color: p.color||'',
      clients: Array.isArray(p.clients)? p.clients : [],
    }));
  }

  function aggregate(raw){
    const base = raw.filter(p => activeColors==='all' || p.color===activeColors);

    // собрать по text/color и объединить множества клиентов
    const byTC = new Map();
    for (const it of base){
      const key = JSON.stringify([it.text.toLowerCase(), it.color]);
      const cur = byTC.get(key) || {text:it.text, color:it.color, clients:new Set()};
      it.clients.forEach(c=>cur.clients.add(c));
      byTC.set(key, cur);
    }
    let items = Array.from(byTC.values());

    // longest-wins: подавляем подстроки, объединяя множества
    if (preferLongest){
      items.sort((a,b)=> b.text.length - a.text.length);
      const sup = new Set();
      for (let i=0;i<items.length;i++){
        if (sup.has(i)) continue;
        const A = items[i]; const Akey = ' ' + A.text.toLowerCase() + ' ';
        for (let j=i+1;j<items.length;j++){
          if (sup.has(j)) continue;
          const B = items[j]; if (B.color!==A.color) continue;
          const needle = ' ' + B.text.toLowerCase() + ' ';
          if (Akey.includes(needle)){
            B.clients.forEach(c=>A.clients.add(c)); // union
            sup.add(j);
          }
        }
      }
      items = items.filter((_,idx)=>!sup.has(idx));
    }

    return items
      .map(x=>({text:x.text, color:x.color, count:x.clients.size}))
      .filter(x=>x.count>=minFreq)
      .sort((a,b)=>b.count-a.count);
  }

  // layout (спираль)
  const tags = new Map();
  function measure(text, count, data){
    const maxC = data.length? data[0].count : 1;
    const minC = data.length? data[data.length-1].count : 1;
    const scale = c => 14 + 28 * ((c - minC) / Math.max(1, (maxC - minC)));
    const fs = Math.round(Math.max(12, scale(count)));
    const el = document.createElement('div');
    el.className='tag'; el.style.fontSize=fs+'px'; el.textContent=`${text} (${count})`;
    stage.appendChild(el); const r = el.getBoundingClientRect(); stage.removeChild(el);
    return {w:r.width, h:r.height, fs};
  }

  function place(data){
    const W = stage.clientWidth, H = stage.clientHeight;
    const cx=W/2, cy=H/2;
    const boxes=[]; const placed=[];
    const collide=(a,b)=> !(a.x+a.w<b.x || b.x+b.w<a.x || a.y+a.h<b.y || b.y+b.h<a.y);
    const keyOf = d=>JSON.stringify([d.text.toLowerCase(), d.color||'']);

    for (const d of data){
      const k = keyOf(d);
      let el = tags.get(k);
      if (!el){ el=document.createElement('div'); el.className='tag'; el.dataset.c=d.color||''; el.style.opacity='0'; tags.set(k, el); stage.appendChild(el); }
      const m = measure(d.text, d.count, data);
      el.style.fontSize = m.fs+'px'; el.textContent = `${d.text} (${d.count})`; el.setAttribute('data-c', d.color||''); d._w=m.w; d._h=m.h;
    }
    for (const [k,el] of Array.from(tags.entries())){
      if (!data.find(d=>keyOf(d)===k)){ el.style.opacity='0'; setTimeout(()=>el.remove(),220); tags.delete(k); }
    }

    for (const d of data){
      const w=d._w, h=d._h;
      const a=4, b=8; let t=0, ok=false, px=cx, py=cy, tries=0;
      while(!ok && tries<500){
        const r=a+b*t; px=cx+r*Math.cos(t); py=cy+r*Math.sin(t);
        const box={x:px-w/2, y:py-h/2, w, h};
        ok = box.x>=0 && box.y>=0 && box.x+w<=W && box.y+h<=H;
        if (ok) for (const q of boxes){ if (collide(box,q)){ ok=false; } }
        t+=0.25; tries++;
      }
      const box = ok ? {x:px-w/2, y:py-h/2, w,h}
                     : {x: Math.max(0,cx-w/2), y: Math.max(0, cy-h/2), w,h};
      boxes.push(box); placed.push({box,d});
    }
    for (const {box,d} of placed){
      const k = keyOf(d); const el = tags.get(k); if (!el) continue;
      const x=Math.round(box.x+box.w/2), y=Math.round(box.y+box.h/2);
      el.style.transform = `translate(${x}px, ${y}px)`; el.style.opacity='1';
    }
  }

  async function redraw(){
    const phrases = await getPhrases();
    const data = aggregate(phrases);
    place(data);
  }

  document.querySelectorAll('.btn[data-colors]').forEach(b=>{
    b.addEventListener('click', ()=>{
      document.querySelectorAll('.btn[data-colors]').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      activeColors = b.getAttribute('data-colors');
      redraw();
    });
  });
  document.querySelector('.btn[data-colors="all"]').classList.add('active');
  document.getElementById('minFreq').addEventListener('input', (e)=>{ minFreq=Math.max(1,+e.target.value||1); redraw(); });
  document.getElementById('preferLongest').addEventListener('change', (e)=>{ preferLongest = !!e.target.checked; redraw(); });

  document.getElementById('finishBtn').addEventListener('click', async ()=>{ await fetch(`/api/control?action=lock&doc=${encodeURIComponent(docId)}`); });
  document.getElementById('unlockBtn').addEventListener('click', async ()=>{ await fetch(`/api/control?action=unlock&doc=${encodeURIComponent(docId)}`); });
  document.getElementById('clearVotes').addEventListener('click', async ()=>{ await fetch(`/api/clear?doc=${encodeURIComponent(docId)}`); await redraw(); });
  document.getElementById('resetDoc').addEventListener('click', async ()=>{ await fetch(`/api/reset?doc=${encodeURIComponent(docId)}`); await redraw(); });

  function connectWS(){
    const proto=location.protocol==='https:'?'wss':'ws';
    const wsUrl=`${proto}://${location.hostname}:${location.port||(location.protocol==='https:'?443:80)}/?doc=${encodeURIComponent(docId)}&client=cloud`;
    const ws=new WebSocket(wsUrl);
    ws.onmessage=(ev)=>{
      try{
        const m=JSON.parse(ev.data);
        if (m.type==='state_updated') redraw();
        if (m.type==='control' && m.action==='lock') document.title='Word Cloud (Finished)';
        if (m.type==='control' && m.action==='unlock') document.title='Word Cloud';
      }catch(_){}
    };
    ws.onclose=()=>setTimeout(connectWS, 1000);
  }

  window.addEventListener('resize', ()=>redraw());
  await redraw();
  connectWS();
})();

async function populateDocOptions(current){
  const select = document.getElementById('docSelect');
  if (!select) return;
  try{
    const res = await fetch('/api/docs', {cache:'no-store'});
    if (!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    const docs = Array.isArray(data.docs) ? data.docs : [];
    select.innerHTML = '';
    const all = new Set(docs);
    if (current && !all.has(current)) {
      docs.push(current);
    }
    docs.sort((a,b)=>a.localeCompare(b));
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
