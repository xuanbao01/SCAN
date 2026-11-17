// 题库：导入（.et/.xls/.xlsx/.csv）、索引、模糊匹配
/* global XLSX */
const Bank = (() => {
  const TYPE = { '00': '单选题', '01': '多选题', '02': '不定项', '03': '判断题', '04': '填空题' };
  const LETTERS = 'ABCDEFGHIJ';
  let Q = [], index = new Map();

  const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  function grams(s) {
    const t = norm(s), g = new Set();
    if (t.length === 1) g.add(t);
    for (let i = 0; i + 1 < t.length; i++) g.add(t.slice(i, i + 2));
    return g;
  }
  const cell = v => {
    if (v == null) return '';
    if (typeof v === 'number') return String(+v.toFixed(10));
    return String(v).trim();
  };

  // ---------- 导入 ----------
  function parseWorkbook(buf) {
    const wb = XLSX.read(buf, { type: 'array' });
    const out = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      const hi = rows.findIndex(r => r.some(c => String(c).includes('题干')));
      if (hi < 0) continue;
      const hdr = rows[hi].map(c => String(c));
      const col = k => hdr.findIndex(h => h.includes(k));
      const cType = col('类型编号'), cStem = col('题干'), cAns = col('答案'), cCnt = col('填空项个数');
      const cBlankType = col('填空题类型');
      const optCols = [];
      for (const L of LETTERS) { const i = hdr.findIndex(h => h.replace(/\s/g, '') === '选项' + L); if (i >= 0) optCols.push(i); }
      const sheetCode = (name.match(/0[0-4]/) || [])[0];
      for (let r = hi + 1; r < rows.length; r++) {
        const row = rows[r];
        const stem = cell(row[cStem]);
        if (!stem) continue;
        // 优先按分表名判断题型（原表中有个别行的类型编号填错）
        let code = sheetCode || (cType >= 0 ? cell(row[cType]).padStart(2, '0') : '00');
        if (!TYPE[code]) code = '00';
        if (code === '04' && cBlankType < 0) code = '03';
        const opts = optCols.map(i => cell(row[i]));
        while (opts.length && !opts[opts.length - 1]) opts.pop();
        const q = { t: code, s: stem, o: opts };
        if (code === '04') {
          const k = cCnt >= 0 ? (parseInt(cell(row[cCnt])) || opts.length) : opts.length;
          q.a = opts.slice(0, k).filter(Boolean).join(' / ');
          q.o = [];
        } else {
          q.a = cell(row[cAns]).toUpperCase().replace(/[^A-J]/g, '');
        }
        out.push(q);
      }
    }
    return out;
  }

  function load(list) {
    Q = list.map((q, i) => {
      const sg = grams(q.s), og = grams(q.o.join(''));
      const all = new Set([...sg, ...og]);
      return { ...q, id: i, sg, all, n: all.size };
    });
    index = new Map();
    for (const q of Q) for (const g of q.all) {
      let a = index.get(g); if (!a) index.set(g, a = []); a.push(q.id);
    }
    return Q.length;
  }

  // ---------- 匹配 ----------
  const UI_NOISE = /^(上一题|下一题|关闭|本题得分.*|\d+\/\d+|.*练习-?|.*考试-?|交卷|提交|答题卡|\d{1,2}:\d{2}.*)$/;
  const TYPE_RE = /(单选题|多选题|判断题|填空题|不定项)/;

  // lines: OCR 行 [{text, cy, h}]，返回 {best, alts, num, typeOnScreen, conf}
  function match(lines) {
    if (!Q.length) return null;
    let num = null, typeOnScreen = null;
    const useful = [];
    for (const l of lines) {
      const t = l.text.trim();
      const tm = t.match(TYPE_RE); if (tm && !typeOnScreen) typeOnScreen = tm[1];
      const nm = t.match(/^(\d{1,4})\s*[.．、,，]/);
      if (nm && num == null) num = +nm[1];
      if (UI_NOISE.test(norm(t)) || UI_NOISE.test(t.replace(/\s/g, ''))) continue;
      useful.push(l);
    }
    let text = useful.map(l => l.text).join('\n');
    text = text.replace(/^\s*\d{1,4}\s*[.．、,，]/m, '').replace(/(单选题|多选题|判断题|填空题|不定项)\s*\/?\s*[\d.]*\s*分?/g, '');
    const S = grams(text);
    if (S.size < 4) return { best: null, num, typeOnScreen };
    const cnt = new Map();
    for (const g of S) { const a = index.get(g); if (a) for (const id of a) cnt.set(id, (cnt.get(id) || 0) + 1); }
    const typeName = typeOnScreen;
    const scored = [];
    for (const [id, m] of cnt) {
      const q = Q[id];
      const recall = m / q.n;
      if (recall < 0.25) continue;
      let score = m - (q.n - m);
      if (typeName) {
        const qt = TYPE[q.t];
        if (qt !== typeName && !(typeName === '多选题' && q.t === '02')) score -= 0.3 * q.n + 5;
      }
      scored.push({ q, m, recall, score });
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 5);
    for (const c of top) {
      let sm = 0; for (const g of c.q.sg) if (S.has(g)) sm++;
      c.stemRecall = sm / Math.max(1, c.q.sg.size);
    }
    const best = top[0];
    if (!best) return { best: null, num, typeOnScreen };
    const second = top[1];
    const margin = second ? (best.score - second.score) / Math.max(1, best.q.n) : 1;
    let conf = 'low';
    if (best.stemRecall >= 0.75 && best.recall >= 0.65 && margin >= 0.12) conf = 'high';
    else if (best.stemRecall >= 0.55 && best.recall >= 0.45) conf = 'mid';
    return { best, alts: top.slice(1, 3), num, typeOnScreen, conf, margin, screen: mapOptions(best.q, useful) };
  }

  // 尝试找出正确选项在屏幕上的位置（应对选项乱序）
  function mapOptions(q, lines) {
    if (!q.o.length || q.t === '04') return null;
    const og = q.o.map(o => grams(o));
    const stemG = q.sg;
    // 每一行归到“最能包含这一行文字”的选项上（选项换行时多行归同一选项）
    const byOpt = new Map();
    lines.forEach(l => {
      const lt = l.text.trim();
      const lab = (lt.match(/^([A-Ja-j])\s*[.．、:：)]/) || [])[1];
      const lg = grams(lt.replace(/^([A-Ja-j])\s*[.．、:：)]/, ''));
      if (!lg.size) return;
      let sm = 0; for (const x of lg) if (stemG.has(x)) sm++;
      const stemP = sm / lg.size;
      let bi = -1, bp = 0, br = 0;
      og.forEach((g, i) => {
        if (!g.size) return;
        let m = 0; for (const x of lg) if (g.has(x)) m++;
        const p = m / lg.size, r = m / g.size;
        if (p > bp + 1e-9 || (Math.abs(p - bp) < 1e-9 && r > br)) { bp = p; br = r; bi = i; }
      });
      if (bi < 0 || bp < 0.6 || stemP > bp) return;
      const cur = byOpt.get(bi) || { i: bi, cy: Infinity, lab: null, cover: new Set() };
      if (l.cy < cur.cy) { cur.cy = l.cy; if (lab) cur.lab = lab.toUpperCase(); }
      for (const x of lg) if (og[bi].has(x)) cur.cover.add(x);
      byOpt.set(bi, cur);
    });
    if (byOpt.size < q.o.length) return null;
    // 每个选项都要被足够覆盖，否则认为定位不可靠
    for (const [i, f] of byOpt) if (f.cover.size / og[i].size < 0.5) return null;
    const ordered = [...byOpt.values()].sort((a, b) => a.cy - b.cy);
    const pos = new Map(ordered.map((f, k) => [f.i, f.lab || LETTERS[k]]));
    const ans = [...q.a].map(L => pos.get(LETTERS.indexOf(L))).filter(Boolean).sort().join('');
    const labelled = ordered.every(f => f.lab);
    return { ans, labelled, shuffled: ans !== q.a };
  }

  function answerText(q) {
    if (q.t === '04') return q.a;
    return [...q.a].map(L => q.o[LETTERS.indexOf(L)]).filter(x => x !== undefined).join('；');
  }

  // 手动搜索
  function search(str, k = 8) {
    const S = grams(str); if (!S.size) return [];
    const cnt = new Map();
    for (const g of S) { const a = index.get(g); if (a) for (const id of a) cnt.set(id, (cnt.get(id) || 0) + 1); }
    return [...cnt].map(([id, m]) => ({ q: Q[id], v: m / S.size + m / Q[id].n * 0.2 }))
      .sort((a, b) => b.v - a.v).slice(0, k);
  }

  return { parseWorkbook, load, match, search, answerText, TYPE, LETTERS, size: () => Q.length, norm };
})();
if (typeof module !== 'undefined') module.exports = Bank;
