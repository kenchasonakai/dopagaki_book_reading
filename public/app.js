import { extractPdf } from './extract.js';

/* ================= 固定値 ================= */
const CPM_DEFAULT = 1200; // 字/分（↑↓キーで100ずつ変えられる）
const FIG_SEC = 8;        // 図を表示する秒数
const MAX_CHARS = 14, MIN_CHARS = 3; // 1文節の長さの目安

const $ = s => document.querySelector(s);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
let cpm = store.get('rsvp.cpm', CPM_DEFAULT);

/* ================= サーバー（R2）とのやりとり ================= */
async function req(method, path, body, type) {
  const r = await fetch('/api' + path, { method, body, headers: type ? { 'content-type': type } : undefined });
  if (!r.ok) throw new Error(`サーバーとの通信に失敗しました（${r.status} ${method} ${path}）`);
  return r.headers.get('content-type')?.includes('json') ? r.json() : r;
}
const api = {
  list: () => req('GET', '/books'),
  get: id => req('GET', `/books/${id}`),
  putPdf: (id, file) => req('PUT', `/books/${id}/pdf`, file, 'application/pdf'),
  putImage: (id, name, blob) => req('PUT', `/books/${id}/img/${name}`, blob, name.endsWith('.jpg') ? 'image/jpeg' : 'image/png'),
  putJson: (id, name, obj) => req('PUT', `/books/${id}/${name}`, JSON.stringify(obj), 'application/json'),
  del: id => req('DELETE', `/books/${id}`),
  imgUrl: (id, name) => `/api/books/${id}/img/${name}`,
};

/* ================= 文節化 ================= */
const SEG = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
const FALLBACK_RE = /[一-鿿々〆ヵヶ]+|[゠-ヿー]+|[぀-ゟ]+|[A-Za-z0-9０-９Ａ-Ｚａ-ｚ]+|\s+|./gu;
const RE_OPEN = /^[「『（(【［\[〈《“‘〔｛{]+$/u;
const RE_CLOSE = /^[」』）)】］\]〉》”’〕｝}]+$/u;
const RE_PUNCT = /^[\p{P}\p{S}]+$/u;
const RE_HIRA = /^[぀-ゟー〜]+$/;
const RE_SENT = /[。！？!?．…]$/;
const RE_NONVIS = /[\s\p{P}\p{S}]/u;
const visLen = s => { let n = 0; for (const ch of s) if (!RE_NONVIS.test(ch)) n++; return n; };
function ttype(t) {
  if (/^\s+$/.test(t)) return 'sp';
  if (RE_OPEN.test(t)) return 'open';
  if (RE_CLOSE.test(t)) return 'close';
  if (RE_PUNCT.test(t)) return 'punct';
  if (RE_HIRA.test(t)) return 'hira';
  return 'content';
}
function tokenize(text) {
  const out = [];
  if (SEG) for (const s of SEG.segment(text)) { if (s.isWordLike) out.push(s.segment); else for (const ch of s.segment) out.push(ch); }
  else out.push(...(text.match(FALLBACK_RE) || []));
  return out.map(t => ({ t, k: ttype(t) }));
}
// 「漢字・カタカナ・英数（自立語）＋ひらがな（付属語）」を1文節としてまとめる
function splitUnits(text) {
  const u = []; let cur = '', curLen = 0, last = null, pre = '', force = false;
  const push = () => { if (cur) u.push(cur); cur = ''; curLen = 0; last = null; };
  for (const { t, k } of tokenize(text)) {
    if (k === 'open') { push(); pre += t; continue; }
    if (k === 'close' || k === 'punct') {
      if (cur) cur += t; else if (pre) pre += t; else if (u.length) u[u.length - 1] += t; else cur = t;
      if (k === 'punct') force = true; else last = 'close';
      continue;
    }
    if (k === 'sp') { if (cur) cur += t; else if (u.length) u[u.length - 1] += t; else pre += t; continue; }
    const len = [...t].length;
    if (k === 'hira') {
      if (cur && !force && curLen + len <= MAX_CHARS * 1.6) { cur += t; curLen += len; }
      else { push(); cur = pre + t; pre = ''; curLen = len; }
      last = 'hira';
    } else {
      if (cur && !force && last === 'content' && curLen + len <= MAX_CHARS) { cur += t; curLen += len; }
      else { push(); cur = pre + t; pre = ''; curLen = len; }
      last = 'content';
    }
    force = false;
  }
  if (pre) cur += pre;
  push();
  // 短すぎる文節は次とつなげる
  const out = [];
  for (const x of u) {
    const p = out[out.length - 1];
    if (p !== undefined && visLen(p) < MIN_CHARS && !RE_SENT.test(p.trim()) && visLen(p) + visLen(x) <= MAX_CHARS * 1.5) out[out.length - 1] = p + x;
    else out.push(x);
  }
  return out;
}

