# 東京湾 入出航予定（スマホ用まとめビュー）

海上保安庁 東京湾海上交通センター（東京MARTIS）が公開している
**東航路**・**西航路**の入出航予定を、スマートフォンで1画面にまとめて見られるようにしたものです。

- 時刻順に上から並べ、**時間帯ごとに色分け**
- 入航（緑）／出航（橙）／シフト（紫）をひと目で判別
- 水先人（パイロット）ありを強調表示
- 表示項目：**時刻・入出航・バース・船名・長さ・トン数・水先人**
- 20分ごとに自動で最新データへ更新

---

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | 表示画面（これ1つで動作。スマホ最適化） |
| `data.json` | 予定データ（自動更新される） |
| `scrape.js` | 公式ページからデータを取得する処理（Node.js） |
| `.github/workflows/update.yml` | 20分ごとの自動更新設定 |

> `index.html` は起動時に `data.json` を読み込みます。読み込めない場合は
> 内蔵の収録データを表示するので、単体でも画面は必ず表示されます。

---

## インターネットに公開する手順（GitHub Pages・無料）

サーバー不要・無料で、**自動更新つき**で公開できます。

### 1. GitHubアカウントを用意
https://github.com/ で無料登録（すでにあれば不要）。

### 2. リポジトリを作成してファイルを入れる
1. GitHubで「New repository」→ 名前を付けて **Public** で作成
2. このフォルダ内の全ファイル（`index.html` `data.json` `scrape.js` `.github` フォルダごと）をアップロード
   - Web画面なら「Add file → Upload files」にドラッグ＆ドロップ
   - `.github` フォルダも忘れずに（自動更新に必要）

### 3. GitHub Pages を有効化
1. リポジトリの **Settings → Pages**
2. 「Build and deployment」の Source を **Deploy from a branch**
3. Branch を **main / (root)** にして Save
4. 数分後、`https://ユーザー名.github.io/リポジトリ名/` が発行されます
   → これがスマホで開くURL。ホーム画面に追加すればアプリのように使えます。

### 4. 自動更新を有効化
1. リポジトリの **Settings → Actions → General**
2. 一番下「Workflow permissions」を **Read and write permissions** にして Save
3. **Actions** タブ →「update-schedule」→「Run workflow」で初回を手動実行
   （以降は20分ごとに自動で `data.json` を更新します）

---

## 更新の間隔を変えたいとき

`.github/workflows/update.yml` の `cron` を編集します（時刻はUTC基準）。

```yaml
- cron: "*/5 * * * *"    # 5分ごと（GitHub Actionsの最短）→ "*/10 * * * *" なら10分ごと
```

> 現在は **5分間隔** に設定しています（GitHub Actions の最短間隔）。混雑時は数分遅れることがありますが、
> 画面右上の **⚓ ボタン**でいつでも手動で最新化できます。

---

## 自分のPCで動作確認したいとき（任意）

Node.js 18以上が必要です。

```bash
node scrape.js        # data.json を最新化
# index.html をブラウザで開く（データ取得にはローカルサーバー推奨）
npx serve .           # → 表示されたURLをブラウザで開く
```

---

## 取得データと出典

| 項目 | 出典 |
|---|---|
| 入出航予定（東/西航路） | 海上保安庁 東京湾海上交通センター（東京MARTIS） [東航路](https://www6.kaiho.mlit.go.jp/tokyowan/schedule/TOKYOHIGASHI/schedule_1.html)・[西航路](https://www6.kaiho.mlit.go.jp/tokyowan/schedule/TOKYONISHI/schedule_1.html) |
| 着離岸予定（各ふ頭） | [東京港港湾情報システム](https://www.kouwan2.metro.tokyo.jp/app/keisen_result)（当日検索・全ふ頭）。ふ頭→航路／希望バース→バース／着岸→入航／離岸→出航／総トン数→トン数。長さ・水先人は「-」。**東/西航路と船名が重複する場合は東/西を優先**し港湾側を除外 |
| 天気・最高/最低気温・降水確率 | 気象庁 府県天気予報（東京地方）JSON |
| 潮汐（満潮・干潮の時刻/潮位） | 気象庁 潮位表（東京 TK） |
| 十号地・海ほたるの風向風速 | 東京湾海上交通センター 気象観測（[十号地信号所](https://www6.kaiho.mlit.go.jp/tokyowan/kisyou/10gochi_vtss.html)・[海ほたるレーダー施設](https://www6.kaiho.mlit.go.jp/tokyowan/kisyou/umihotaru_radar.html)） |
| 日の出・日の入 | 緯度経度からの天文計算（NOAA式） |
| 雨雲レーダー（ボタン） | [ウェザーニュース 品川区 雨雲レーダー](https://weathernews.jp/onebox/radar/tokyo/13109/) |

> 天気・気温・潮汐は、公開APIのない Weathernews の代わりに**気象庁の公式データ**を使用しています（自動取得の安定性のため）。雨雲レーダーはご要望どおり Weathernews へリンクします。

## 注意

- データ出典：上記のとおり（主に**海上保安庁**・**気象庁**の公開情報）
- 本サイトは上記の公開情報を見やすく整理して表示するものです。
  **実際の運航判断は必ず公式情報・関係各所の指示をご確認ください。**
- 公式ページのレイアウトが変更されると取得できなくなる場合があります。
  その際は `scrape.js` の解析部分の調整が必要です。
