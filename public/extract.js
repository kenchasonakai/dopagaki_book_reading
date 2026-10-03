// PDFから本文と図を取り出す（ブラウザ内で完結）
//
// 戻り値: { title, author, pages, chars, figures, paras, images }
//   paras  … [{ text, heading }] または [{ img: 'fig-1.png', text: 'キャプション' }]
//   images … { 'fig-1.png': Blob }
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/';
const SCALE = 2; // 図の解像度（PDFの1pt = 2px）

let lib = null;
async function loadPdfjs() {
  if (lib) return lib;
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = PDFJS + 'build/pdf.min.js';
    s.onload = res;
    s.onerror = () => rej(new Error('PDF用のライブラリを読み込めませんでした。ネットワーク接続を確認してください。'));
    document.head.appendChild(s);
  });
  lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = PDFJS + 'build/pdf.worker.min.js';
  return lib;
}

/* ---------- 文字の正規化 ---------- */
// 康熙部首・CJK部首補助（⼈⼤など）を通常の漢字へ
const normalizeCJK = s => s.replace(/[⺀-⿟]/g, c => c.normalize('NFKC'));
const CJK = '　-ヿ㐀-鿿豈-﫿＀-￯';
const isCJK = c => new RegExp(`[${CJK}]`).test(c);
const tightenSpaces = t => t.replace(new RegExp(` (?=[${CJK}])`, 'g'), '').replace(new RegExp(`([${CJK}]) `, 'g'), '$1');

const CAPTION_RE = /^([▲▼△▽]?)\s*(図|表)\s*[\d０-９]+[.．‐-]?[\d０-９]*/;
const BULLET_RE = /^([•・●○◦▪■□]|[①-⑳]|[\d０-９]+[.．)）]\s|[a-zA-Z][.)]\s)/;