/* ================= 文書モデル ================= */
const doc = { id: '', title: '' };
let paras = [], chunks = [], paraStart = [], chapters = [], weights = [], suffix = [];
let totalLen = 0, idx = 0, playing = false, timer = null;

function build() {
  chunks = []; paraStart = []; chapters = [];
  let gpos = 0;
  paras.forEach((p, pi) => {
    paraStart[pi] = chunks.length;
    if (p.img) { chunks.push({ img: p.img, t: p.text, pi, len: 0, pos: gpos, paraEnd: true }); return; }
    if (p.heading) chapters.push({ title: p.text, at: chunks.length });
    const units = splitUnits(p.text);
    units.forEach((t, ui) => {
      const tt = t.trim();
      chunks.push({
        t, pi, len: visLen(t), pos: gpos, heading: p.heading,
        sentEnd: RE_SENT.test(tt.replace(/[」』）)]+$/, '')), comma: /[、，,]$/.test(tt), paraEnd: ui === units.length - 1,
      });
      gpos += visLen(t);
    });
  });
  totalLen = gpos;
  computeWeights();
  $('#seek').max = Math.max(0, chunks.length - 1);
}
// 重み＝「何文字ぶんの時間をかけるか」。図は秒指定なので速度から換算する
function weightOf(c) {
  if (c.img) return FIG_SEC * cpm / 60;
  let w = Math.max(c.len, 1);
  if (c.paraEnd) w += 4; else if (c.sentEnd) w += 2.5; else if (c.comma) w += 1;
  if (c.heading) w += 4;
  return Math.max(w, 1.5);
}
function computeWeights() {
  weights = chunks.map(weightOf);
  suffix = new Array(chunks.length + 1); suffix[chunks.length] = 0;
  for (let i = chunks.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + weights[i];
}
function findByPos(pos) {
  let lo = 0, hi = chunks.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (chunks[mid].pos <= pos) lo = mid; else hi = mid - 1; }
  return Math.max(0, lo);
}

