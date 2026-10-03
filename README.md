# RSVP速読リーダー

PDFを取り込み、本文を1文節ずつ画面中央に表示して読む速読リーダーです。
Hono + Cloudflare Workers + R2 で動き、Cloudflare CLI（`cf`）で開発・デプロイします。

## 動かす

```sh
npm install
npm run dev        # ローカル開発（R2はローカルでエミュレート）
```

Cloudflareに置くときは、一度だけバケットを作ってからデプロイします。

```sh
npx cf auth login
npx cf r2 buckets create rsvp-books
npm run deploy
```

`main` への push は Workers Builds が拾って自動でデプロイします（ビルド `npm run build`、デプロイ `npx cf deploy --prebuilt`）。

公開URLは誰でも開けてしまうので、自分だけで使うなら Cloudflare Access（Zero Trust）でログインを挟みます。アプリ側に認証はなく、Access が全パス（`/api/*` 含む）を守る前提です。設定は `cf zero-trust identity-providers create`（ワンタイムコード）と `cf zero-trust access applications create`（対象ドメインと許可するメールアドレス）の2コマンドで済みます。

## 使い方

1. 画面にPDFをドロップするか「PDFを選ぶ」で取り込む（複数まとめて可。1冊ずつ順に処理されます）
2. 再生ボタンか `Space`（スマホはタップ）で読み始める
3. 右上の「見出し」で章・節へ移動、「本棚」で取り込んだ本の切り替えと削除

スマホでは「ホーム画面に追加」するとアプリとして全画面で開けます。

PDFの解析（本文の取り出しと図の切り出し）はブラウザの中で行い、結果（PDF・本文・図）をR2に保存します。解析は取り込み時の1回だけで、以降はどの端末からでもR2から読みます。読書位置もR2に保存されるので、別の端末で続きから読めます。

## 操作

| キー | 動作 |
| --- | --- |
| `Space` | 再生 / 停止 |
| `←` `→` | 1文節戻る / 進む |
| `Shift` + `←` `→` | 段落単位で移動 |
| `↑` `↓` | 速度を100字/分ずつ変更（初期値 1200字/分） |

ドックの「1.0×」を押すと倍速（1.1〜1.5×）に切り替わります。文章の速さと図の表示時間の両方にかかります。

スマホでは、画面タップで再生/停止、左右スワイプで戻る/進むです。

停止中は、いま読んでいる段落が下に表示されます。文節をクリックするとその位置へ移動します。
長い文節は縮小せず2行に折り返します。

図は、PDF内の「▲図 1.1 …」といったキャプションの周辺を切り出したもので、本文中のその位置で8秒間止まって表示します。
図をタップ/クリックすると全画面で拡大できます（高さいっぱいに表示、横スクロール）。

PDFの目次（点線とページ番号が並ぶ部分）は取り込み時に取り除きます。

## 構成

```
cloudflare.config.ts   Workerの設定（R2バインディング）
vite.config.ts         ビルド設定。public/ は静的アセットとして配信
src/index.ts           Honoアプリ（ページ配信とR2のAPI）
src/page.ts            ページの骨組み（HTML）
public/app.js          リーダー本体（再生・文節化・本棚）
public/extract.js      PDFから本文と図を取り出す処理
public/style.css       見た目
```

R2の中身は本ごとに `books/<id>/` にまとまっています。

```
books/<id>/book.pdf        取り込んだPDF
books/<id>/meta.json       タイトル・著者・文字数など
books/<id>/paras.json      本文（段落の配列）
books/<id>/progress.json   読書位置
books/<id>/img/fig-N.png   図
```

文字サイズ・速度の初期値・図の表示秒数は `public/app.js` 先頭の定数で変えられます。

## 制限

- 画像だけのPDFや縦書きのPDFには対応していません
- 図はキャプション付きのものだけ切り出します。PNGで600KBを超える図はJPEGで保存します
- PDFの解析にはブラウザからCDN（jsdelivr）上の pdf.js を読み込みます
