# Yomika v1.5.4

一個本機優先（local-first）的 Chrome 擴充功能：用 OpenAI API 將日文推文、小說或長篇文字翻成台灣繁體中文。推文直譯只顯示結果；小說翻譯則會保存到本機書庫。

## 翻譯模式與保存規則

| 功能 | 適合內容 | 是否保存到書庫 |
| --- | --- | --- |
| GPT 直譯成繁中 | 推文、短句、臨時查閱 | **不保存** |
| GPT 小說模式翻成繁中 | 小段小說、需要保留的文章 | 保存 |
| 翻譯選取的完整小說 | 長篇小說 | 保存 |
| 翻譯本頁小說（實驗） | 可正確擷取正文的小說頁面 | 保存 |

直譯仍會在 Side Panel 顯示本次 token 與估算成本，但不會建立作品、Markdown、`history.csv` 或 `usage.csv` 紀錄。

## 功能

- 反白推文或短句直接翻譯，不污染書庫。
- 小說模式翻譯會保存原文、譯文與來源資訊。
- 選取整篇小說：自動切 chunk、逐段翻譯、顯示進度。
- 實驗性「翻譯本頁小說」與 Side Panel 貼上全文。
- `config/glossary.json` 固定角色名、性別提示、稱謂與專有名詞。
- 小說翻譯保存為 `original.md` / `translated.md` / `metadata.json`，並記錄 `history.csv` / `usage.csv`。
- Reader：中文 / 日文 / 日中對照、深色模式、Token / 成本統計。
- Reader 長標題會自動換行，書單標題最多顯示兩行，避免撐壞版面。
- Reader 可勾選多篇作品後批次刪除，也可一鍵全選／取消全選。
- AO3 多章：`/works/<work-id>/chapters/<chapter-id>` 自動歸到同一本作品，Reader 可切章。
- 同 Wi-Fi 手機 Reader（可選）：只開放唯讀 Reader；翻譯端點仍限 localhost。
- 舊版 v1.4.x 書庫仍可讀；沒有 chapter metadata 的舊作品會視為單章作品。

## 需求

- Windows / macOS / Linux
- Chrome / Chromium 系瀏覽器（支援 Manifest V3 Side Panel）
- Node.js + npm
- OpenAI API key 與可用 API 額度

## 安裝

```powershell
npm install
Copy-Item .env.example .env
Copy-Item config/glossary.example.json config/glossary.json
```

編輯 `.env`：

```env
OPENAI_API_KEY=sk-proj-your-key-here
PORT=8787
ENABLE_LAN_READER=false
```

啟動：

```powershell
npm start
```

Chrome 開啟 `chrome://extensions` → 開啟「開發人員模式」→「載入未封裝項目」→ 選擇 `extension/`。

## 使用方式

### 短文

- `Alt + T`：小說模式翻譯目前反白文字。
- `Alt + Shift + T`：直譯目前反白文字，**不保存到書庫**。
- 或反白後使用右鍵選單。

### 長篇小說

推薦：**整篇正文反白 → 右鍵 →「📚 GPT 翻譯選取的完整小說」**。

Server 會自動切成約 12,000 字元的 chunk，逐段翻譯，並帶少量前一段譯文維持上下文一致。也可以在 Side Panel 貼上全文。

「🧪 GPT 翻譯本頁小說」會用 heuristic 猜正文，網站改版時可能混入 UI 文字，因此仍標為實驗功能。

## AO3 多章作品

v1.5 會辨識 AO3 URL：

```text
https://archiveofourown.org/works/123456/chapters/111111
https://archiveofourown.org/works/123456/chapters/222222
```

兩個 URL 的 `work-id` 都是 `123456`，因此會保存到同一個作品資料夾，例如：

```text
library/works/ao3_123456/
├─ original.md
├─ translated.md
└─ metadata.json
```

Markdown 會加入章節 heading；Reader 會出現章節選單。每章仍保存自己的來源 URL，因此 Reader 的「開啟原始網頁」在選定章節時會回到該章。

如果是一般網站，仍以頁面 URL 作為作品識別方式。

## Glossary：固定譯名與稱謂

第一次使用先複製 sample：

```powershell
Copy-Item config/glossary.example.json config/glossary.json
```

`glossary.json` 是你的私人設定，預設已被 `.gitignore` 排除。範例：

```json
{
  "characters": {
    "佐藤健一": {
      "zh": "佐藤健一",
      "gender": "male",
      "note": "成年男性角色"
    },
    "高橋美咲": {
      "zh": "高橋美咲",
      "gender": "female"
    }
  },
  "terms": {
    "佐藤さん": "佐藤先生",
    "高橋さん": "高橋小姐",
    "青葉学園": "青葉學園"
  },
  "rules": [
    "人物姓名與稱謂必須保持一致。",
    "固定譯名優先於模型自行推測。"
  ]
}
```

- `characters`：角色固定中文名，可附 `gender` / `note` 幫助模型理解稱謂。
- `terms`：強制詞彙對照，適合人名、暱稱、組織、地名、術語。
- `rules`：作品特有的翻譯規則。
- Server 每次翻譯都重新讀取 glossary，因此修改後通常不用重啟。