/* ================= 表示 ================= */
const stage = $('#stage'), wordEl = $('#word');
function chunkHTML(c) {
  // 1文字ずつ span にして、配置後に中央へ来た文字を注視点として色づける
  return [...c.t.trim()].map(ch => `<span>${esc(ch)}</span>`).join('');
}
// 語全体を画面中央に置き、中央の線の上に来た文字を注視点にする。収まらなければ縮める
function place() {
  // 基本の文字サイズは CSS の --fs（画面幅で変わる）。長い文節は CSS 側で折り返し、それでも入らなければ縮める
  let fs = parseFloat(getComputedStyle(stage).getPropertyValue('--fs')) || 64;
  wordEl.style.fontSize = fs + 'px';
  const limit = stage.clientWidth - 32;
  if (wordEl.scrollWidth > limit + 1) { fs = Math.max(14, Math.floor(fs * limit / wordEl.scrollWidth)); wordEl.style.fontSize = fs + 'px'; }
  wordEl.style.transform = 'translate(-50%, -50%)';
  // レールは語の下へ（2行以上になったときは下がる）
  stage.style.setProperty('--rail', `${Math.round(wordEl.offsetHeight / 2 + fs * 0.18)}px`);
  // 1行目の中で、横方向の中央に最も近い文字を注視点にする
  const mid = wordEl.offsetWidth / 2;
  let best = null, bestD = Infinity, firstTop = null;
  for (const el of wordEl.children) {
    el.classList.remove('pv');
    if (RE_NONVIS.test(el.textContent)) continue;
    if (firstTop === null) firstTop = el.offsetTop;
    if (el.offsetTop > firstTop + fs * 0.5) continue;
    const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
    if (d < bestD) { bestD = d; best = el; }
  }
  if (best) best.classList.add('pv');
}
function show() {
  const c = chunks[idx];
  $('#done').hidden = true;
  if (!c) { wordEl.textContent = ''; updateStats(); return; }
  stage.classList.toggle('fig', !!c.img);
  $('#figure').hidden = !c.img;
  if (c.img) { $('#figImg').src = api.imgUrl(doc.id, c.img); $('#figImg').alt = c.t; $('#figCap').textContent = c.t; }
  else { wordEl.innerHTML = chunkHTML(c); wordEl.classList.toggle('heading', !!c.heading); place(); }
  preloadFigures();
  updateStats();
  if (!playing) renderContext();
  saveProgressSoon();
}
// 少し先にある図の画像を先に読み込んでおく（表示の瞬間に待たされないように）
const preloaded = new Set();
function preloadFigures() {
  for (let i = idx + 1; i < Math.min(chunks.length, idx + 80); i++) {
    const c = chunks[i];
    if (!c.img) continue;
    const url = api.imgUrl(doc.id, c.img);
    if (preloaded.has(url)) continue;
    preloaded.add(url);
    new Image().src = url;
  }
}
function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `約${s}秒`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return `約${m}分${r ? r + '秒' : ''}`;
  return `約${Math.floor(m / 60)}時間${m % 60}分`;
}
function updateStats() {
  const c = chunks[idx];
  const read = c ? c.pos + c.len : 0;
  $('#seek').value = idx;
  $('#statPos').textContent = read.toLocaleString();
  $('#statTotal').textContent = totalLen.toLocaleString();
  $('#statPct').textContent = totalLen ? (read / totalLen * 100).toFixed(1) : '0';
  $('#statRemain').textContent = chunks.length ? fmtTime(suffix[idx] * 60000 / cpm) : '—';
  let ch = null;
  for (const x of chapters) { if (x.at <= idx) ch = x; else break; }
  $('#docChapter').textContent = ch ? ch.title : '';
  $('#docChapter').hidden = !ch;
}
function renderContext() {
  const box = $('#context'), c = chunks[idx];
  if (playing || !c) { box.hidden = true; return; }
  const pi = c.pi, from = paraStart[pi], to = pi + 1 < paraStart.length ? paraStart[pi + 1] : chunks.length;
  let html = `<div class="cap">第${pi + 1}段落 ／ 全${paras.length}段落　・　クリックでその位置へ</div>`;
  for (let i = from; i < to; i++) {
    const x = chunks[i], cls = i === idx ? 'cur' : i < idx ? 'read' : '';
    html += `<span data-i="${i}" class="${cls}">${esc(x.img ? `［${x.t}］` : x.t)}</span>`;
  }
  $('#contextInner').innerHTML = html;
  box.hidden = false;
  const cur = box.querySelector('.cur');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  if (!c.img) place();
}
$('#contextInner').addEventListener('click', e => { const s = e.target.closest('span[data-i]'); if (s) { idx = +s.dataset.i; show(); } });

/* ================= 再生制御 ================= */
let wakeLock = null;
async function lockScreen(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { wakeLock = null; }
}
function setPlayIcon() {
  $('#playIcon').innerHTML = playing ? '<path d="M3 2h4v12H3zM9 2h4v12H9z"/>' : '<path d="M4 2l10 6-10 6z"/>';
  $('#btnPlay').setAttribute('aria-label', playing ? '停止' : '再生');
  $('#hint').hidden = playing || !chunks.length;
}
function schedule() {
  clearTimeout(timer);
  const c = chunks[idx];
  const d = c.img ? FIG_SEC * 1000 : weights[idx] * 60000 / cpm;
  timer = setTimeout(() => {
    if (idx < chunks.length - 1) { idx++; show(); schedule(); }
    else { pause(); $('#done').hidden = false; }
  }, d);
}
function play() {
  if (!chunks.length) return;
  if (idx >= chunks.length - 1) idx = 0;
  playing = true; setPlayIcon();
  $('#context').hidden = true;
  show(); schedule(); lockScreen(true);
}
function pause() { playing = false; clearTimeout(timer); setPlayIcon(); renderContext(); saveProgress(); lockScreen(false); }
const toggle = () => playing ? pause() : play();
function step(d) { if (!chunks.length) return; idx = Math.min(chunks.length - 1, Math.max(0, idx + d)); show(); if (playing) schedule(); }
function paraStep(d) {
  const c = chunks[idx]; if (!c) return;
  let pi = c.pi;
  if (d > 0) pi = Math.min(paras.length - 1, pi + 1);
  else if (idx === paraStart[pi]) pi = Math.max(0, pi - 1); // 段落の頭にいるときだけ前の段落へ
  idx = paraStart[pi]; show(); if (playing) schedule();
}
function setCpm(v) { cpm = Math.min(4000, Math.max(200, v)); store.set('rsvp.cpm', cpm); computeWeights(); updateStats(); }

