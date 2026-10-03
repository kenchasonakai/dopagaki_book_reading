import { html } from 'hono/html'

// ページの骨組み。動きは /app.js、見た目は /style.css（public/）にある
export const page = () => html`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>RSVP速読リーダー</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+JP:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%231A212B'/%3E%3Crect x='2' y='11' width='12' height='1' fill='%23D8DEE6'/%3E%3Ccircle cx='8' cy='11.5' r='2' fill='%23D9821B'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/style.css">
</head>
<body>

<header class="top">
  <div class="work">
    <h1 id="docTitle"></h1>
    <span class="author" id="docAuthor"></span>
    <span class="chapter" id="docChapter"></span>
  </div>
  <button class="btn" id="openShelf" type="button">本棚</button>
</header>

<main>
  <div class="stage" id="stage">
    <div class="rail"></div>
    <div class="word" id="word"></div>
    <figure class="figure" id="figure" hidden><img id="figImg" alt=""><figcaption id="figCap"></figcaption></figure>
    <div class="hint" id="hint" hidden><kbd>Space</kbd> で再生</div>
    <div class="empty" id="empty">
      <p>PDFをここにドロップ</p>
      <label class="btn primary"><input type="file" id="file" accept=".pdf,application/pdf" hidden>PDFを選ぶ</label>
      <small>解析はこのブラウザの中で行い、本文と図は本棚（R2）に保存されます。</small>
    </div>
    <div class="busy" id="busy" hidden><p id="busyMsg"></p></div>
    <div class="done" id="done" hidden>
      <p>読了しました</p>
      <div class="row">
        <button class="btn primary" id="doneShelf" type="button">本棚へ</button>
        <button class="btn" id="doneRestart" type="button">最初から</button>
      </div>
    </div>
  </div>
  <div class="context" id="context" hidden><div class="inner" id="contextInner"></div></div>
</main>

<footer class="bar">
  <button class="tbtn" id="btnParaPrev" type="button" title="前の段落 (Shift+←)" aria-label="前の段落"><svg viewBox="0 0 16 16"><path d="M2 2h2v12H2zM14 2v12L5 8z"/></svg></button>
  <button class="tbtn" id="btnPrev" type="button" title="1つ戻る (←)" aria-label="1つ戻る"><svg viewBox="0 0 16 16"><path d="M12 2v12L4 8z"/></svg></button>
  <button class="tbtn play" id="btnPlay" type="button" title="再生 / 停止 (Space)" aria-label="再生"><svg viewBox="0 0 16 16" id="playIcon"><path d="M4 2l10 6-10 6z"/></svg></button>
  <button class="tbtn" id="btnNext" type="button" title="1つ進む (→)" aria-label="1つ進む"><svg viewBox="0 0 16 16"><path d="M4 2v12l8-6z"/></svg></button>
  <button class="tbtn" id="btnParaNext" type="button" title="次の段落 (Shift+→)" aria-label="次の段落"><svg viewBox="0 0 16 16"><path d="M12 2h2v12h-2zM2 2v12l9-6z"/></svg></button>
  <div class="progress">
    <input type="range" id="seek" min="0" max="0" value="0" aria-label="読書位置">
    <div class="stats">
      <span><b id="statPos">0</b> / <span id="statTotal">0</span> 字（<span id="statPct">0</span>%）</span>
      <span>残り <b id="statRemain">—</b></span>
    </div>
  </div>
</footer>

<dialog id="shelfDlg">
  <form class="dlg" method="dialog">
    <h2>本棚</h2>
    <ul class="shelf" id="shelf"></ul>
    <div class="foot">
      <label class="btn"><input type="file" id="file2" accept=".pdf,application/pdf" hidden>PDFを追加</label>
      <button class="btn primary" value="close" type="submit">閉じる</button>
    </div>
  </form>
</dialog>

<script type="module" src="/app.js"></script>
</body>
</html>`
