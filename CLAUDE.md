## 開發指令

| 用途 | 指令 | 說明 |
| --- | --- | --- |
| 啟動開發伺服器 | `npm run dev` | 於 localhost:5173 預覽 |
| 建置正式版本 | `npm run build` | 輸出至 dist/ |
| 預覽正式版本 | `npm run preview` | 於 localhost:4173 預覽 dist/ |

## 程式碼風格規範

- UI 介面文字必須使用繁體中文
- 程式碼註解必須使用繁體中文
- 變數與函式命名必須使用 camelCase

## 命名慣例

- JavaScript／TypeScript 檔案：使用 camelCase，元件則使用 PascalCase。
  - 正確：utils.js、UserProfile.jsx、apiClient.ts
  - 錯誤：utils_cool.js、userprofile.jsx
- CSS／SCSS 檔案：使用 kebab-case（例如：main-styles.css）。
