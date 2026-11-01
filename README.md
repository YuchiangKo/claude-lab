# YuChiang — Graphic Design Studio

獨立平面設計師 YuChiang 的個人作品集 Landing Page，用來展示設計作品並吸引合作洽詢。

## 網站功能

- **導覽列**：品牌標誌、「精選作品」與「合作洽詢」錨點連結，以及接案檔期狀態標示。
- **英雄區塊（Hero）**：個人介紹、主標語與行動按鈕（與我聯繫／觀看作品），並列出設計經驗、合作專案數與獲獎數等數據。
- **精選作品**：三件代表作案例介紹——
  - 山嵐茶事｜品牌識別
  - 《潮間帶》攝影集｜書籍設計
  - 城市漫遊節｜主視覺設計
- **合作洽詢**：聯絡 Email 與社群連結（Instagram、Behance、LinkedIn）。
- **進場動畫**：區塊依序淡入；若使用者系統開啟「減少動態效果」，會自動關閉動畫。
- **RWD 響應式設計**：針對平板（≤ 980px）、手機（≤ 720px）與小螢幕手機（≤ 400px）調整版面，手機上也能舒適瀏覽。

## 使用技術

- **HTML5**：語意化結構（`nav`、`section` 等），單一 `index.html` 檔案。
- **CSS3**：
  - CSS 變數（Custom Properties）管理色彩與字體
  - Flexbox／Grid 版面配置
  - `@keyframes` 動畫與 `prefers-reduced-motion` 無障礙支援
  - `@media` 媒體查詢實現 RWD
- **Google Fonts**：Inter、Cormorant Garamond、Noto Sans TC

不需要 JavaScript、框架或任何建置工具。

## 如何用瀏覽器開啟

**方法一：直接開啟檔案**

在檔案總管（Finder）中找到 `index.html`，按兩下即可用預設瀏覽器開啟；或將檔案拖曳到 Chrome、Safari、Edge 等瀏覽器視窗中。

**方法二：使用終端機（macOS）**

```bash
cd claude-lab
open index.html
```

> 提示：網站字體透過 Google Fonts 載入，請在連網狀態下開啟以獲得最佳顯示效果。
> 想檢查手機版效果，可在瀏覽器按 `F12`（或 `Cmd + Option + I`）開啟開發者工具，切換到裝置模擬模式。

## 檔案結構

```
claude-lab/
├── index.html   # Landing Page 主頁面（含 HTML 與 CSS）
├── note.txt     # 筆記
└── README.md    # 專案說明
```