/* ---------- 1ページのテキストを行にまとめる ---------- */
function pageLines(tc) {
  const rows = [];
  for (const it of tc.items) {
    if (!it.str) continue;
    const y = it.transform[5];
    let r = rows.find(r => Math.abs(r.y - y) <= 2);
    if (!r) { r = { y, items: [] }; rows.push(r); }
    const x = it.transform[4];
    // 同じ文字を同じ位置に二重に描いているPDF（太字の擬似表現など）は1つにする
    if (r.items.some(o => o.str === it.str && Math.abs(o.x - x) <= 2)) continue;
    r.items.push({ str: it.str, x, h: it.height });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map(r => {
    r.items.sort((a, b) => a.x - b.x);
    const text = normalizeCJK(r.items.map(i => /^\s+$/.test(i.str) ? ' ' : i.str).join('')).replace(/\s+/g, ' ').trim();
    const vis = r.items.filter(i => i.str.trim());
    return { text, y: r.y, x: vis.length ? vis[0].x : r.items[0].x, h: Math.max(0, ...vis.map(i => i.h)) };
  }).filter(l => l.text);
}

/* ---------- 図の切り出し ---------- */
async function renderPage(page) {
  const vp = page.getViewport({ scale: SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return { canvas, vp };
}
async function cropFigure(rendered, band) {
  const { canvas, vp } = rendered;
  // PDF座標（下が0）→ 画像座標（上が0）
  const top = Math.max(0, Math.floor(vp.convertToViewportPoint(0, band.top)[1]));
  const bottom = Math.min(canvas.height, Math.ceil(vp.convertToViewportPoint(0, band.bottom)[1]));
  if (bottom - top < 20 * SCALE) return null;
  // 帯の中で白でない部分の範囲を求め、余白を切り落とす
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, top, canvas.width, bottom - top);
  const d = img.data, W = img.width, H = img.height;
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0 || x1 - x0 < 40 * SCALE || y1 - y0 < 20 * SCALE) return null;
  const pad = 6 * SCALE;
  x0 = Math.max(0, x0 - pad); x1 = Math.min(W - 1, x1 + pad); y0 = Math.max(0, y0 - pad); y1 = Math.min(H - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, top + y0, out.width, out.height, 0, 0, out.width, out.height);
  return new Promise(res => out.toBlob(res, 'image/png'));
}

/* ---------- 本体 ---------- */
export async function extractPdf(file, onProgress = () => {}) {
  onProgress('PDFを開いています…');
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data, cMapUrl: PDFJS + 'cmaps/', cMapPacked: true, isEvalSupported: false }).promise;
  let title = '', author = '';
  try { const m = await pdf.getMetadata(); title = (m.info.Title || '').trim(); author = (m.info.Author || '').trim(); } catch (e) {}

  // 全ページの行を集め、本文の行送り・文字高さ・左端を推定する
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    if (p % 10 === 1) onProgress(`文字を取り出しています… ${p} / ${pdf.numPages} ページ`);
    const page = await pdf.getPage(p);
    pages.push({ page, lines: pageLines(await page.getTextContent()) });
  }
  const gc = {}, hs = {}, xs = {};
  for (const { lines } of pages) {
    for (let i = 1; i < lines.length; i++) { const g = Math.round(lines[i - 1].y - lines[i].y); if (g > 0) gc[g] = (gc[g] || 0) + 1; }
    for (const l of lines) { hs[Math.round(l.h)] = (hs[Math.round(l.h)] || 0) + l.text.length; xs[Math.round(l.x)] = (xs[Math.round(l.x)] || 0) + 1; }
  }
  const mode = o => +(Object.entries(o).sort((a, b) => b[1] - a[1])[0] || [0])[0];
  const lineGap = mode(gc) || 12, bodyH = mode(hs) || 8, leftX = mode(xs) || 0;

  const paras = [], images = {};
  let cur = null, figN = 0;
  const flush = () => { if (cur && cur.text.trim()) paras.push({ text: tightenSpaces(cur.text), heading: cur.heading }); cur = null; };

  for (let pi = 0; pi < pages.length; pi++) {
    const { page, lines } = pages[pi];
    const [, pageBottom, , pageTop] = page.view;
    const L = lines;
    // 柱（ページ上部の見出し）とノンブル（ページ番号）
    const hasHeader = L.length > 1 && (L[0].y - L[1].y) > lineGap * 1.8 && L[0].h <= bodyH + 1.5;
    const hasFolio = L.length > 0 && /^[\d\s\-–—ivxlcIVXLC]+$/.test(L[L.length - 1].text);
    const first = hasHeader ? 1 : 0, last = L.length - (hasFolio ? 1 : 0);
    let rendered = null;

    for (let i = first; i < last; i++) {
      const l = L[i], prev = i > first ? L[i - 1] : null;
      const cap = l.text.length < 70 && l.text.match(CAPTION_RE);
      if (cap) {
        // ▲は図がキャプションの上、▼は下にある
        const above = cap[1] !== '▼' && cap[1] !== '▽';
        const up = L[i - 1], down = L[i + 1];
        const band = above
          ? { top: up ? up.y - up.h * 0.35 : pageTop, bottom: l.y + l.h * 1.15 }
          : { top: l.y - l.h * 0.35, bottom: down ? down.y + down.h * 1.15 : pageBottom };
        if (!rendered) { onProgress(`図を切り出しています… ${pi + 1} / ${pdf.numPages} ページ`); rendered = await renderPage(page); }
        const blob = await cropFigure(rendered, band);
        if (blob) {
          figN++;
          const name = `fig-${figN}.png`;
          images[name] = blob;
          flush();
          // 「図1.1ルート…」→「図1.1 ルート…」と番号の後ろに空白を入れる
          const caption = tightenSpaces(l.text.replace(/^[▲▼△▽]\s*/, '')).replace(/^(図|表)\s*([\d０-９.．‐-]+)[\s:：]*/, '$1$2 ');
          paras.push({ img: name, text: caption });
        }
        continue;
      }
      const heading = l.h > bodyH + 1.5;
      const indent = l.x > leftX + bodyH * 0.5;
      const bigGap = prev && (prev.y - l.y) > lineGap * 1.6;
      const prevEnd = cur && /[。！？」』）)]$/.test(cur.text);
      const bullet = BULLET_RE.test(l.text);
      let newPara;
      if (!cur) newPara = true;
      else if (heading) newPara = !cur.heading || bigGap;      // 複数行の見出しはつなげる
      else if (cur.heading || bullet || bigGap) newPara = true;
      else if (indent && prevEnd) newPara = true;
      else if (i === first) newPara = prevEnd;                   // ページをまたぐ段落はつなげる
      else newPara = false;
      if (newPara) { flush(); cur = { text: '', heading }; }
      let t = cur.text; const s = l.text;
      if (/[A-Za-z]-$/.test(t) && /^[a-z]/.test(s)) t = t.slice(0, -1);
      else if (t && !isCJK(t.slice(-1)) && !isCJK(s[0])) t += ' ';
      cur.text = t + s;
    }
    rendered = null; // ページのcanvasを解放
  }
  flush();
  for (const p of paras) if (p.heading) p.text = p.text.replace(/^(第?[\d.]+章?)(?=[^\s\d.])/, '$1 ');

  const chars = paras.filter(p => !p.img).reduce((n, p) => n + p.text.replace(/\s/g, '').length, 0);
  pdf.destroy();
  return { title: title || file.name.replace(/\.pdf$/i, ''), author, pages: pdf.numPages, chars, figures: figN, paras, images };
}