/* ================= 読書位置の保存（R2） ================= */
let saveTimer = null, lastSaved = '';
function saveProgressSoon() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveProgress(); }, 2000); }
function saveProgress() {
  if (!doc.id || !chunks.length) return;
  const c = chunks[idx];
  const s = JSON.stringify({ pos: c.pos, pct: totalLen ? Math.round((c.pos + c.len) / totalLen * 100) : 0 });
  if (s === lastSaved) return;
  lastSaved = s;
  fetch(`/api/books/${doc.id}/progress`, { method: 'PUT', body: s, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
}

/* ================= 本を開く・取り込む ================= */
function openBook(b) {
  pause();
  doc.id = b.id; doc.title = b.meta.title;
  paras = b.paras;
  build();
  lastSaved = b.progress ? JSON.stringify(b.progress) : '';
  idx = b.progress && b.progress.pos ? findByPos(b.progress.pos) : 0;
  $('#docTitle').textContent = b.meta.title;
  $('#docAuthor').textContent = b.meta.author || '';
  document.title = b.meta.title + '｜RSVP速読リーダー';
  $('#empty').hidden = true;
  stage.classList.remove('blank');
  store.set('rsvp.last', b.id);
  setPlayIcon();
  show();
}
function showEmpty() {
  doc.id = ''; paras = []; chunks = [];
  $('#docTitle').textContent = ''; $('#docAuthor').textContent = ''; $('#docChapter').hidden = true;
  wordEl.textContent = ''; $('#figure').hidden = true; $('#context').hidden = true; $('#done').hidden = true;
  $('#empty').hidden = false; stage.classList.add('blank'); stage.classList.remove('fig');
  setPlayIcon(); updateStats();
}
// ブラウザで解析 → PDF・図・本文・meta の順にR2へ。meta.json を最後に置くことで、途中で止まった本は一覧に出ない
async function importPdf(file, prefix = '') {
  const say = msg => setBusy(prefix + msg);
  const r = await extractPdf(file, say);
  if (!r.paras.length) throw new Error('文字を取り出せませんでした（画像だけのPDFの可能性があります）');
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    say('PDFを保存しています…');
    await api.putPdf(id, file);
    const names = Object.keys(r.images);
    let done = 0;
    const worker = async () => { let n; while ((n = names.shift())) { await api.putImage(id, n, r.images[n]); say(`図を保存しています… ${++done} / ${r.figures}`); } };
    await Promise.all([worker(), worker(), worker(), worker()]);
    say('本文を保存しています…');
    await api.putJson(id, 'paras', r.paras);
    const meta = { title: r.title, author: r.author, pages: r.pages, chars: r.chars, figures: r.figures, added: Date.now() };
    await api.putJson(id, 'meta', meta);
    return { id, meta, paras: r.paras, progress: null };
  } catch (e) {
    await api.del(id).catch(() => {}); // 途中まで上がったファイルを残さない
    throw e;
  }
}
// 複数ファイルは1冊ずつ順に取り込む。最後に、最初に成功した本を開く
let importing = false;
async function importPdfs(fileList) {
  const files = [...(fileList || [])].filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) { setBusy('PDFファイルを選んでください。', true); return; }
  if (importing) { setBusy('いま取り込み中です。終わるまで待ってください。', true); return; }
  importing = true;
  pause();
  $('#shelfDlg').open && $('#shelfDlg').close();
  let first = null; const failed = [];
  for (let i = 0; i < files.length; i++) {
    const prefix = files.length > 1 ? `${i + 1} / ${files.length} 冊目「${files[i].name.replace(/\.pdf$/i, '')}」\n` : '';
    try {
      const book = await importPdf(files[i], prefix);
      if (!first) first = book;
    } catch (e) {
      console.error(e);
      failed.push(`${files[i].name}: ${e.message || e}`);
    }
  }
  importing = false;
  $('#busy').hidden = true;
  if (first) openBook(first);
  if (failed.length) setBusy(`${failed.length}件を取り込めませんでした。\n${failed.join('\n')}`, true);
}
let busyTimer = null;
function setBusy(msg, isError) {
  clearTimeout(busyTimer);
  $('#busy').hidden = false; $('#busyMsg').textContent = msg;
  if (isError) busyTimer = setTimeout(() => { $('#busy').hidden = true; }, 6000);
}

