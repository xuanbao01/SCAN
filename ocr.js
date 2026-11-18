// 轻量 PaddleOCR (PP-OCRv4) 浏览器推理：检测(DB) + 识别(CTC)，不依赖 OpenCV
/* global ort */
const OCR = (() => {
  let detSess = null, recSess = null, keys = null;
  const cfg = { detLimit: 960, boxThresh: 0.55, binThresh: 0.3, unclip: 1.6, recBatch: 6 };

  async function init(opts = {}) {
    Object.assign(cfg, opts.cfg || {});
    ort.env.wasm.wasmPaths = new URL(opts.wasmPath || 'vendor/', location.href).href;
    const threads = opts.threads || 1;
    ort.env.wasm.numThreads = threads;
    const so = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
    const [d, r, k] = await Promise.all([
      fetch(opts.det || 'models/det.onnx').then(x => x.arrayBuffer()),
      fetch(opts.rec || 'models/rec.onnx').then(x => x.arrayBuffer()),
      fetch(opts.keys || 'models/keys.txt').then(x => x.text()),
    ]);
    keys = k.replace(/\r/g, '').split('\n');
    if (keys[keys.length - 1] === '') keys.pop();
    detSess = await ort.InferenceSession.create(new Uint8Array(d), so);
    recSess = await ort.InferenceSession.create(new Uint8Array(r), so);
  }

  // ---------- 检测 ----------
  async function detect(src, W, H) {
    const scale = Math.min(1, cfg.detLimit / Math.max(W, H));
    const rw = Math.max(32, Math.round(W * scale / 32) * 32);
    const rh = Math.max(32, Math.round(H * scale / 32) * 32);
    const c = document.createElement('canvas'); c.width = rw; c.height = rh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, W, H, 0, 0, rw, rh);
    const px = ctx.getImageData(0, 0, rw, rh).data;
    const n = rw * rh, inp = new Float32Array(3 * n);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let i = 0; i < n; i++) {
      const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
      inp[i] = (b / 255 - mean[0]) / std[0];
      inp[n + i] = (g / 255 - mean[1]) / std[1];
      inp[2 * n + i] = (r / 255 - mean[2]) / std[2];
    }
    const out = await detSess.run({ [detSess.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, rh, rw]) });
    const prob = out[detSess.outputNames[0]].data;
    const sx = W / rw, sy = H / rh;
    return components(prob, rw, rh).map(b => ({
      cx: b.cx * sx, cy: b.cy * sy, w: b.w * sx, h: b.h * sy, ang: b.ang, score: b.score,
    }));
  }

  function components(prob, w, h) {
    const n = w * h, lab = new Int32Array(n), stack = new Int32Array(n);
    const boxes = [];
    let id = 0;
    for (let s = 0; s < n; s++) {
      if (lab[s] || prob[s] <= cfg.binThresh) continue;
      id++;
      let sp = 0; stack[sp++] = s; lab[s] = id;
      const pix = [];
      while (sp) {
        const p = stack[--sp]; pix.push(p);
        const x = p % w, y = (p - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (!lab[q] && prob[q] > cfg.binThresh) { lab[q] = id; stack[sp++] = q; }
          }
        }
      }
      if (pix.length < 12) continue;
      let mx = 0, my = 0, sc = 0;
      for (const p of pix) { const x = p % w; mx += x; my += (p - x) / w; sc += prob[p]; }
      mx /= pix.length; my /= pix.length; sc /= pix.length;
      if (sc < cfg.boxThresh) continue;
      let cxx = 0, cyy = 0, cxy = 0;
      for (const p of pix) { const x = p % w - mx, y = (p - (p % w)) / w - my; cxx += x * x; cyy += y * y; cxy += x * y; }
      let ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      if (ang > Math.PI / 4) ang -= Math.PI / 2;
      if (ang < -Math.PI / 4) ang += Math.PI / 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
      for (const p of pix) {
        const x = p % w - mx, y = (p - (p % w)) / w - my;
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      const bw = u1 - u0 + 1, bh = v1 - v0 + 1;
      if (Math.min(bw, bh) < 3) continue;
      const d = bw * bh * cfg.unclip / (2 * (bw + bh));
      const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
      boxes.push({
        cx: mx + uc * ca - vc * sa, cy: my + uc * sa + vc * ca,
        w: bw + 2 * d, h: bh + 2 * d, ang, score: sc,
      });
    }
    return boxes;
  }

  // ---------- 识别 ----------
  function cropLine(src, b) {
    const H = 48;
    const scale = H / b.h;
    const tw = Math.max(16, Math.min(3200, Math.ceil(b.w * scale)));
    const c = document.createElement('canvas'); c.width = tw; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tw, H);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.translate(b.w / 2, b.h / 2);
    ctx.rotate(-b.ang);
    ctx.translate(-b.cx, -b.cy);
    ctx.drawImage(src, 0, 0);
    return c;
  }

  async function recognize(crops) {
    const order = crops.map((c, i) => i).sort((a, b) => crops[a].width - crops[b].width);
    const res = new Array(crops.length);
    for (let s = 0; s < order.length; s += cfg.recBatch) {
      const ids = order.slice(s, s + cfg.recBatch);
      const maxW = Math.max(...ids.map(i => crops[i].width));
      const N = ids.length, plane = 48 * maxW;
      const inp = new Float32Array(N * 3 * plane); // 0 = 补齐
      ids.forEach((ci, k) => {
        const c = crops[ci], cw = c.width;
        const px = c.getContext('2d').getImageData(0, 0, cw, 48).data;
        const base = k * 3 * plane;
        for (let y = 0; y < 48; y++) for (let x = 0; x < cw; x++) {
          const p = (y * cw + x) * 4, o = y * maxW + x;
          inp[base + o] = px[p + 2] / 127.5 - 1;
          inp[base + plane + o] = px[p + 1] / 127.5 - 1;
          inp[base + 2 * plane + o] = px[p] / 127.5 - 1;
        }
      });
      const out = await recSess.run({ [recSess.inputNames[0]]: new ort.Tensor('float32', inp, [N, 3, 48, maxW]) });
      const t = out[recSess.outputNames[0]];
      const [, T, C] = t.dims, data = t.data;
      ids.forEach((ci, k) => {
        let prev = 0, txt = '', cs = 0, cn = 0;
        for (let i = 0; i < T; i++) {
          const off = (k * T + i) * C;
          let bi = 0, bv = -1;
          for (let j = 0; j < C; j++) if (data[off + j] > bv) { bv = data[off + j]; bi = j; }
          if (bi !== 0 && bi !== prev) {
            txt += bi - 1 < keys.length ? keys[bi - 1] : ' ';
            cs += bv; cn++;
          }
          prev = bi;
        }
        res[ci] = { text: txt, conf: cn ? cs / cn : 0 };
      });
    }
    return res;
  }

  // 主入口：src 为 canvas/image/video，返回按阅读顺序排列的文本行
  async function run(src, W, H, opts = {}) {
    const t0 = performance.now();
    let boxes = await detect(src, W, H);
    const vertical = boxes.filter(b => b.h > 2 * b.w && b.h > 24).length;
    const horizontal = boxes.filter(b => b.w > 2 * b.h && b.w > 24).length;
    if (opts.probe) return { vertical, horizontal };
    boxes = boxes.filter(b => b.h > 6 && b.w > b.h * 0.6);
    const t1 = performance.now();
    const crops = boxes.map(b => cropLine(src, b));
    const rec = crops.length ? await recognize(crops) : [];
    const lines = boxes.map((b, i) => ({ ...b, text: rec[i].text, conf: rec[i].conf }))
      .filter(l => l.text.trim() && l.conf > 0.4);
    lines.sort((a, b) => a.cy - b.cy);
    // 按行分组，同一行内从左到右
    const rows = [];
    for (const l of lines) {
      const r = rows.find(r => Math.abs(r.cy - l.cy) < Math.min(r.h, l.h) * 0.5);
      if (r) { r.items.push(l); r.cy = (r.cy + l.cy) / 2; } else rows.push({ cy: l.cy, h: l.h, items: [l] });
    }
    const out = rows.map(r => {
      r.items.sort((a, b) => a.cx - b.cx);
      return { text: r.items.map(i => i.text).join(' '), cy: r.cy, h: r.h, x0: Math.min(...r.items.map(i => i.cx - i.w / 2)), conf: r.items.reduce((s, i) => s + i.conf, 0) / r.items.length };
    });
    return { lines: out, boxes: lines, vertical, horizontal, ms: { det: t1 - t0, rec: performance.now() - t1 } };
  }

  return { init, run, cfg };
})();
