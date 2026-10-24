# SharedMark Instagram Render Test

## Cloudflare Workers 測試（與 Render 使用相同解析器）

本 Repository 同時包含兩種獨立入口：
- Render：`server.mjs`，使用 `npm start`。
- Cloudflare Workers：`worker.mjs`，使用 `wrangler.jsonc` 的 `main` 設定。

Cloudflare Workers Builds 的設定：

| 欄位 | 值 |
| --- | --- |
| Repository | `hauyingli/RenderTest` |
| Branch | `main` |
| Root Directory | `/` |
| Build Command | `npm install` |
| Deploy Command | `npx wrangler deploy` |

Cloudflare → Workers & Pages → 對應 Worker → Settings → Variables and Secrets：
新增執行階段（Runtime）**Secret**：`TEST_KEY`，值為至少 20 字的隨機字串。這和 Render 的 TEST_KEY 可以不同；不可把它寫進 GitHub、`wrangler.jsonc` 或 Build Variables。

目前 `wrangler.jsonc` 中的 Worker 名稱是 `rendertest-ig-compare`，這可能和你先前建立的 Hello World Worker 不同，部署後應開啟實際顯示的 `rendertest-ig-compare.*.workers.dev` 網址。如果你要取代原先的 Worker，先將 `name` 改成該 Worker 在 Cloudflare 顯示的確切名稱。

本機打包檢查，不會部署：

```powershell
npm install
npm run check
npm run check:cloudflare
```

部署後開首頁輸入 TEST_KEY，按「開始測試」；若收到 302/access_redirect，不代表部署失敗，而是 Instagram 來源回應限制。測試只統計媒體資料，不下載圖片。


這是**獨立測試專案**，不連接 SharedMark 正式 App、Supabase、R2、Instagram Token，也不下載任何 IG 圖片。

固定測試公開貼文：`https://www.instagram.com/p/DezFdXmkkI2/`。
使用**直接從原 SharedMark 專案複製的 `functions/api/preview.js`**，只回傳 HTTP 來源狀態、解析狀態、圖片與媒體數量；若來源要求登入便停止，不嘗試繞過。

## 推送至你已建立的 GitHub Repository

1. 將 ZIP 解壓縮到一個**新資料夾**（不要解壓到 SharedMark 的 Git 目錄裡）。
2. 在該資料夾開啟 PowerShell，執行：

```powershell
git init
git add .
git commit -m "Initial Render Instagram diagnostic"
git branch -M main
git remote add origin https://github.com/hauyingli/RenderTest.git
git push -u origin main
```

注意：GitHub `RenderTest` 最好先建立成空 Repository（不要勾選自動產生 README）。已有內容則先檢查分支，避免覆蓋。

## Render 設定

1. 開啟 https://dashboard.render.com/ → New → **Web Service**。
2. 連結 GitHub，選 `hauyingli/RenderTest`，分支 `main`。
3. Language / Runtime: **Node**；Root Directory：留空。
4. Build Command：`npm install`；Start Command：`npm start`。
5. Instance Type / Plan：**Free**（若目前帳號可用）。
6. Environment → 新增 `TEST_KEY`，值使用自訂、長度至少 20 字的隨機密鑰；**勿加入 GitHub**。
7. 建立服務並等待部署完成。瀏覽服務的 `https://<name>.onrender.com/`。
8. 在首頁輸入同一組 `TEST_KEY`，按「開始測試」。

結果顯示 `200 / public_media / 7` 表示這次 Render 能解析到 7 個媒體（**不等於圖片已下載成功**）；若是 `302 / access_redirect / 0`，表示這次 Render 仍被來源導到登入頁。

## 本機先測試

```powershell
$env:TEST_KEY = [guid]::NewGuid().ToString("N")
npm install
npm run check
npm start
```

另開瀏覽器進入 `http://localhost:10000`，將剛剛生成的 `$env:TEST_KEY` 值複製到表單即可測試。
測試完後可執行 `Remove-Item Env:\TEST_KEY`。

## 限制與安全

- 只有預先固定的一篇公開貼文；不接受輸入任意來源網址。
- 不讀取 Cookies、不使用 Instagram 帳號權杖、不使用非公開 API 或代理輪換。
- 執行間隔至少 65 秒；單輪來源請求最多 25 秒。
- 瀏覽器表單密鑰只放在請求 header，不寫入 Cookie、URL、localStorage。
- 不要將測試專案視為正式預覽 API；不驗證圖片實際下載、編碼或 Flutter 顯示。
