/* global OCR, Bank */
(() => {
  const $ = id => document.getElementById(id);
  const video = $('video'), overlay = $('overlay'), statusEl = $('status');
  const big = $('big'), meta = $('meta'), optsEl = $('opts'), stemEl = $('stem'), altEl = $('altbox'), dbg = $('dbg');
  const params = new URLSearchParams(location.search);
  const TEST = params.get('test'); // 测试用：?test=a.png,b.png 用图片代替摄像头

  // ---------- 小工具 ----------
  const kv = {
    db: null,
    async open() {
      if (this.db) return this.db;
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('scanquiz', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      return this.db;
    },
    async get(k) { const db = await this.open(); return new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); },
  };
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 忽略 */ } },
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const setStatus = (t, warn) => { statusEl.textContent = t; statusEl.className = warn ? 'warn' : ''; };

  // ---------- 设置 ----------
  const opt = Object.assign({ limit: 960, sound: true, boxes: true, debug: false }, ls.get('opt', {}));
  $('optLimit').value = String(opt.limit); $('optSound').checked = opt.sound; $('optBoxes').checked = opt.boxes; $('optDebug').checked = opt.debug;
  const saveOpt = () => { ls.set('opt', opt); OCR.cfg.detLimit = +opt.limit; };
  $('optLimit').onchange = e => { opt.limit = +e.target.value; saveOpt(); };
  $('optSound').onchange = e => { opt.sound = e.target.checked; saveOpt(); };
  $('optBoxes').onchange = e => { opt.boxes = e.target.checked; saveOpt(); if (!opt.boxes) clearOverlay(); };
  $('optDebug').onchange = e => { opt.debug = e.target.checked; saveOpt(); dbg.textContent = ''; };

  // ---------- 声音 ----------
  let actx = null;
  function beep(ok) {
    if (!opt.sound || !actx) return;
    try {
      const o = actx.createOscillator(), g = actx.createGain();
      o.frequency.value = ok ? 1046 : 392; g.gain.value = 0.08;
      o.connect(g).connect(actx.destination); o.start(); o.stop(actx.currentTime + (ok ? 0.08 : 0.2));
    } catch { /* 忽略 */ }
  }

  // ---------- 屏幕常亮 ----------
  let wake = null;
  async function keepAwake() { try { if ('wakeLock' in navigator && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => { wake = null; }); } } catch { /* 忽略 */ } }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && running) keepAwake(); });

  // ---------- 题库 ----------
  async function loadBank() {
    try {
      const data = await kv.get('bank');
      if (data && data.list) { Bank.load(data.list); $('bankInfo').textContent = `${data.list.length} 题（${data.name}，${data.date} 导入）`; return true; }
    } catch (e) { console.error(e); }
    return false;
  }
  $('file').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    $('bankInfo').textContent = '正在读取…';
    try {
      const list = Bank.parseWorkbook(new Uint8Array(await f.arrayBuffer()));
      if (!list.length) throw new Error('没有找到题目，请确认是题库模板格式');
      Bank.load(list);
      const c = {}; list.forEach(q => { const n = Bank.TYPE[q.t]; c[n] = (c[n] || 0) + 1; });
      const date = new Date().toLocaleDateString('zh-CN');
      await kv.set('bank', { list, name: f.name, date });
      try { await navigator.storage?.persist?.(); } catch { /* 忽略 */ }
      $('bankInfo').textContent = `${list.length} 题（${Object.entries(c).map(([k, v]) => k + v).join('，')}）`;
      setStatus(`题库已导入：${list.length} 题`);
      if (!running) showIdle('题库已就绪，对准考试屏幕后点「开始」');
    } catch (err) {
      $('bankInfo').textContent = '导入失败：' + err.message;
    }
    e.target.value = '';
  };

  // ---------- 弹出页 ----------
  const sheets = { list: $('sList'), search: $('sSearch'), set: $('sSet') };
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('.sheet').classList.remove('show'));
  $('bList').onclick = () => { renderList(); sheets.list.classList.add('show'); };
  $('bSearch').onclick = () => { sheets.search.classList.add('show'); setTimeout(() => $('q').focus(), 50); };
  $('bSet').onclick = () => sheets.set.classList.add('show');

  // 手动搜索
  let st = 0;
  $('q').oninput = () => {
    clearTimeout(st);
    st = setTimeout(() => {
      const r = Bank.search($('q').value);
      $('results').innerHTML = r.map(({ q }) => `<div class="res"><div class="rs">[${Bank.TYPE[q.t]}] ${esc(q.s)}</div>
        ${q.o.length ? `<div style="color:#888;font-size:13px">${q.o.map((o, i) => Bank.LETTERS[i] + '. ' + esc(o)).join('　')}</div>` : ''}
        <div class="ra">答案：${esc(q.t === '04' ? q.a : q.a + '　' + Bank.answerText(q))}</div></div>`).join('') || '<p style="color:#888">没有找到</p>';
    }, 200);
  };

  // ---------- 答案清单 ----------
  let record = ls.get('record', {});
  function addRecord(res, disp) {
    const q = res.best.q;
    const key = res.num != null ? String(res.num) : 'q' + q.id;
    const old = record[key];
    const rank = { high: 3, mid: 2, low: 1 };
    if (old && old.id === q.id && rank[old.conf] >= rank[res.conf]) return;
    if (old && old.id !== q.id && rank[old.conf] > rank[res.conf]) return;
    record[key] = { num: res.num, id: q.id, a: disp, conf: res.conf, s: q.s.slice(0, 40) };
    ls.set('record', record);
  }
  function renderList() {
    const items = Object.values(record);
    const nums = items.filter(i => i.num != null).map(i => i.num);
    const max = nums.length ? Math.max(...nums) : 0;
    const rows = [];
    const missing = [];
    for (let n = 1; n <= max; n++) {
      const it = record[String(n)];
      if (it) rows.push(`<div class="row"><span class="num">${n}</span><span class="a ${it.conf}">${esc(it.a)}</span><span class="s">${esc(it.s)}</span></div>`);
      else missing.push(n);
    }
    const miss = missing.length;
    if (miss) rows.unshift(`<div style="color:#fc6;font-size:14px;padding:4px 0 10px">未扫到的题号：${missing.length > 60 ? missing.slice(0, 60).join('、') + ' …' : missing.join('、')}<br><span style="color:#888">翻回这些题停一下就会自动补上</span></div>`);
    items.filter(i => i.num == null).forEach(it => rows.push(`<div class="row"><span class="num">?</span><span class="a ${it.conf}">${esc(it.a)}</span><span class="s">${esc(it.s)}</span></div>`));
    $('list').innerHTML = rows.join('') || '<p style="color:#888">还没有记录。开始扫描后，每扫到一题就会按题号记在这里。</p>';
    $('listInfo').textContent = items.length ? `已记录 ${items.length} 题${miss ? `，缺 ${miss} 题` : ''}` : '';
  }
  $('bClear').onclick = () => { if (confirm('清空当前答案清单？（换一场考试前清空）')) { record = {}; ls.set('record', record); renderList(); } };
  $('bCopy').onclick = async () => {
    const t = Object.values(record).sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9)).map(i => `${i.num ?? '?'} ${i.a}`).join('\n');
    try { await navigator.clipboard.writeText(t); $('bCopy').textContent = '已复制'; setTimeout(() => $('bCopy').textContent = '复制', 1200); } catch { alert(t); }
  };

  // ---------- 显示 ----------
  function showIdle(t) { big.className = 'idle'; big.textContent = t; meta.innerHTML = ''; optsEl.innerHTML = ''; stemEl.textContent = ''; altEl.innerHTML = ''; }
  function displayAnswer(res) {
    const q = res.best.q;
    let disp, list = [];
    if (q.t === '03') { disp = Bank.answerText(q); }
    else if (q.t === '04') { disp = q.a; }
    else {
      disp = res.screen ? res.screen.ans : q.a;
      list = [...q.a].map(L => q.o[Bank.LETTERS.indexOf(L)]);
    }
    big.className = res.conf;
    big.style.fontSize = disp.length > 6 ? '34px' : '';
    big.textContent = disp;
    const confName = { high: '确定', mid: '较确定', low: '不确定，请核对' }[res.conf];
    meta.innerHTML = `${res.num != null ? `<b>第 ${res.num} 题</b> · ` : ''}${Bank.TYPE[q.t]}<span class="tag ${res.conf}">${confName}</span>` +
      (res.screen && res.screen.shuffled ? '<br><span style="color:#fc6">选项顺序与题库不同，已按屏幕顺序换算</span>' : '');
    optsEl.innerHTML = list.map(o => `<div>${esc(o)}</div>`).join('');
    stemEl.textContent = '题库原题：' + q.s;
    altEl.innerHTML = res.conf !== 'high' && res.alts && res.alts.length
      ? '<div style="color:#888">其他可能：</div>' + res.alts.map(a => `<div>${esc(a.q.s.slice(0, 50))} → <b>${esc(a.q.t === '04' ? a.q.a : a.q.a + ' ' + Bank.answerText(a.q))}</b></div>`).join('')
      : '';
    return disp;
  }

  // ---------- 画面 ----------
  const frame = document.createElement('canvas');
  const thumbC = document.createElement('canvas'); thumbC.width = 160; thumbC.height = 90;
  const thumbX = thumbC.getContext('2d', { willReadFrequently: true });
  let srcEl = video, srcW = 0, srcH = 0;

  function grabThumb() {
    thumbX.drawImage(srcEl, 0, 0, 160, 90);
    const d = thumbX.getImageData(0, 0, 160, 90).data, g = new Uint8Array(160 * 90);
    for (let i = 0; i < g.length; i++) g[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
    return g;
  }
  function diffFrac(a, b) {
    if (!a || !b) return 1;
    let c = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 28) c++;
    return c / a.length;
  }
  function clearOverlay() { const x = overlay.getContext('2d'); x.clearRect(0, 0, overlay.width, overlay.height); }
  function drawBoxes(boxes) {
    const r = overlay.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    overlay.width = r.width * dpr; overlay.height = r.height * dpr;
    const x = overlay.getContext('2d'); x.clearRect(0, 0, overlay.width, overlay.height);
    if (!opt.boxes || !srcW) return;
    const s = Math.min(overlay.width / srcW, overlay.height / srcH);
    const ox = (overlay.width - srcW * s) / 2, oy = (overlay.height - srcH * s) / 2;
    x.strokeStyle = '#3ddc84'; x.lineWidth = 1.5 * dpr;
    for (const b of boxes) {
      x.save(); x.translate(ox + b.cx * s, oy + b.cy * s); x.rotate(b.ang);
      x.strokeRect(-b.w * s / 2, -b.h * s / 2, b.w * s, b.h * s); x.restore();
    }
  }

  // ---------- 主循环 ----------
  let running = false, busy = false, lastThumb = null, lastOcrThumb = null, stableSince = 0;
  let lastOcrAt = 0, retries = 0, lastShownId = -1, lastRes = null;

  async function runOcr(thumb) {
    busy = true;
    lastOcrThumb = thumb; lastOcrAt = performance.now();
    try {
      frame.width = srcW; frame.height = srcH;
      frame.getContext('2d').drawImage(srcEl, 0, 0, srcW, srcH);
      const r = await OCR.run(frame, srcW, srcH);
      drawBoxes(r.boxes);
      const res = Bank.match(r.lines);
      const ms = Math.round(r.ms.det + r.ms.rec);
      if (opt.debug) dbg.textContent = `检测 ${Math.round(r.ms.det)}ms 识别 ${Math.round(r.ms.rec)}ms\n` + r.lines.map(l => l.text).join('\n');
      if (!res || !res.best) {
        setStatus(`未识别到题目（${ms}ms）`, true);
        if (!lastRes) showIdle('没看到题目，调整角度让题目完整出现在画面里');
        lastRes = res; return;
      }
      setStatus(`识别 ${ms}ms`);
      // 同一屏幕上若结果更差则不覆盖
      const rank = { high: 3, mid: 2, low: 1 };
      if (lastRes && lastRes.best && lastRes.best.q.id === res.best.q.id && rank[lastRes.conf] > rank[res.conf] && retries > 0) return;
      const disp = displayAnswer(res);
      if (res.best.q.id !== lastShownId) { beep(res.conf !== 'low'); lastShownId = res.best.q.id; }
      if (res.conf !== 'low') addRecord(res, disp);
      lastRes = res;
    } catch (e) {
      console.error(e); setStatus('识别出错：' + e.message, true);
    } finally { busy = false; }
  }

  function tick() {
    if (!running) return;
    try {
      if (srcEl === video) { srcW = video.videoWidth; srcH = video.videoHeight; }
      if (srcW && !busy) {
        const now = performance.now();
        const th = grabThumb();
        if (diffFrac(th, lastThumb) > 0.015) stableSince = now;
        lastThumb = th;
        const stable = now - stableSince > 200;
        const changed = diffFrac(th, lastOcrThumb) > 0.008;
        if (stable && changed) { retries = 0; runOcr(th); }
        else if (stable && lastRes && (!lastRes.best || lastRes.conf !== 'high') && now - lastOcrAt > 1200 && retries < 3) { retries++; runOcr(th); }
      }
    } catch (e) { console.error(e); }
    setTimeout(tick, 100);
  }

  async function startCamera() {
    if (TEST) {
      const urls = TEST.split(','); let k = 0;
      const img = new Image(); srcEl = img;
      const load = async () => { img.src = urls[k % urls.length]; await img.decode(); srcW = img.naturalWidth; srcH = img.naturalHeight; video.poster = img.src; k++; };
      await load(); if (urls.length > 1) setInterval(load, +(params.get('interval') || 3000));
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    video.srcObject = stream; await video.play();
    const track = stream.getVideoTracks()[0];
    try { const caps = track.getCapabilities?.(); if (caps && caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* 忽略 */ }
  }

  $('bStart').onclick = async () => {
    if (running) {
      running = false; $('bStart').textContent = '开始'; $('bStart').classList.remove('on'); setStatus('已暂停');
      try { video.srcObject?.getTracks().forEach(t => t.stop()); video.srcObject = null; } catch { /* 忽略 */ }
      if (wake) { wake.release(); wake = null; }
      return;
    }
    if (!Bank.size()) { sheets.set.classList.add('show'); return; }
    if (!ready) { setStatus('模型还在加载，请稍等…', true); return; }
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch { /* 忽略 */ }
    try {
      await startCamera();
    } catch (e) {
      setStatus('无法打开摄像头：' + e.message, true);
      showIdle('请在弹窗中允许使用相机；若已拒绝，到 设置 → Safari → 相机 中改为“询问”或“允许”');
      return;
    }
    running = true; $('bStart').textContent = '暂停'; $('bStart').classList.add('on');
    lastOcrThumb = null; lastRes = null; lastShownId = -1;
    keepAwake(); showIdle('正在识别…'); tick();
  };

  // ---------- 启动 ----------
  let ready = false;
  async function boot() {
    if ('serviceWorker' in navigator && !TEST && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      try {
        await navigator.serviceWorker.register('sw.js');
        const reloadOnce = () => {
          if (!window.crossOriginIsolated && !sessionStorage.getItem('coiReload') && !running) {
            sessionStorage.setItem('coiReload', '1'); location.reload(); return true;
          }
          return false;
        };
        if (navigator.serviceWorker.controller) { if (reloadOnce()) return; }
        else navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
      } catch (e) { console.warn('SW 注册失败', e); }
    }
    const hasBank = await loadBank();
    showIdle(hasBank ? '对准考试屏幕后点「开始」' : '第一次使用：点「设置」导入题库文件');
    setStatus('正在加载识别模型（首次约 30MB）…');
    const cores = navigator.hardwareConcurrency || 2;
    let threads = window.crossOriginIsolated ? Math.min(4, cores) : 1;
    OCR.cfg.detLimit = +opt.limit;
    try {
      await OCR.init({ threads });
    } catch (e) {
      if (threads > 1) { threads = 1; await OCR.init({ threads: 1 }); } else { setStatus('模型加载失败：' + e.message, true); return; }
    }
    ready = true;
    $('envInfo').textContent = `识别线程：${threads}　离线可用：${'serviceWorker' in navigator ? '是' : '否'}`;
    setStatus(hasBank ? `就绪 · 题库 ${Bank.size()} 题` : '就绪 · 请先导入题库', !hasBank);
    if (TEST && hasBank) $('bStart').click();
    if (TEST && params.get('bank')) {
      const buf = await fetch(params.get('bank')).then(r => r.arrayBuffer());
      Bank.load(Bank.parseWorkbook(new Uint8Array(buf))); $('bStart').click();
    }
  }
  window.__app = { get record() { return record; }, get lastRes() { return lastRes; } };
  boot();
})();