/* ================= 本棚 ================= */
async function renderShelf() {
  const ul = $('#shelf');
  ul.innerHTML = '<li class="empty-row">読み込み中…</li>';
  let all;
  try { all = await api.list(); } catch (e) { ul.innerHTML = `<li class="empty-row">${esc(e.message)}</li>`; return; }
  if (!all.length) { ul.innerHTML = '<li class="empty-row">まだ本がありません。「PDFを追加」から取り込んでください。</li>'; return; }
  ul.innerHTML = all.map(b => `<li data-id="${b.id}" class="${b.id === doc.id ? 'cur' : ''}">
      <span class="t"><b>${esc(b.title)}</b><small>${esc(b.author ? b.author + '　' : '')}${Number(b.chars).toLocaleString()}字${b.figures ? `・図${b.figures}点` : ''}</small></span>
      <span class="p">${b.progress ? `<b>${b.progress.pct}%</b>` : '未読'}</span>
      <button class="btn small" type="button" data-del="${b.id}" aria-label="削除">削除</button></li>`).join('');
}
$('#shelf').addEventListener('click', async e => {
  const del = e.target.closest('[data-del]');
  if (del) {
    // 1回目は確認、2回目で削除
    if (!del.dataset.armed) { del.dataset.armed = '1'; del.textContent = '本当に削除'; return; }
    const id = del.dataset.del;
    del.disabled = true; del.textContent = '削除中…';
    try { await api.del(id); } catch (err) { del.disabled = false; del.textContent = '失敗。もう一度'; return; }
    if (doc.id === id) showEmpty();
    renderShelf();
    return;
  }
  const li = e.target.closest('li[data-id]'); if (!li) return;
  $('#shelfDlg').close();
  setBusy('本を開いています…');
  try { openBook(await api.get(li.dataset.id)); $('#busy').hidden = true; }
  catch (err) { setBusy(err.message, true); }
});
function openShelf() { pause(); $('#shelfDlg').showModal(); renderShelf(); }

/* ================= 見出し一覧 ================= */
function openToc() {
  if (!chunks.length) return;
  pause();
  const ul = $('#toc');
  if (!chapters.length) { ul.innerHTML = '<li class="empty-row">この本には見出しが見つかりませんでした。</li>'; }
  else {
    let cur = -1;
    chapters.forEach((ch, i) => { if (ch.at <= idx) cur = i; });
    ul.innerHTML = chapters.map((ch, i) => {
      const depth = (ch.title.match(/^\d+(\.\d+)*/) || [''])[0].split('.').filter(Boolean).length; // 1 / 1.2 / 1.2.3
      return `<li data-at="${ch.at}" class="d${Math.min(depth, 3)} ${i === cur ? 'cur' : ''}">${esc(ch.title)}</li>`;
    }).join('');
  }
  $('#tocDlg').showModal();
  const c = ul.querySelector('.cur'); if (c) c.scrollIntoView({ block: 'center' });
}
$('#toc').addEventListener('click', e => {
  const li = e.target.closest('li[data-at]'); if (!li) return;
  idx = +li.dataset.at; $('#tocDlg').close(); show();
});
$('#openToc').addEventListener('click', openToc);

