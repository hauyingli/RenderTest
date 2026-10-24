# RenderTest：SharedMark Instagram 來源服務

本專案保留原本的診斷首頁與 `/api/test`，新增 server secret 保護的 Node `/internal/preview`、`/internal/photo`。以下原測試說明中的「只測狀態、不下載圖片」只描述原 `/api/test`；新增 internal photo 會短暫取得並驗證圖片 bytes，不保存檔案。

## 新增後端 API

- Node Web Service 執行 `npm ci`、`npm run check`、`npm test`；啟動仍為 `npm start`。
- 保留 `TEST_KEY`（至少20字）供原測試頁使用。
- 新增 `RENDER_PREVIEW_SECRET` runtime Secret，建議32bytes隨機值轉64字hex（僅英數／底線／連字號，64–256字）。與 SharedMark Pages runtime 的同名 Secret 一致，**不要與頁面 TEST_KEY 共用**。未設定或錯誤時 internal API fail closed。
- `PORT` 沿用 Render 注入，本機預設10000。Node22以上。
- `/internal/preview`：POST JSON `{url}`，只接受精確 IG HTTPS 公開 permalink，不接受query/share/任意端點。回完整既有 resolvePreview 結果及相容的mediaItems與固定photo入口。
- `/internal/photo`：POST JSON `{url,id}`。id是綁定貼文＋媒體物件的32字hex，不是index；先用原manifest確認歸屬，再驗證CDN白名單、MIME、8MiB及檔頭。不能傳圖片URL。
- 兩者都只接受 `X-SharedMark-Render-Secret`，拒絕Origin，不提供瀏覽器CORS。錯誤/成功皆private,no-store。沒有IG Cookie、登入Session、私人API或代理輪換；來源限制不繞過。
- 每process120請求/分鐘、4同時、12個新來源解析/分鐘；body4KiB/5秒，HTML25秒，操作30秒，CDN15秒；同貼文metadata短快取與同圖片下載single-flight，沒有無限重試。
- `worker.mjs` 仍是舊的Cloudflare差異診斷入口，**不是新的Node internal服務**；SharedMark URL必須指向這個Render Node Web Service。
- 所有實作可在 `internal-preview.mjs`、`internal-http.mjs`、複用的 `functions/api/preview-photo.js`／`preview-image.js` 查閱。原 `functions/api/preview.js` 不修改。

## 與 SharedMark 串接

Pages Functions Preview環境需要：`RENDER_PREVIEW_ENABLED=false`（驗收後才能true）、`RENDER_PREVIEW_URL=https://<node-service>.onrender.com`、同一份 `RENDER_PREVIEW_SECRET` Secret。不傳給Flutter／瀏覽器／dart-define，不放GitHub。Pages端只允許onrender.com服務origin，自訂網域目前未放行。

完整資料流程、環境變數、隔離驗收與部署步驟見另一個repository的 `docs/RENDER_PREVIEW_BRIDGE.md`。

本機跨repo驗收（從SharedMark執行）：

```powershell
node scripts/test-render-preview-bridge.mjs --render-root=E:\RenderTest
```

測試使用loopback HTTP與7媒體fixture，不連IG或正式Render，不需要正式secret。RenderTest本輪9個Node測試通過，含原頁面保留、認證、惡意URL、圖片bytes與錯誤分類。

串接程式依使用者後續要求由main交付，Git推送可能觸發既有自動部署；本輪沒有另行手動部署或修改雲端設定。以下指令僅供日後人工執行：Render build=`npm ci`，start=`npm start`；選擇已審查的staging branch後，Dashboard Manual Deploy。若已有安全設定的Deploy Hook，可用 `Invoke-WebRequest -Method Post -Uri $env:RENDER_DEPLOY_HOOK_URL | Out-Null` 手動觸發。Hook URL也是Secret，不要寫進Git。正式冷啟動、IG/CDN可用性及手機解碼仍待部署後驗收。

---

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

`wrangler.jsonc` 已對齊目前 Cloudflare 的實際 Worker 名稱 `rendertest`。

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
