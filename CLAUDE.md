## 專案概要

Lights Out：給台灣觀眾的 F1 觀賽網站（賽程換算台灣時間、積分榜、賽事回顧、車隊車手、新手入門、規則、術語）。

- 網址：https://yuchiangko.github.io/claude-lab/ （GitHub Pages，推上 `main` 約 1 分鐘後自動上線）
- 整個網站是單一檔案 `index.html`（HTML、CSS、JavaScript 都在裡面），不使用框架、不需要建置
- `README.md` 是舊專案（機票比價）留下的說明，內容與目前網站不符

## 本機預覽

```bash
python3 -m http.server 8000   # 再開啟 http://localhost:8000
```

直接雙擊開啟 `index.html` 也能看，但瀏覽器會擋下讀取 `data/radioTranscripts.json`，無線電文字稿不會出現。

## 資料來源

- **OpenF1**（api.openf1.org）：賽事回顧的車輛位置、圈速、區段、輪胎、無線電清單。
  - 比賽結束後的資料免費。
  - **任何一節賽事進行中，OpenF1 會鎖住所有免費存取（連過去的比賽也查不到，回應 401）**，賽事結束後才恢復，測試時要避開比賽時段。
- **F1 官方即時資料流**（livetiming.formula1.com/signalrcore，直播模式使用）：不用登入可取得計時、區段、輪胎、天氣、旗號、管制訊息、無線電；車輛位置（Position.z）與車速油門（CarData.z）需要 F1 TV 帳號，**本專案沒有帳號**。
  - 舊版 `/signalr` 端點與賽後存檔 `/static/.../Index.json` 都要登入，但 `/static/` 底下的無線電 mp3 可以直接下載。
- **積分榜**：網頁會自動從公開 API 抓取，不需手動更新。
- **新聞**（`newsItems`）：人工整理，每則都要附原文連結，只寫報導中查證過的事實。

## 每場正賽結束後

1. 確認 OpenF1 已恢復（不再回 401）。
2. 轉錄無線電（只能在本機執行，F1 的錄音伺服器會擋雲端機房；有開直播的話大部分已經轉好，這步只會補上漏掉的）：
   ```bash
   ~/.local/share/lights-out-whisper/bin/python scripts/transcribeRadio.py
   ```
3. 在 `newsItems` 最前面加上賽果新聞；如有冠軍誕生，同步更新車隊介紹與歷年大事紀（`historyTimeline`）。
4. 更新 `sitemap.xml` 的 `<lastmod>`。
5. 提交 `index.html`、`sitemap.xml`、`data/radioTranscripts.json` 並推上 GitHub。

## 比賽直播模式

比賽進行中，「賽事回顧」分頁會即時更新（名次、差距、區段、輪胎、天氣、旗號、無線電即時轉文字、推算的車輛位置）。

**架構**：Mac 上的 `scripts/liveRelay.mjs` 接 F1 官方資料流 → 以 Server-Sent Events 推送 → Cloudflare 快速通道（`*.trycloudflare.com`）對外 → 網頁讀 `data/liveEndpoint.json` 找到網址後自動切換成直播。沒有直播時 `liveEndpoint.json` 為 `{"url": null}`，網頁維持 OpenF1 回放。

**比賽日**（開賽前約 30 分鐘，Mac 接上電源）：
```bash
node scripts/liveRelay.mjs --tunnel --publish
```
- 會自動防止 Mac 睡眠、錄製原始資料到 `recordings/`（不進版本控制）、正賽的無線電文字稿直接存進 `data/radioTranscripts.json`
- `--publish` 會自動提交並推送 `data/liveEndpoint.json`（只提交這個檔案）；比賽結束按 Ctrl+C，會自動撤下網址
- 需要 `cloudflared`，放在 `~/.local/bin/cloudflared`（官方下載：github.com/cloudflare/cloudflared/releases，選 darwin-arm64）

**車輛位置是推算的**：沒有 F1 TV 帳號拿不到座標，所以用 `data/trackOutlines.json`（各賽道參考圈的輪廓，時間等分 400 點）＋計時資料的小段通過時間推算，並會在比賽中自動校正小段位置。新賽道要先在**非比賽時段**執行 `node scripts/buildTrackOutlines.mjs`（比賽中 OpenF1 會鎖住）。

**測試**（不用等比賽）：
```bash
node scripts/makeTestRecording.mjs              # 用最近一場正賽的 OpenF1 資料產生模擬錄製檔
node scripts/liveRelay.mjs --replay recordings/test-SoPaulo-2026.jsonl --speed 5 --skip 25
python3 -m http.server 8000                     # 開 http://localhost:8000/?relay=http://localhost:8787#live
```
模擬檔的錄製開頭約在開賽前 3 分鐘之前，`--skip` 單位是分鐘。模擬檔是依官方格式「推測」產生的；真實資料流的細節（例如新的一圈時小段是否會清空）要用實際比賽錄下的檔案重播確認。

**尚未驗證**：真實比賽中的資料流行為、Cloudflare 通道傳送 Server-Sent Events、`--publish` 自動推送。第一次正式使用前，先在練習賽（例如拉斯維加斯站 FP1）實測。

## 程式碼風格規範

- UI 介面文字必須使用繁體中文
- 程式碼註解必須使用繁體中文
- 變數與函式命名必須使用 camelCase

## 命名慣例

- JavaScript／TypeScript 檔案：使用 camelCase，元件則使用 PascalCase。
  - 正確：utils.js、UserProfile.jsx、apiClient.ts
  - 錯誤：utils_cool.js、userprofile.jsx
- CSS／SCSS 檔案：使用 kebab-case（例如：main-styles.css）。