/* ================= UI ================= */
$('#btnPlay').addEventListener('click', toggle);
$('#btnPrev').addEventListener('click', () => step(-1));
$('#btnNext').addEventListener('click', () => step(1));
$('#btnParaPrev').addEventListener('click', () => paraStep(-1));
$('#btnParaNext').addEventListener('click', () => paraStep(1));
$('#seek').addEventListener('input', e => { if (!chunks.length) return; idx = +e.target.value; show(); if (playing) schedule(); });
// タップで再生/停止、左右スワイプで戻る/進む（スワイプ後のクリックは無視する）
let swiped = false, touchX = null, touchY = null;
stage.addEventListener('touchstart', e => { const t = e.changedTouches[0]; touchX = t.clientX; touchY = t.clientY; swiped = false; }, { passive: true });
stage.addEventListener('touchend', e => {
  if (touchX == null) return;
  const t = e.changedTouches[0], dx = t.clientX - touchX, dy = t.clientY - touchY;
  touchX = null;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5 && chunks.length) {
    swiped = true; step(dx < 0 ? 1 : -1);
    setTimeout(() => { swiped = false; }, 400); // スワイプ直後に click が来なかった場合に備えて戻す
  }
}, { passive: true });
stage.addEventListener('click', e => {
  if (swiped) { swiped = false; return; }
  if (!chunks.length || e.target.closest('button, label, input')) return;
  if (e.target.closest('#figure')) { openZoom(); return; } // 図は拡大表示
  toggle();
});
// 図の拡大表示
function openZoom() {
  const c = chunks[idx]; if (!c || !c.img) return;
  pause();
  $('#zoomImg').src = api.imgUrl(doc.id, c.img); $('#zoomImg').alt = c.t; $('#zoomCap').textContent = c.t;
  $('#zoom').hidden = false;
  $('#zoomScroller').scrollLeft = 0;
}
function closeZoom() { $('#zoom').hidden = true; }
$('#zoomClose').addEventListener('click', closeZoom);
$('#zoomScroller').addEventListener('click', e => { if (e.target === e.currentTarget) closeZoom(); });
$('#openShelf').addEventListener('click', openShelf);
$('#doneShelf').addEventListener('click', openShelf);
$('#doneRestart').addEventListener('click', () => { idx = 0; show(); });
for (const id of ['#file', '#file2']) $(id).addEventListener('change', e => { importPdfs(e.target.files); e.target.value = ''; });

// ドラッグ＆ドロップ（画面全体で受け付け）
const empty = $('#empty');
['dragenter', 'dragover'].forEach(t => window.addEventListener(t, e => { e.preventDefault(); empty.classList.add('over'); }));
window.addEventListener('dragleave', e => { if (e.target === document.documentElement) empty.classList.remove('over'); });
window.addEventListener('drop', e => { e.preventDefault(); empty.classList.remove('over'); importPdfs(e.dataTransfer && e.dataTransfer.files); });

document.addEventListener('keydown', e => {
  if (!$('#zoom').hidden) { if (e.key === 'Escape') closeZoom(); return; }
  if (document.querySelector('dialog[open]') || e.target.matches('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  let handled = true;
  switch (e.key) {
    case ' ': toggle(); break;
    case 'ArrowRight': e.shiftKey ? paraStep(1) : step(1); break;
    case 'ArrowLeft': e.shiftKey ? paraStep(-1) : step(-1); break;
    case 'ArrowUp': setCpm(cpm + 100); break;
    case 'ArrowDown': setCpm(cpm - 100); break;
    default: handled = false;
  }
  if (handled) { e.preventDefault(); if (e.target.blur) e.target.blur(); }
});
window.addEventListener('resize', () => { if (chunks[idx] && !chunks[idx].img) place(); });
window.addEventListener('beforeunload', saveProgress);
document.addEventListener('visibilitychange', () => { if (document.hidden && playing) pause(); });

/* ================= 起動 ================= */
(async function boot() {
  const last = store.get('rsvp.last', null);
  const b = last && await api.get(last).catch(() => null);
  if (b) openBook(b); else showEmpty();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (chunks[idx] && !chunks[idx].img) place(); });
})();