## OpenAI API：計費、預付額度與 API key

**ChatGPT 訂閱與 API 計費是分開的。** ChatGPT Plus / Pro 等訂閱不會自動包含 API 額度；API 必須在 API Platform 另外設定付款方式與計費。

官方說明：
- API 與 ChatGPT 計費分開：https://help.openai.com/en/articles/9039756
- Prepaid billing：https://help.openai.com/en/articles/8264644
- API keys：https://platform.openai.com/api-keys

### 建議的 prepaid 設定

1. 登入 OpenAI API Platform，進入 API Billing。
2. 新增付款方式。
3. 購買 prepaid credits。官方目前說明首次購買最低為 **US$5**。
4. 設定時注意 **Auto-reload 預設可能開啟**；不希望自動加值就關閉。
5. 建立 Project API key，放進 `.env` 的 `OPENAI_API_KEY`。
6. 若使用 Restricted key，至少需要允許本工具使用 Responses API 建立 response 的權限；實際權限名稱/UI 可能隨 OpenAI Platform 更新。

預付額度會隨 API 使用扣除。官方也提醒：餘額耗盡後停止可能存在處理延遲，因此 prepaid balance 不應視為毫秒級的硬性 spending cutoff。最新規則以 OpenAI Billing / Help Center 為準。

**不要把 API key 寫進 Chrome extension 原始碼，也不要 commit `.env`。** Key 只留在 localhost Node server。

## 手機 / 同 Wi-Fi Reader

預設：

```env
ENABLE_LAN_READER=false
```

Server 只監聽 `127.0.0.1`，其他裝置無法連線。

如果需要同 Wi-Fi 手機閱讀：

```env
ENABLE_LAN_READER=true
```

重新啟動 `npm start` 後會顯示：

```text
Reader (same Wi-Fi, read-only):
  http://192.168.x.x:8787/reader
```

手機與電腦連同一 Wi-Fi 後，用手機瀏覽器開該網址即可。LAN client 只能 GET Reader / library / usage；`/translate`、`/translate-page`、jobs 等會花 API credits 的端點仍限制 localhost。

Windows Defender Firewall 若第一次詢問 Node.js 網路權限，只需允許「私人網路」，不需要開放公用網路。

## 書庫資料格式

```text
library/
├─ history.csv
├─ usage.csv
└─ works/
   └─ <work-id>/
      ├─ original.md
      ├─ translated.md
      └─ metadata.json
```

AO3 多章作品的 `metadata.json` 會包含 `chapters`；Markdown 也會寫入 chapter marker。沒有 SQL。

`library/` 預設不進 Git，因為可能包含私人閱讀紀錄、來源 URL、受著作權保護的原文與翻譯內容。

## Git / 分享給別人

本專案的 `.gitignore` 預設排除：

```text
.env
library/
config/glossary.json
node_modules/
*.zip
```

建議保留在 repo：

```text
.env.example
config/glossary.example.json
package.json
package-lock.json
extension/
server/
README.md
```

第一次 push 前先確認：

```powershell
git status
```

確定 `.env`、`library/`、`node_modules/`、私人 `config/glossary.json` 都沒有出現在 staged files。

## Usage / 成本統計

小說模式與長篇翻譯的 usage 會寫入 `library/usage.csv`，並累計到作品 `metadata.json`。Reader 頂端顯示的是書庫作品累計 token 與估算成本。

直譯不進書庫，因此只在 Side Panel 顯示當次用量，不會納入 Reader 的累計數字。

目前程式內的價格只是**本機估算值**，實際扣款永遠以 OpenAI Billing 為準；模型定價改變時請同步更新 `server/server.mjs` 的 `PRICING`。

## 從舊版升級

1. 備份原本資料夾（尤其 `.env`、`library/`、`config/glossary.json`）。
2. 用新版程式檔覆蓋舊版。
3. **不要用 sample 覆蓋自己的 `.env` / glossary / library。**
4. 在既有 `.env` 補上：

```env
ENABLE_LAN_READER=false
```

若你本來就要手機同 Wi-Fi Reader，改成 `true`。
5. `npm install`（若 lockfile/依賴未變通常很快）。
6. `npm start`。
7. `chrome://extensions` 對擴充功能按重新載入，確認版本為 `1.5.4`。

舊作品沒有 chapter metadata 時，Reader 會當作單章作品顯示，不需要先搬資料。

## 安全提醒

- `.env` / API key 不要上 GitHub。
- `library/` 不要上 GitHub，除非你確定有權分享其中所有內容。
- LAN Reader 預設關閉；只有需要時才設 `ENABLE_LAN_READER=true`。
- 不建議直接把 8787 port 暴露到 Internet。
- 本工具是個人 local-first 工具，不提供帳號、權限管理或公網部署防護。

## Reader 書庫管理

在「📚 Yomika 圖書館」中可以：

- 收藏作品。
- 修改作品標題或章節標題。
- 刪除單一章節或整篇作品。
- 勾選多篇作品後批次刪除。

修改標題只影響本機顯示與 Markdown 標題，不會改變來源 URL、作品 ID 或 AO3 歸檔。刪除前會再次確認；同 Wi-Fi 手機 Reader 維持唯讀，不能改名或刪除。
