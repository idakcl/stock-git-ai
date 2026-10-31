# 进销存系统（GitHub 数据仓 + Cloudflare 部署）

> **退款功能新增契约**：见 [退货与退款](docs/refunds.md)。默认退现金；`GET /api/refunds` 读凭证，`POST /api/refunds` 接收操作指令（不是整表覆盖）。退货核销使用 `settlements`，不计入优惠或现金；本文旧的普通收付款公式不适用于退货核销。
>
> **订单与变更新增契约**：见 [订单（草稿）与单据变更](docs/orders.md)。订单住在独立文件 `orders.json`，**不占库存、不进应收**，过账才生成正式单据（`POST /api/orders` 操作指令）；已动过钱的单据**不允许原地改明细**，增减商品走 `POST /api/amends` 生成退货单（`XT-`/`CT-`）与补差单（`XA-`/`CA-`）。订单与正式单据的明细行都支持**行折扣**（`items[].discountRate / discount / total`，统一折后口径）。
>
> **作废契约**：见 [单据作废](docs/void.md)。`POST /api/voids` 把销售单/采购单整单作废，并同步作废关联的收款单 `SK-` / 付款单 `FK-`；单据保留可审计，但库存、应收应付、实收实付一律归零。脚本统计时**必须先过滤 `status === '作废'`**。

单 Worker 同时托管：
- 前端静态资源（Vite 构建产物 `dist/`，通过 `assets` 绑定 `ASSETS`）
- 后端 API（`/api/*`，读写 GitHub 数据仓 JSON）

## 目录
- `src/` — Vue 3 + Element Plus 前端
- `src/api/index.js` — 前端 API 层（携带票据、15s 内存缓存、写后 20s 强刷窗口）
- `src/utils/voucher.js` — 资金单据编码生成（`SK-`/`FK-YYYYMMDD-NNNN`）
- `src/utils/voucherFlow.js` — **收付款 → 资金单据联动的唯一入口**（纯逻辑，不含 UI）
- `src/utils/account.js` — 全站唯一账务公式（应收/未收/结清判定）
- `src/utils/catalog.js` — 商品目录口径：`resolveLine` 建档与行金额归一化（`normalizeRate`）、行级多级折扣链（`lineDiscountRatesOf` / `lineEffectiveRate` / `applyLineRates`）、改名后的展示名解析。纯函数，Worker 端可直接 import
- `src/utils/entryMode.js` — 整页开单路由（`/sales/new` 等）的判断逻辑：路由 `meta.entry / meta.standalone` 把开单表单开成无外壳的整页，保存链路仍复用列表页那一份；列表页已不再提供「新页面开单」按钮
- `src/utils/clipboard.js` — 复制链接（Clipboard API + 局域网 http 回退 `execCommand`）与分享链接拼接
- `src/utils/export.js` — 导出 / 打印排版：`printA4()` / `printA4Sections()`，单头字段带 `tone`（`hl` 加框强调、`xl` 字号两倍），`footerFields` 输出商品列表底部的用户信息落款
- `src/utils/orders.js` — 订单（草稿）状态机与校验：`validateOrder` / `orderAmount` / `orderToOrderDoc` / `canUnpost` / `applyOrderOperation`（前端预览与服务端落库共用）
- `src/utils/amend.js` — 单据变更口径：`moneyTouched` / `diffOrderLines` / `refundPreview` / `applyAmendOperation`（同上，共用一份实现）
- `src/utils/dedupe.js` — 导入去重（前端预览与后端落库共用）
- `api/github.js` — GitHub API 读写辅助
- `api/tx.js` — 「读固定快照 → 纯函数算 → 一次提交发布」的事务骨架（退款 / 订单 / 变更共用）
- `api/orders.js` / `api/amends.js` — 订单、变更两个操作接口的事务入口
- `api/auth.js` — 登录票据（HMAC）与 CORS 白名单
- `api/profile.js` — 用户信息（打印落款用的联系名称/电话/地址/备注）读写与字段裁剪
- `api/shares.js` — 外链分享：令牌生成、时效、取消、公开只读读取与脱敏载荷
- `api/templates.js` — 订单模板：多份模板的增删改复制、字段裁剪与上限保护（数据存 `order-templates.json`）
- `src/utils/aiScopes.js` — **AI-API 权限目录 / 预设 / 接口表**（前端勾选框、服务端校验、`/schema` 共用同一份）
- `api/ai-keys.js` — AI 密钥：只存 SHA-256 与显示前缀，签发 / 改权限 / 吊销 / 使用统计 / 鉴权
- `api/ai.js` — AI-API 全部读写接口（`/api/ai/v1/*`），金额服务端重算 + 幂等 + 审计
- `api/ai-logs.js` — AI 调用日志：内存缓冲后合并落盘，保留 7 天 / 1500 条，管理页可查
- `api/routes.js` — API 路由 + 自动推导逻辑（`derive` / `rebuildStock`）
- `web/index.js` — Worker 入口（静态 + SPA 回退 + API + 边缘缓存）
- `wrangler.json` — Cloudflare Workers 配置

> **要给另一个 AI / 外部脚本对接？直接看「AI / 脚本对接（接口契约）」一节。**

## 数据仓
独立 GitHub 仓库 `stock-git-ai-data`，全部为**紧凑 JSON**（无缩进，程序读不给人读）。文件：
`items.json / suppliers.json / customers.json / receipts.json / payment-vouchers.json / refunds.json / orders.json / stock.json / logs.json`
加上按年分片的单据：`purchases-2025.json`、`sales-2025.json`…，以及分片判据文件 `.split-yearly.json`。

数据仓由 Worker 直接读写，是系统的**唯一数据源**。

**单据为什么按年切文件**：采购单是全仓唯一只增不减的大文件（416 张单 371KB），整表存储时每保存一张单都要把整表重读、重编码、重新提交一次。切成年片后，一次保存只重写改动的那一年（实测：改一张历史单 = 1 次内容写）。粒度选「年」而不是「月」是因为读侧要读全量，月片 = 92 个文件 = 92 个子请求，会直接顶爆 Workers 免费版每请求 50 个子请求的上限；年片 = 10 个文件，全量读 12 个子请求。

> ⚠️ 迁移是自动发生的：第一次通过 API 保存单据时，Worker 会在**同一次 git 提交**里写完所有年片、写 `.split-yearly.json`、并删除旧的 `purchases.json` / `sales.json`。
> 所以**任何直读数据仓的脚本都不能依赖 `purchases.json` / `sales.json` 这两个文件名**，
> 正确口径见下「只想读数据」。判据文件缺失（`.split-yearly.json` 不存在或该集合未记录）时，旧整表仍然是唯一权威。

历史采购价**不在数据仓里单独存文件、也不内嵌进 `items.json`**，由 `GET /api/purchase-history` 每次从单据现场派生（见「自动推导」）。

## AI / 脚本对接（接口契约）

**唯一原则：读写一律走 HTTP API，不要直接改数据仓 JSON。** 直写会绕过三件事，而且系统不会自动帮你修：

1. `derive()` —— 商品档案、供应商/客户链接、历史价的重建（直写 `purchases.json` 后库存与历史价不会更新）；
2. `normalizeOrderPayments()` —— 「`payments:[]` + 旧 `paid`/`received`」造成的实付漏算；
3. 资金单据编号分配 —— 手工拼 `SK-`/`FK-` 极易重号或跳号。

只读数据仓是可以的，见本节末尾「只想读数据」。

### 方式一：AI-API 密钥（推荐给 AI）

左侧菜单 **AI-API** → 新建密钥，勾选它能做的事（可一键「最大权限」，可设永久），
把 `ai_live_…` 密钥和基址 `https://stock-git-ai.1234.nyc.mn/api/ai/v1` 交给 AI 即可。
它只能在你勾选的范围内读写：越权 403，吊销最长 15 秒生效；AI 永远无法管理密钥、改密码、备份或清空数据。
完整契约（权限表、接口、参数、示例、给 AI 的提示词）见 [docs/ai-api.md](./docs/ai-api.md)。

下面这一节是**方式二：管理密码票据**，权限等同管理员，适合你自己的脚本，不建议直接交给 AI。

### 基址
| 用途 | 地址 |
|---|---|
| 前端 | `https://stock-git-ai.1234.nyc.mn/` |
| API | `https://stock-git-ai.1234.nyc.mn/api` |
| 备用 | `https://stock-git-ai.dakcl.workers.dev/api`（`*.workers.dev` 国内常被干扰，优先自定义域名） |

### 鉴权
```bash
# ① 取票据（唯一无需票据的接口）
TOKEN=$(curl -s -X POST https://stock-git-ai.1234.nyc.mn/api/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"<管理密码>","remember":true}' | jq -r .token)

# ② 带票据调用任意接口
curl -s -H "Authorization: Bearer $TOKEN" https://stock-git-ai.1234.nyc.mn/api/sales

# ③ 票据是否仍有效
curl -s -H "Authorization: Bearer $TOKEN" https://stock-git-ai.1234.nyc.mn/api/session   # → {"ok":true}
```
- `remember:true` 票据 30 天有效，省略或 `false` 为 12 小时；`expiresIn` 为毫秒时长。
- 票据格式 `base64url(payload).base64url(HMAC-SHA256)`，脚本**原样存取复用**即可，不要解析或自行伪造（密钥 `SESSION_SECRET` 只存在于 Worker Secret）。
- 管理密码是 Worker Secret `APP_PASSWORD`，不在仓库里，向系统所有者索取。
- **401** = 票据缺失/过期 → 重新登录；**429** = 同一来源密码连错 6 次，锁定 15 分钟（响应里带剩余秒数）。
- CORS 只约束浏览器跨域，curl / Node / Python 脚本不受影响。
- 读接口有 **15 秒缓存**（Worker 边缘 + CDN 双层）：同一边缘节点写完会自动失效，跨节点/换会话可能读到写前的旧值。**写完要立即校验就带 `-H 'Cache-Control: no-cache'`**（前端写后 20 秒强刷窗口就是这么做的），仍不放心就等 15 秒、或改读 GitHub 数据仓原文。
- **没有 `PUT` / `PATCH` / `DELETE`**：写只有 `POST`，「删除一条记录」＝写回去掉它的全量数组（删单据后服务端会重跑派生，自动回退库存与历史价）。用其它方法会得到 404。

### 读接口（GET，均需票据）
| 路径 | 返回 | 说明 |
|---|---|---|
| `/items` | 商品数组 | **不含** `purchaseHistory` / `saleHistory`（均已外置）；只保留去重后的 `saleCustomers`（买过该商品的客户名数组） |
| `/purchase-history` | `{ "P00001": [{ id, date, supplier, supplierName, qty, price, total }] }` | 历史采购价，服务端现场按采购单派生，按商品编码取，组内已按日期倒序 |
| `/sale-history` | `{ "P00001": [{ id, date, customer, qty, price, total }] }` | 历史销售价，服务端现场按销售单派生，按商品编码取，组内已按日期倒序 |
| `/suppliers` / `/customers` | 档案数组 | 客户带 `deposits`（预存款）、供应商带 `advances`（预付款）流水，元素为 `{ date, amount, remark, order, time }`：**抵扣为负数**，`order` 是该笔所属的单号标记（系统按它幂等重建，手工加/删流水时不要漏掉或乱填） |
| `/purchases` / `/sales` | 单据**全量**数组 | 含 `payments` 收付款流水 |
| `/receipts` / `/payment-vouchers` | 资金单据**全量**数组 | 收款单 `SK-` / 付款单 `FK-`；**文件不存在时返回 `[]`**（老数据仓里可能没有这两个文件，首次开单自动创建），其余主数据缺失仍照常报错 |
| `/stock` | `{ "P00001": { qty, cost } }` | 派生数据，只读 |
| `/orders` | 订单数组 | **文件不存在时返回 `[]`**（见「订单（预售 / 预订）与过账」）；草稿不在 `purchases` / `sales` 里，因此不占库存、不进应收应付 |
| `/logs` | 数组 | 最近 200 条导入/合并日志，`source` 为 `ai` 或 `merge` |
| `/session` | `{ ok }` | 票据自检 |
| `/profile` | `{ name, phone, address, remark }` | 用户信息（打印落款用），未填过返回四个空字符串 |
| `/shares` | `{ shares: [...] }` | 外链分享列表（含已过期 / 已作废 / 单据已删除的记录），按创建时间倒序 |
| `/templates` | `{ templates: [...] }` | 订单模板列表，元素 `{ id, name, kind, items:[{code,name,unit,qty,price,discountRate}], createdAt, updatedAt }`；**文件不存在时返回 `[]`**，模板本身不存金额 |

返回体是**裸数组 / 裸对象**（不包 `data` 壳）；失败统一是 `{"error":"中文原因"}` + 4xx/5xx，脚本按 `res.ok` 判断即可。

### 公开读接口（GET，**不需要票据**）
| 路径 | 返回 | 说明 |
|---|---|---|
| `/share/<token>` | 只读载荷 `{ readOnly, kind, share, doc, lines, totals }` | 供 `/share/:token` 公开页展示。**只返回单据的展示口径**：`token` 为 36 位十六进制随机串，格式不合法直接 `404`；已过期 `410`；单据被删除或作废 `404`。**不含**进价 `cost`、`payments` 流水、照片、往来单位的联系方式等内部字段。|

### 写接口（POST，均需票据）
| 路径 | 请求体 | 落库后的额外动作 |
|---|---|---|
| `/items` | `{"items":[全量数组]}` | 反向同步 `suppliers[].products` |
| `/suppliers` | `{"suppliers":[全量数组]}` | — |
| `/customers` | `{"customers":[全量数组]}` | — |
| `/receipts` | `{"receipts":[全量数组]}` | 纯资金单据，不触发派生 |
| `/payment-vouchers` | `{"payment-vouchers":[全量数组]}`（**键名带连字符**） | 纯资金单据，不触发派生 |
| `/purchases` | `{"purchases":[全量数组]}` | 规范化流水 → `derive()` → `rebuildStock()`，回写 `items/suppliers/stock` |
| `/sales` | `{"sales":[全量数组]}` | 同上，并为单里出现的新客户自动建档 |
| `/normalize` | `{}` | 全量重跑派生，修复编码/历史价/库存漂移。**幂等，改完数据仓后调一次即可** |
| `/import` | `{"text":"<整份 JSON 的字符串>"}` | 见下方「导入」 |
| `/import-merge` | `{"key":"items","records":[...]}` | 按主键去重后**追加**，不覆盖已有数据；`key` 可取 `items / customers / suppliers / purchases / sales / receipts / payment-vouchers / orders / refunds`，主键为编码（档案、资金单据、退款凭证）或单号（单据、订单），客户/供应商另按名称查重；返回各项计数 `{ ok, added, skippedKey, skippedName, invalid, total }` |
| `/orders` | `{"action": "save" / "remark" / "deposit" / "post" / "unpost" / "delete" / "deleteMany" / "clearDrafts" / "migrateStatus" / "restore", …}` | **操作接口，不是整表覆盖**，请求体形状与闸门规则见 [docs/orders.md](docs/orders.md)。只有 `post` / `unpost` 才跑 `derive()` + `rebuildStock()`（存草稿、收订金、改备注不重写 200KB 的 `items.json`）；`restore` 仅供备份恢复，整表替换 `orders` 且不派生 |
| `/refunds` | `{"action": "create" / "settle" / "backfill" / "restore", …}` | **操作接口**，见 [docs/refunds.md](docs/refunds.md)；`restore` 仅供备份恢复，整表替换退款/核销凭证（退款是凭证、不影响库存，故不派生） |
| `/amends` | `{"kind","requestId","sourceOrderId","party","date","reason","mode","refundLines":[{index,qty}],"amendLines":[{code,name,unit,qty,price}]}` | **操作接口**：原单不动，减少的商品生成退货单（复用退款四档资金处理）、增加的商品生成补差单，一次提交落库；`requestId` 幂等，金额一律服务端重算 |
| `/voids` | `{"kind":"sale"\|"purchase","id":"单据号","reason":"可选"}` | **操作接口**：整单作废并同步作废关联的 `SK-`/`FK-`，一次提交回滚库存/应收；重复作废幂等；子单/核销/合并凭证未拆时 `409`。详见 [docs/void.md](docs/void.md) |
| `/profile` | `{"name","phone","address","remark"}` | 整份覆盖写入 `profile.json`；服务端逐字段裁剪空白并限长（40 / 60 / 160 / 200），多余字段丢弃 |
| `/shares` | `{"action": "create" / "cancel" / "update", …}` | **操作接口**，见 [docs/shares.md](docs/shares.md)。`create` 需要 `{kind, docId, days}`（`days` 取 `1/7/30`，`0` 为长期），同一张单已有有效链接时**复用**并返回 `reused: true`；`cancel` 需要 `{token}`；`update` 需要 `{token, days}`（按「现在」重新起算）|
| `/templates` | `{"action": "create" / "update" / "delete" / "duplicate", …}` | **操作接口**，见 [docs/templates.md](docs/templates.md)。只写 `order-templates.json`，不碰单据；`create`/`update` 传 `{template:{id?, name, kind, items}}`，`delete`/`duplicate` 传 `{id}`；上限 100 个模板、单模板 200 行 |
| `/upload` | `multipart/form-data`，字段名 `file` | 转发图床，返回 `{"url":"https://…"}`；≤10MB，仅 `image/*` |
| `/stock` | 任意 | **403**：库存为派生数据，禁止直写 |

- **`POST` 是「整表覆盖」语义，不是 upsert。** 改一张单也必须「读全量 → 只改那一条 → 写回全量」；只传增量会把历史数据全部抹掉。读失败时**绝对不要写**（前端有 `loadFailed` 保护，脚本同理）。
- 并发写没有跨文件事务：两个客户端同时写同一文件，后写的会拿到 `500 {"error":"GitHub 409: ... "}`，且服务端**故意不重试**（重试等于用旧全量覆盖对方）。收到 409 请重新读、重新算、再写。
- 单据最小必填：`id`（单号 19 位，见「编码规则」）、`date`、`total`、`items:[{code,name,qty,price,total}]`；采购另需 `supplier`（名称），销售另需 `customer`（名称）。
- `payments` 数组一旦存在（哪怕为 `[]`）就是实收/实付的权威来源，旧 `received`/`paid` 字段被忽略。要么不写 `payments`（旧格式），要么写全。
- **写完流水必须同步汇总字段**：`received`/`paid` = Σ`payments[].amount`，`settle` = 「未收/未付 ≤ 1e-6 ? `结清` : `挂账`」。服务端不会替你算这两项（前端靠 `syncPayments()`），不同步就会出现「流水对、列表汇总错」。
- 若目标单据**还没有** `payments` 数组但 `received`/`paid > 0`，先把旧字段转成一笔 `{ date: 单据日期, amount: 旧值, remark: '历史收付', time: '' }` 再追加新流水；直接写 `payments:[新流水]` 会把旧实付清零、凭空多出欠款（历史上真出过这种事故）。
- 金额请自己保证 2 位小数；服务端 `derive` 会收敛浮点残留，但不会替你四舍五入 `payments[].amount`。
- 不要写 `payments[].mid`（前端一次性定位标记，落库前会被剥掉）；写 `items[].purchaseHistory` 也会被剥掉。

**导入接口 `/import`**：`text` 是**字符串**（整份 JSON 文本），识别键 `items / suppliers / customers / purchases / sales / receipts / payment-vouchers`，逐个**整表覆盖**（传哪些键覆盖哪些，未传的不动）；`stock` 键会被忽略（库存一律由单据重建）。上限：文本 1MB、单类 5000 条、记录必须是对象，否则 400 中止。非 JSON 文本走行式解析，仅识别 `商品: 编码 名称 单位`、`供应商: 编码 名称`、`客户: 编码 名称` 三种行。每次导入会往 `logs.json` 追加一条 `{time, source:"ai", results}`。**未过账订单与退款/核销单不在 `/import` 的识别键里**（它们是操作型集合，没有整表写接口），「数据管理 → 全量导入」由前端在写完其余 7 类后，分别调用 `POST /api/orders` / `POST /api/refunds` 的 `restore` 动作整表写回。

### 资金单据（`SK-` / `FK-`）结构
```json
{
  "code": "SK-20261028-0001",
  "kind": "receivable",
  "category": "normal",
  "party": "张三",
  "date": "2026-10-28",
  "remark": "收款",
  "total": 300,
  "items": [
    { "orderId": "X202610280930000001", "orderType": "sale",
      "amount": 300, "discount": 0, "settle": false, "note": "" }
  ]
}
```
- `kind`：`receivable`（收款单，存 `receipts.json`）/ `payable`（付款单，存 `payment-vouchers.json`）。
- `code`：`SK-`/`FK-` + `YYYYMMDD`（凭证日期）+ 4 位序号；序号 = **当天同前缀已有最大序号 + 1**，不用全局计数器。
- `category` 只用于列表/抽屉展示区分，不参与金额计算：`normal`（收付款）、`deposit-recharge`（预存/预付充值）、`deposit-over`（超额收付转存）、`deposit-deduct`（用预存款/预付款抵扣货款的划转）。后两类允许 `items[0].orderId` 为空串（纯资金变动，不挂单号）。
- **一张凭证可覆盖多张单据**：`items[]` 多条，`total` = Σ`items[].amount`；反方向的对应关系靠单据流水里的 `payments[].voucher` 回写，即**一笔流水 ↔ 一张凭证**。
- 红线：**钱只要动了就必须有凭证**；纯抹零优惠（钱没动）不生成凭证，也不占用编号。

### 脚本代收款的标准顺序（与前端 `savePaymentWithVouchers()` 完全一致）
1. `GET /sales` + `GET /receipts`（都是全量）；
2. 按 `SK-YYYYMMDD-` 前缀算出下一个（若干）编号，直接写进这笔 `payments[].voucher`；
3. `POST /sales`（整表，此时流水已带凭证号）；
4. `POST /receipts`（整表 + 新凭证）。

**顺序不能反**：先写凭证再写流水，要么多一次整表覆盖，要么留下「流水有凭证号、凭证却不存在」的悬挂记录。第 3 步失败就不要执行第 4 步；第 4 步失败必须显式报错并补开，不能静默。

### 账务公式（脚本核算欠款必须同口径）
```
等效折扣率 = discountRates[] 连乘（缺失/非法按 1；兼容旧标量 discountRate）
应收/应付  = round2(max(0, round2(total × 等效折扣率) − discount))
实收/实付  = round2(Σ payments[].amount)          // payments 存在即为权威
未收/未付  = max(0, 应收/应付 − 实收/实付)
结清       = 未收/未付 ≤ 1e-6                      // settle 字段仅供展示，欠款一律按金额算
```
全站唯一实现是 `src/utils/account.js`（`grossOf` / `netOf` / `isSettledOf`），不要另写一套。

### 只想读数据（没有写权限时）
直读私有仓 `idakcl/stock-git-ai-data@main` 的 JSON 完全可以，但注意：
- **单据要先看分片判据**：读 `.split-yearly.json`（内容形如 `{"purchases":true,"sales":true}`）。
  该集合被记为 `true` → 单据在 `purchases-YYYY.json` / `sales-YYYY.json` 里，把**所有**年片读出来按 `date`、再按 `id` 升序合并就是全量（年片可能是 `[]`，那是该年单据被删完后的空片，不是错误）；
  没被记录（或整个判据文件不存在）→ 权威仍然是旧的 `purchases.json` / `sales.json` 整表，**这些年片要一律忽略**（它们可能只是迁移到一半的残留）。
  两种情况下都只有一份是真数据，绝不把整表和年片相加。
- `stock.json`、`suppliers[].products`、`items[].saleCustomers` 都是派生值，写入按 `单据 → items → suppliers → stock` 分步提交（无跨文件事务），理论上可能与最新单据差一次提交。**对账一律以单据为准**，按上面的公式自己重算。
- 历史采购价**不在** `items.json` 里。要么调 `GET /api/purchase-history`，要么自己按采购单 `items[]` 聚合成 `{ 商品编码: [行] }`。
- 历史销售价同样**不在** `items.json` 里。要么调 `GET /api/sale-history`，要么自己按销售单 `items[]` 聚合成 `{ 商品编码: [行] }`。
- `items.json` 里的空字段不落库（`package / warning / priceWholesale / priceInstaller / remark / saleCustomers / photos` 为空时整个键都被删掉）。读的时候按「缺键 = 空值」处理：`it.warning || 0`、`it.photos || []`。
- `orders.json` **可能整个文件都不存在**（订单是新上线的集合，没人存过草稿就没有这个文件）。把它当可选集合读：`orders || []`，并记住**这里的草稿不算账**——库存、应收、报表一律只看 `purchases-*` / `sales-*`。
- 若发现 `payments: []` 而 `paid`/`received > 0`，那是外部直写产生的脏数据（实付会被算成 0、虚增欠款）：请调 `POST /api/normalize` 让服务端补成流水。

### Node 端最小可用示例
```js
const BASE = 'https://stock-git-ai.1234.nyc.mn/api'
let token = ''
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100

async function get(path) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)   // 401 → 重新登录再试
  return data
}
async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

token = (await post('/login', { password: process.env.STOCK_PWD, remember: true })).token

// 给销售单收款 300 元，并生成一张收款单
const saleId = 'X202610280930000001', today = '2026-10-28', amount = 300
const [sales, receipts] = await Promise.all([get('/sales'), get('/receipts')])
const i = sales.findIndex(s => s.id === saleId)
if (i < 0) throw new Error('单号不存在')
const sale = sales[i]

// ① 预分配凭证编号：当天同前缀最大序号 + 1
const head = `SK-${today.replace(/-/g, '')}-`
const maxNo = receipts.reduce((m, v) => (typeof v.code === 'string' && v.code.startsWith(head))
  ? Math.max(m, Number(v.code.slice(-3)) || 0) : m, 0)
const code = `${head}${String(maxNo + 1).padStart(3, '0')}`

// ② 流水：旧单没有 payments 时，先把 received 补成「历史收付」再追加（否则旧实付被清零）
const payments = Array.isArray(sale.payments) ? sale.payments.slice()
  : Number(sale.received || 0) > 0
    ? [{ date: sale.date || today, amount: Number(sale.received), remark: '历史收付', time: '' }]
    : []
payments.push({ date: today, amount, remark: '收款', time: new Date().toISOString(), voucher: code })

// ③ 同步汇总字段（服务端不替我们算）。带折扣链的单据，应收还要乘等效折扣率
const received = round2(payments.reduce((s, p) => s + Number(p.amount || 0), 0))
const due = round2(Math.max(0, round2(Number(sale.total || 0) - Number(sale.discount || 0)) - received))
sales[i] = { ...sale, payments, received, settle: due <= 1e-6 ? '结清' : '挂账' }

await post('/sales', { sales })                        // 先流水（已带凭证号）
await post('/receipts', { receipts: [...receipts, {    // 再凭证；这步失败必须报错补开，不能静默跳过
  code, kind: 'receivable', category: 'normal', party: sales[i].customer,
  date: today, remark: '收款', total: amount,
  items: [{ orderId: saleId, orderType: 'sale', amount, discount: 0, settle: due <= 1e-6, note: '' }]
}] })
console.log('已生成收款单', code, '｜本单未收', due)
```
> 生产代码请优先复用 `src/utils/voucherFlow.js`（`allocVoucherCodes` / `attachPaymentVouchers` / `savePaymentWithVouchers` / `voucherNotices`）——编号预分配、`settle` 计算、失败分 `stage` 提示都已处理好，且是可单测的纯逻辑。

### 对接前必读的变更
- **2026-10-30｜整单折扣展示升级**：单头「整单折扣」在详情页与 A4 打印中加框高亮（`headerFields` 第三位传 `'hl'` → `.f.hl`）。明细新增**「折后金额」**：用 `allocateNetOf` 按累计四舍五入把整单折扣摊到每行，各行合计恰好等于单头折后金额；订单 / 销售单 / 采购单的详情页、单张打印与 CSV 同步。没有行级折扣时自动隐藏「折扣率 / 本次折扣（折扣金额）」列，避免整列都是 0。
- **2026-10-30｜明细重复商品提示 + 订单打印副标题去掉状态**：订单 / 销售单 / 采购单在「快速添加」里再次录入同一商品时，弹出「**本商品已录入**」，提供「定位到已录入商品」（滚动到那一行并**蓝色外框闪烁两下**）与「再次添加」（允许同一商品出现多行）两个选择。打印订单时**副标题只保留「共 N 项商品」**，不再拼接订单状态（单头「状态」字段仍保留）。
- **2026-10-30｜订单状态统一「未过账」+ 备注 + 列表打印截断**：订单状态**库内存储值**由「草稿」改为「**未过账**」（`DRAFT = '未过账'`）。`POST /api/orders` 新增 `migrateStatus`（历史「草稿」一次性改写，幂等、无旧值不提交；订单页打开时自动调用一次）与 `remark`（只改备注，已过账订单也能改，≤500 字，空串＝清空）；`restore` 导入旧备份时把 `status:'草稿'` 归一化为「未过账」。订单列表每行新增「备注」按钮，订单详情页备注行旁新增「添加/编辑备注」按钮，与采购/销售详情页同一套弹窗。打印**订单列表 / 销售单列表 / 采购单列表**时，商品名称或编码超过 3 个只留前 3 个并以「…」结尾（`joinLimited`），CSV 导出仍为完整清单。
- **2026-10-30｜订单支持打印与导出**：订单页单张订单提供「打印(A4)」与「CSV」——A4 单头带订单号/业务单号/往来单位/状态/关联单据，明细含行折扣率、折扣金额与折后金额，合计含原价、整单折扣链、整单优惠、订金与未收(未付)；列表工具栏按当前页导出 CSV / A4。新增**订单详情页 `/order/:id`**（点订单号进入），带「隐藏单价与金额 / 显示售价 / 显示进价 / 展开历史价与商品档案 / 对外查看（隐藏价格·只读）/ 显示客户(供应商)信息详情」六个勾选，打印与导出严格跟随勾选。订单号下方直接显示业务单号，并纳入关键词搜索与导出列。订单列表**默认只看未过账订单**（状态下拉：显示全部 / 仅未过账 / 仅已过账），首列勾选后支持**打印勾选订单列表**、**打印勾选订单详情页**（可选直接打印 / 隐藏金额打印，后者单价与全部合计都不出现）与**批量删除**（`deleteMany` 一次提交，已过账 / 已收订金自动跳过）；原「清空草稿」更名为「清空未过账订单」。所有 A4 打印的明细表最前面增加「序号」列（1、2、3 顺排）；隐藏金额打印不再显示状态与「金额已隐藏」，第二行只留「共 N 项商品」。
- **2026-10-30｜备份纳入订单与退款**：数据管理「全量导出 / 导入」由 7 类扩为 **9 类**（新增 `orders` / `refunds` 键），分类导入导出同样多出「未过账订单 / 退款核销单」两行；写回走 `POST /api/orders` / `POST /api/refunds` 的 `restore`（整表替换、形状校验、内容相同不提交），`/import-merge` 新增 `orders`（按 `id`）/ `refunds`（按 `code`）去重。**旧备份没有这两个键时前端不调用 restore，现有订单与退款凭证保持不动。**
- **2026-10-30｜单据作废上线**：`POST /api/voids` 作废销售单/采购单，并同步作废关联的 `SK-`/`FK-`。单据与凭证都保留（`status:"作废"`），但库存、应收应付、实收实付、历史价、往来账、看板/报表全部按 0 处理。**脚本统计必须先过滤作废单**；合并收款的凭证、有退货子单/核销记录的单会被 `409` 拦下。详见 [docs/void.md](docs/void.md)。
- **2026-10-30｜明细行折扣**：订单与正式单据的 `items[]` 增加 `discountRate` / `discount` / `total`（折后）三件套，订单弹窗每行可单独折扣；过账时原样搬进单据。
- **2026-10-29｜新增订单与单据变更两个操作接口**：`GET/POST /api/orders`（草稿住 `orders.json`，**文件不存在返回 `[]`**，不参与库存与应收派生）与 `POST /api/amends`（已动过钱的单增减商品 → 生成 `XT-`/`CT-` 退货单 + `XA-`/`CA-` 补差单，原单不动）。**两者都不是整表覆盖**，脚本按「读全量 → 改一条 → 写回全量」的老套路调它们会直接 400。销售/采购单可能开始出现 `type: 'sale-amend'` / `'purchase-amend'` 与 `sourceOrderId`、`fromOrderId` 字段，统计时注意：补差单是正数正常单，退货单是负数红字，两者都算进「单族」的净成交。详见 [docs/orders.md](docs/orders.md)。
- **2026-10-29｜历史销售价外置**：`items.json` 不再内嵌 `saleHistory`，改由 `GET /api/sale-history` 按需返回；商品上只保留去重后的 `saleCustomers`（客户名数组），供商品页按客户筛选和销售价带出。任何读 `items[].saleHistory` 的脚本必须改调接口或自行聚合。
- **2026-10-28｜`items.json` 瘦身**：不再内嵌 `purchaseHistory`，改由 `GET /api/purchase-history` 按需返回（实测 `items.json` 体积 **−62.7%**）。任何读 `items[].purchaseHistory` 的脚本必须改调接口或自行聚合。
- **2026-10-28｜资金单据全链路联动**：收付款、结清、预存预付抵扣/充值/超额转存都会成对写入「单据流水 + 资金凭证」，`payments[].voucher` 现在稳定有值（此前常为空，脚本别把它当可选字段忽略）。


## 保存链路与错误处理

一次「保存」的完整链路：**页面按钮 → 前端 `src/api/index.js` → Worker `web/index.js` → `api/routes.js` → `api/github.js`（GitHub Contents API）→ 数据仓 JSON 提交**。

- **后端不静默**：GitHub 读写任何一步失败（token 失效、仓库不存在、网络异常、5xx），`gh()` 都会抛出带状态码的错误（如 `GitHub 401: Bad credentials`），由 `handleApi` 统一捕获并返回 **HTTP 500 + 明确 error 文案**，前端 `request()` 收到非 2xx 即抛错。
- **前端明确报错**：所有保存/删除/登记收付款函数均有 try/catch，失败时弹出红色错误提示（含后端错误原因），**不显示"已保存"假成功**，弹窗保持打开可重试，同时本地列表回滚为线上数据，避免界面与数据仓不一致。
- **瞬时故障重试**：`writeJSON` 对网络异常、GitHub 5xx 与 429（限流）自动重试一次（重试前重新获取文件 sha）；**409 不重试**——那说明确实有人并发改过该文件，用本端旧全量重试会覆盖对方写入，宁可报错；其余 4xx（鉴权/参数错误）立即失败。
- **无变化不提交**：`writeJSON` 拿到现有内容后先逐字节比对，相同就跳过提交。保存一张单据会派生写回 `items/suppliers/stock` 与单据年片等多个文件，跳过重复提交可显著减少无谓 commit 与 GitHub 写入压力。这条比对依赖「本轮刚读到的原文」：`readJSONWithRaw` / `writeCollection` 会把读到的 `content` 与 `sha` 作为 `known` 一路传给后续写入，省掉「每个文件再 GET 一遍只为拿 sha」的重复请求与整文件 base64 解码（实测约占一次存单读侧成本的一半）。落库次序统一为 `date` 升序、同日按 `id` 升序（`sortOrders`），读写同口径，「读回来原样再存一次」才能真正命中跳过分支（实测：原样重存 = 0 次提交、0 次内容写）。
- **单据按年分片**：`purchases` / `sales` 不再整表一个文件，改为 `purchases-2025.json` 一年一片（`api/storage.js`），只有内容真变了的那一片才提交；改一张历史单据只重写它那一年的片。权威判据是 `.split-yearly.json`：没记录 → 旧整表有效（分片一律忽略），有记录 → 年片有效（旧整表已在迁移提交里删除）。迁移由第一次存单自动触发，两个集合 + 标记 + 删除旧表压进**同一次 git 提交**（`api/github.js` 的 `commitFiles`：列基线根 tree → 未变动条目按 sha 引用、变动条目带内容、要删的条目不列 → `git/trees` + `git/commits` + `refs PATCH force:false`），不存在「标记写了但年片只写一半」的中间态，并发迁移会被拒绝而不是覆盖。注意：**不能用 `base_tree` + `{ path, content: null }` 做删除**，GitHub 实测回 422 `Must supply either tree.sha or tree.content`（这个写法曾让整仓迁移每一次都静默失败，被 `.catch(() => {})` 吞掉），所以要提交的是「完整树」而不是补丁。
- **items.json 瘦身（历史采购价与销售价外置）**：`items.json` 曾内嵌每个商品的历史采购价，实测 1559 个商品 / 2450 行历史约占整个文件 **62.7%**（0.91MB → 0.34MB，紧凑 JSON 口径），而这些数据 100% 可由采购单重建、且只有商品行「展开历史价」时才用到。现改为 `derive()` 不再写 `商品.purchaseHistory`（存量数据在下次存单时自动清除），改由 `GET /api/purchase-history` 按需返回 `{ 商品编码: [历史行] }`。销售历史同理：`商品.saleHistory` 不再落文件，改由 `GET /api/sale-history` 按需返回，`items.json` 只保留去重后的 `saleCustomers`（客户名数组）。两个接口与 `derive` 同源同口径；前端 `ProductTable` 首次展开任意商品行时才请求一次（走 15 秒内存缓存 + 边缘缓存），销售录入弹窗在打开时拉取销售历史用于「该客户最近成交价」。
- **整表覆盖的红线**：单据保存语义是「提交整个数组覆盖」，因此前端（`Sales.vue`/`Purchases.vue`）在提交前必须确认本地是线上全量——加载失败会标记 `loadFailed`，保存时先 `ensureLoaded()` 重新拉取，仍失败就**拒绝保存并明确报错**（否则会用「只有这一张新单」的数组覆盖掉全部历史单据）。加载失败时列表也不再清空，写库后的回读失败同样不影响已成功的写入。
- **录入校验不得静默**：明细里的空白行（未选商品且未填任何值）不再拦下整单，「快速添加」会优先填入第一个空白行而不是追加，避免残留空行导致「点保存没反应」；填了数量/单价却没选商品的行会指明第几行。校验提示统一停留 5 秒。
- **多文件写入说明**：保存采购单/销售单会分步写入 `purchases/sales.json` 及派生文件（`items/suppliers/stock.json`，共 4 次提交），GitHub Contents API 无跨文件事务，理论上存在"主单据已存、派生文件失败"的部分写入。派生逻辑（`derive`/`rebuildStock`）是**由单据重建的纯函数、幂等**，此时页面会明确提示"请重新保存一次该单据自动修复"，不会悄悄丢数据。
- 验证方式：可用无效 token 调用 `POST /api/items`，应返回 `500 {"error":"GitHub 401: Bad credentials"}` 而非 200。
- **回归测试（纯 Node，不碰线上仓）**：`node tests/storage-test.mjs`（27 项，存储层：归年规则、迁移原子性、幂等跳过、删空年片、资金保护、并发 409、>1MB blob 回退、commitFiles 一次提交增删改）、`node tests/api-test.mjs`（13 项，直接调 `handleApi`，以真实数据仓为底跑「存一张单 → 迁移 → 原样重存 0 提交 → 改历史单只写当年片 → 退货退款」全链路，并守住一次请求 50 子请求的上限）、`node tests/account-test.mjs`（27 项，账务口径：`grossOf` 总额 ≠ 余额、`overpaidOf` 红线①、`settleBalance` 结清联动、多级折扣链）、`node refund-test.mjs`（11 项，退款核销 + 历史补凭证；夹具里两张历史退货单的 id 已同步 `4f5f243` 的编码改名 `T2026051912000000x → CT-20260519-000x`，此前该用例一直红——代码按新 id 定位、测试还在造旧 id）、`node deposit-test.mjs`（9 项）、`node tests/orders-test.mjs`（16 项，订单状态机 / 订金凭证 / 撤销闸门 / 孤儿订单 / 清空草稿 / 批量删除 / 状态值统一与 `migrateStatus` / 备注 / `restore` 整表恢复）、`node tests/amend-test.mjs`（9 项，明细 diff 与 `applyAmendOperation`）、`node tests/refund-reason-test.mjs`（3 项，退货原因非必填：留空 / 只填空格落库记「无」，填了去首尾空白）、`node tests/orders-api-test.mjs`（18 项，`/api/orders` 与 `/api/amends` 全链路，含备注、状态迁移与旧备份归一化）、`node tests/void-test.mjs`（13 项，作废纯函数：归零/凭证同废/库存回滚/预存退回/闸门/幂等/订单回退）、`node tests/void-api-test.mjs`（7 项，`/api/voids` 全链路：一次提交、年片口径、404/409 不落库）、`node tests/backup-api-test.mjs`（9 项，备份恢复：`restore` 订单/退款一次提交且不动库存、空表清空、非法/重复整表拒绝、`import-merge` 对订单与退款按单号/凭证号去重）。这些接口类用例都用 `tests/fake-github.mjs` 这个内存版 GitHub（照抄 `>1MB 不返回 content`、`sha 不符 409`、`refs PATCH force:false`、`POST /git/trees` 条目必须「sha 与内容二选一」（`content: null` 一律 422）、`不传 base_tree 即提交完整树` 语义），所以 409/覆盖/API 用法类缺陷能在本地就被抓到。
- **真浏览器回归（弹窗时序与「肉眼看到的对不对」，纯 Node 测不出来）**：先起 dev server `npx vite --port 5173 --strictPort --host 127.0.0.1`，再 `node tests/settle-link-browser-test.mjs`（5 项，结清联动）、`node tests/amend-browser-test.mjs`（14 项，明细锁定 + 变更明细弹窗 + 订单页 + 看板待过账卡片 + 清空草稿 + 菜单顺序 + 菜单角标对齐）、`node tests/void-browser-test.mjs`（9 项，作废按钮/确认框 + 作废标记 + 详情页锁写 + 凭证打标与合计 + 订单行折扣 + 提示间距）、`node tests/backup-browser-test.mjs`（5 项，备份：分类表含订单/退款行、全量导出 JSON 含 9 类、全量导入按序调用含两个 `restore`、旧备份不含订单/退款时不误清、分类导入订单按单号去重）、`node tests/orders-print-browser-test.mjs`（4 项，订单打印/导出：列表 CSV 只导当前页且含业务单号、单张 A4 单头与折扣合计、单张 CSV 明细、已过账订单带关联单据号）、`node tests/orders-bulk-browser-test.mjs`（8 项，订单批量操作：默认只看未过账与三档下拉、历史「草稿」自动迁移、列表备注只提交 `remark`、只打印勾选订单、打印列表商品超过 3 个截断、详情直接打印每单分页、隐藏金额打印无任何金额、勾选批量删除一次 `deleteMany`）、`node tests/order-detail-browser-test.mjs`（10 项，订单详情页：默认只看本次数据、显示售价/进价、隐藏单价与金额、对外只读、供应商联系方式、展开历史价与商品档案、打印/CSV 跟随开关、备注框保存 `remark`）、`node tests/list-print-truncate-browser-test.mjs`（3 项，销售/采购/订单列表打印：商品名称或编码超过 3 个只留前 3 个 +「…」，CSV 仍完整）、`node tests/duplicate-item-browser-test.mjs`（4 项，明细重复商品：订单/销售/采购「快速添加」再次录入同一商品弹出「本商品已录入」、定位后蓝色闪烁不新增行、再次添加成两行）、`node refund-browser-test.mjs`、`node record-payment-browser-test.mjs`、`node timezone-browser-test.mjs`、`node tests/detail-discount-browser-test.mjs`（详情页行折扣与折后单价）、`node tests/unit-net-discount-browser-test.mjs`（9 项，折后单价含整单折扣：销售/采购/订单页面与打印 CSV 同步 + 打印跨页每页重复商品表头）、`node tests/line-batch-browser-test.mjs`（明细勾选框与批量折扣/批量删除）、`node tests/profile-share-browser-test.mjs`（19 项，打印落款、订单金额 xl 字号、分享弹窗与公开只读页）、`node tests/entry-page-browser-test.mjs`（7 项，整页开单表单：直达 `/xxx/new`、继承批量勾选、保存仍走列表页链路、出口是「返回」）、`node tests/entry-newtab-browser-test.mjs`（7 项，列表页不再有「新页面开单」按钮、`/xxx/new` 直达仍是无外壳整页、「返回」回列表）、`node tests/print-layout-browser-test.mjs`（22 项，打印版面：A4 基准 11px、A5 9.5px、每页行数按虚拟边距重算、xl＝1.2 倍加粗、分片数＝Chromium 真实页数且每页都带商品表头、跨页列宽一致（同一份 colgroup + fixed 布局）、「跨页表头」开关对 A4/A5 都生效并被记住）、`node tests/print-paper-browser-test.mjs`（17 项，纸张换算、按折行行数分页、虚拟边距下整页仍装得下、A4 纵向 / 自定义纸张 PDF 实测页数＝分片数、打印设置记住偏好、面板显示的自动行数与切片同口径、标头/商品行数拆解）、`node tests/templates-import-browser-test.mjs`（10 项，订单模板保存/编辑的 POST 与列表渲染、A4/A5/空表打印、订单页从模板导入后仍走新建保存）。全部用 `context.route('**/api/**')` 拦截成内存夹具，**不会写线上仓**。

## 读取性能优化（Phase 0）

Worker 入口 `web/index.js` 对所有 `GET /api/*` 响应加 `Cache-Control: s-maxage=15, stale-while-revalidate=30`，由 **Cloudflare 全局边缘缓存**接管读，把原本每次回源 GitHub（100–400ms）降到边缘 <10ms，并顺手把 GitHub 5000 次/小时共享 token 的限流压力移出热路径。

- **一致性保障**：写（`POST`）成功后，Worker 用 `caches.default.delete` 尽力清除同节点缓存；更关键的是**前端 `src/api/index.js` 在写入后开启 20s「强制刷新窗口」，窗口内的 `GET` 请求携带 `Cache-Control: no-cache` 绕过 CDN 边缘缓存**，确保保存后立即刷新能读到刚写入的数据，不会出现「保存成功却看不到新单」。
- **不涉及写路径与 AI 写入**：写永远直落 GitHub（唯一权威源），缓存只是只读副本、15s 自动回源，不产生数据分叉；AI 直读 GitHub 也不受影响。
- 所有缓存操作均包 try/catch，缓存层不可用即静默回源，绝不影响业务正确性。

## 编码规则

| 类型 | 格式 | 示例 | 生成方式 |
|---|---|---|---|
| 商品 | `P` + 5 位数字 | `P00001` | 取现有最大序号 +1（`src/utils/code.js` `nextEntityCode`） |
| 客户 | `C` + 5 位数字 | `C00001` | 同上 |
| 供应商 | `S` + 5 位数字 | `S00001` | 同上 |
| 采购单 | `C` + 年月日时分秒 + 本日 4 位流水 | `C202610111000000001` | `genOrderId('C', …)`，流水按单据日期当日计数 |
| 销售单 | `X` + 年月日时分秒 + 本日 4 位流水 | `X202610121330000007` | `genOrderId('X', …)`，流水按单据日期当日计数 |
| 销售退货单 | `XT-` + 年月日 + 4 位流水 | `XT-20261029-0001` | `genVoucherCode('XT', …, 4)`，流水按退货日期当日计数 |
| 采购退货单 | `CT-` + 年月日 + 4 位流水 | `CT-20261029-0001` | `genVoucherCode('CT', …, 4)`，流水按退货日期当日计数 |
| 销售补差单 | `XA-` + 年月日 + 4 位流水 | `XA-20261029-0001` | `genVoucherCode('XA', …, 4)`，「变更明细」追加商品时生成，与原单同集合（`sales`） |
| 采购补差单 | `CA-` + 年月日 + 4 位流水 | `CA-20261029-0001` | `genVoucherCode('CA', …, 4)`，同上，落 `purchases` |
| 订单（草稿） | `D` + 年月日时分秒 + 本日 4 位流水 | `D202610290930000001` | `genOrderId('D', …)`，与销售单同规则，只是前缀换成 `D`，一眼可辨「这不是账」 |

- 实体编码（P/C/S）新建时前端自动预填，可手动修改；AI 导入新建时由 `api/routes.js` 的 `derive()` 同规则生成。
- 单据号（C/X/D）在保存时自动生成，流水号为「本日开单流水号」，跨日自动归零。
- **脚本/批量补录历史单据也必须遵守同一规则**：单号固定 19 位（`C`/`X` + 8 位日期 + 6 位时分秒 + 4 位流水，共 19 个字符）。
  历史纸质单据无法获知录入时刻时，时分秒补 `000000`（同时便于识别为补录单），流水仍按「当日单据序号」4 位补齐；
  切勿简化为 `C` + 日期 + 3 位流水这类短格式，否则会导致单号长度不一致、下游历史价明细的单号链接难以对齐。

## 数据模型

### items.json（商品目录）
每个商品除了基础字段，还带有与供应商的关系链接和历史价：

| 字段 | 说明 |
|---|---|
| `code` / `name` / `unit` | 编码、名称、单位 |
| `cost` / `price` | 当前进价、当前售价 |
| `warning` | 库存预警值 |
| `package` | 包装规格，如 `"90个/件"` |
| `remark` | 备注（可选） |
| `suppliers` | **关联供应商 code 数组**，如 `["S00001"]` |
| `saleCustomers` | **买过该商品的客户名数组**（去重，仅用于商品页客户筛选）；历史销售价明细已外置到 `GET /api/sale-history`，历史采购价见 `GET /api/purchase-history` |

历史明细条目结构（由接口按单据现场派生，不落文件）：
```json
{
  "id": "X202610121146160003",
  "date": "2026-10-11",
  "supplier": "S00001",
  "supplierName": "湖南利接管件管阀贸易有限公司",
  "customer": "",
  "qty": 20,
  "price": 2.72,
  "total": 54.4
}
```
- 采购历史用 `supplier` / `supplierName`；
- 销售历史用 `customer`。

### suppliers.json（供应商）
| 字段 | 说明 |
|---|---|
| `code` / `name` | 编码、名称 |
| `contact` / `phone` | 联系人、电话 |
| `remark` | 备注（可选） |
| `products` | **关联商品 code 数组**，由商品 `suppliers` 反推（双向链接） |
| `advances` | **预付款流水**数组，元素 `{ date, amount, remark, order, time }`；抵扣为负数，`order` 为所属单号（幂等重建的标记） |

### customers.json（客户）
| 字段 | 说明 |
|---|---|
| `code` / `name` | 编码、名称 |
| `contact` / `phone` | 联系人、电话 |
| `remark` | 备注（可选） |
| `category` | 客户类别（如 `批发`），用于「客户类别 → 商品分级售价」取价；未定类别时留空字符串 |
| `deposits` | **预存款流水**数组，结构同 `advances` |

### orders.json（订单 / 草稿）
**独立集合，不在 `purchases` / `sales` 里**——库存与应收一律由那两个集合派生（`rebuildStock` 没有状态过滤），
所以草稿只有住在别的文件里才真的「不算数」。结构：

```json
{
  "id": "D202610290930000001",
  "kind": "sale",
  "customer": "客户甲",
  "date": "2026-10-29",
  "no": "",
  "remark": "",
  "photos": [],
  "items": [ { "code": "P00001", "name": "管件", "qty": 4, "price": 10, "total": 40 } ],
  "discount": 0,
  "discountRates": [],
  "status": "未过账",
  "postedOrderId": "",
  "deposits": [ { "date": "2026-10-29", "amount": 100, "remark": "订单订金", "time": "…", "voucher": "SK-20261029-0001" } ],
  "createdAt": "…", "updatedAt": "…"
}
```

- `kind` 取 `sale` / `purchase`，销售用 `customer`、采购用 `supplier`（与单据同名，过账时直接搬）。
- `status` 取 `未过账` / `已过账`；已过账时 `postedOrderId` 是过账生成的正式单据号。
  早期版本存成 `草稿` 的历史数据会在打开订单页时通过 `migrateStatus` 自动改写成 `未过账`，`restore` 导入旧备份时也会归一化。
- `deposits[]` 是订金流水，每笔都对应一张**已开**的资金凭证（`voucher`），因此收过订金的订单不能删。
- 采购单 / 销售单上的 `fromOrderId` / `fromOrderType: 'order'` 回指订单，双向可查。
- 完整状态机、订金与撤销闸门见 [docs/orders.md](docs/orders.md)。

### stock.json（库存）
按商品 code 为键：
```json
{ "S001": { "qty": 20, "cost": 2.72 } }
```
`qty` 为当前库存数量，`cost` 为最近一次采购进价。**该文件不再手工维护，由后端从单据推导**。

### purchases.json / sales.json（采购单 / 销售单）
单据明细是关系与历史价的**源头**，结构示例：
```json
{
  "id": "P...",
  "supplier": "湖南利接管件管阀贸易有限公司",
  "date": "2026-10-11",
  "items": [ { "code": "S001", "name": "三通国标25", "qty": 20, "price": 2.72,
               "discountRate": 0.9, "discount": 5.44, "total": 48.96 } ],
  "total": 736.2,
  "discount": 0,
  "paid": 736.2,
  "settle": "结清",
  "payments": [ { "date": "2026-10-11", "amount": 736.2, "remark": "历史收付", "time": "", "voucher": "FK-20261011-0001" } ],
  "remark": "备注内容（可选）"
}
```
- 采购单用 `supplier`，销售单用 `customer`（均为名称）；两者均可带 `remark`。
- `discount`（优惠）、`paid`/`received`（累计实付/实收）、`settle`（挂账/结清）见「账务规则」。
- `payments` 为**收付款流水数组**（销售单=收款流水，采购单=付款流水），每笔含 `date`（日期）、`amount`（金额）、`remark`（备注）、`time`（录入时间戳），见「多次收付款」。
- 流水另有两个可选字段：`voucher`（该笔对应的资金单据编号 `SK-`/`FK-`，见「资金单据联动」）、`fromDeposit: true`（该笔来自预存款/预付款抵扣，不是现金）。
- 明细行支持**行折扣**：`discountRate`（0~1，1＝原价）、`discount`（该行折扣金额）、`total`（折后小计 = `qty × price × discountRate`）。折扣只减钱、不改单价；整单折扣链与整单优惠在行小计之和上再作用。旧数据缺这三个字段时按「无行折扣」处理（`total = qty × price`）。
- 作废单保留原字段，另带 `status: "作废"`、`voidedAt`、`voidedReason`、`voidedVouchers`；`grossOf` / `receivedSumOf` / `paidSumOf` 对作废单返回 0，`derive` / `rebuildStock` 直接跳过。详见 [docs/void.md](docs/void.md)。
- **`settle` 的类型两处不同，别混用**：单据上的 `settle` 是**字符串** `挂账` / `结清`；资金单据 `items[].settle` 是**布尔值**（开凭证那一刻整单是否已结清）。

## 自动推导（核心机制）
保存采购单 `POST /api/purchases`、销售单 `POST /api/sales`、AI 导入 `POST /api/import` 后，后端自动调用 `derive()` + `rebuildStock()`（`api/routes.js`），从单据**重建**以下数据并回写 GitHub 数据仓：

1. `商品.suppliers` —— 供应商关系链接
2. `商品.saleCustomers` —— 买过该商品的客户名（去重）。历史销售价与历史采购价均不落文件，`derive()` 返回值 `saleHistory` / `history`（`{ 商品编码: [行] }`）分别供给 `GET /api/sale-history`、`GET /api/purchase-history` 按需返回
3. `供应商.products` —— 关联商品（与商品.suppliers **双向链接**）
4. `stock.json` —— 库存数量与最近进价

设计要点：
- **单一数据源**：所有关系与历史价都由采购单 / 销售单派生，手工只维护单据，永不失步。
- **幂等**：历史每次从单据全量重建（而非追加），同一单据重复保存不会让历史翻倍。
- 新供应商在采购单中出现时自动建档（`G` + 序号）；新商品在单据中出现时自动建档。
- **`orders.json` 一律不参与派生**：`derive()` / `rebuildStock()` 只吃 `purchases` + `sales`，这正是订单能当草稿的前提——存草稿不会扣库存、不会进应收，只有「过账」把那张单写进单据集合时才算数（见 [docs/orders.md](docs/orders.md)）。

## 前端展示
- **方块语义（全站统一，规则只写在 `App.vue` 全局样式一处）**：页面上只有两种方块——
  - **表示状态 / 类别（不可点）**：`el-tag`（结算状态、库存预警、单据类别、客户类别等）与**禁用态按钮**一律**白底 + 同色描边 + 同色文字**（空心）；
  - **可以点击（按钮 / 开关）**：`el-button` 一律**同色实心填充 + 白色文字**（文字像镂空）。Element 默认把 `plain` / `text` / `link` 三种按钮渲染成空心，已在 `App.vue` 用覆盖 `--el-button-*` 变量的方式统一改成实心，配色仍取既有的 primary / success / warning / danger / info 五色；未指定 `type` 的中性按钮**与 primary 同为实心蓝**（原来是实心灰 `--text-regular`，灰底和「禁用态白底灰字」在列表里很难分辨，而且灰色看起来像不能点），**不新增任何色相**。
  - **状态点**：所有空心 `el-tag` 在内部右上角显示一颗小圆点，颜色取 `currentColor`（与该标签的文字色一致，不额外指定），让「这块颜色指的是什么」一眼可辨；三档尺寸（default / small / large）各配点位与直径，右侧留出内边距避免文字压到点。
  - **状态标签与紧跟其后的操作按钮必须同行、等高**：Element 的 `el-tag--small` 高 20px，而 `size="small"` 的 `link` 按钮按本文件上面的规则高 24px，两者并排就是一高一矮；加上状态点又给标签右侧加了 7px 内边距，「结算状态」列原来的 130px 宽放不下，改账按钮被挤到第二行。现规则：**标签取默认档（24px）与 small 按钮等高**，外层套 `.settle-cell`（`inline-flex` + `white-space:nowrap`）保证不换行，销售/采购两个列表的该列宽 130 → **160**（实测标签 51 + 间距 6 + 按钮 60 = 117px，列内可用 136px）。
  - 单选按钮组（如录入弹窗的「挂账 / 结清」、报表的「按净额 / 按应收」）天然是选中项实心、未选中空心，符合本规则，无需改动；复选框、开关、分页等非方块控件保持原样。
  - `text` / `link` 改成实心方块后每个按钮约占 46px（两字）+ 6px 间距，表格「操作」列宽需按此估算（过窄会被裁切）。
- **左侧菜单**：按「经营（看板/报表）→ 资料（商品/供应商/客户）→ 业务（**订单**/采购/销售/库存）→ 资金」分组；订单排业务组第一位（业务链的起点：先谈单、再收订金、过账后才生成采购/销售单），菜单项带**待过账草稿数**角标；**资金**为可展开子菜单，顺序为**应付款管理**、**应收款管理**、来往账、退货/退款、收付款单（应付在前对应「先付供应商、后收客户」的实际节奏），前两项带未付清/未收清单据数角标。角标是手画的胶囊 `span.menu-badge`（`inline-flex` 居中 + `margin-left:auto` 靠右），不用 `el-badge`——后者是「默认插槽 + 绝对定位 sup」结构，在无插槽内容的 flex 菜单项里会掉到文字下沿（手机上就是「角标换行」）。窄屏自动折叠为左上角抽屉菜单（结构相同）。看板顶部另有一张「待过账订单 N 张 · 订金合计 ¥X」卡片（点「去处理」跳 `/orders`；该卡片**故意不跟随日期筛选**——待办属于当下，不是某个区间）。
- **订单页（`/orders`）**：**默认只看未过账订单**，状态选择框提供「显示全部订单 / 仅显示未过账订单 / 仅显示已过账订单」，另有类型、日期段、关键词筛选，列为勾选框、订单号（收过订金的带「订」标记、订单号下方显示业务单号）、类型、往来单位、时间、商品、订单金额、已收订金、状态（已过账的行给一个跳到生成单据的链接）与操作（未过账可 编辑 / 收订金 / 过账 / **备注** / 删除，已过账只可 撤销过账 / 备注；每行另有「打印」与「CSV」按单张订单输出 A4 / CSV；所有 A4 打印明细最前面都是「序号」列）。「备注」弹窗只提交 `{action:'remark'}`，已过账订单也能补备注；订单详情页备注行旁同样有「添加/编辑备注」按钮。打印勾选订单列表时「商品」列最多保留 3 个名称，其余以「…」代替（CSV 不受影响）。表格首列勾选后（跨页保留）可**打印勾选订单列表**、**打印勾选订单详情页**（弹框选「直接打印」或「隐藏金额打印」，后者每单单独一页，单价、折扣、行金额、订单金额、订金、未收/未付等所有金额信息全部不输出，单头不显示状态、第二行只留「共 N 项商品」）与**删除勾选**（`deleteMany` 一次请求、一次提交；已过账 / 已收订金的由服务端跳过并回报数量），工具栏保留「导出CSV（当前页）」。新建/编辑走 `OrderFormDialog`（明细与折扣口径与单据完全一致，校验函数 `validateOrder` 前后端共用）；「快速添加」再次录入同一商品会弹「本商品已录入」，可选定位到已录入行（蓝色外框闪烁两下）或再次添加一行，销售单 / 采购单弹窗同一套行为。单张订单打印的副标题只保留「共 N 项商品」，不再显示订单状态，**保存只发 `{action:'save'}`，绝不碰 `sales`/`purchases`**。右上角「**清空未过账订单（N）**」按一次请求删掉全部纯草稿（`clearDrafts`），按钮上的 N 就是真会删掉的张数，**已过账与收过订金的单不在其中**（前者连着正式单据、后者凭证已开）。错误提示统一分三档：`409` → 刷新重试、`5xx` → 以刷新后的数据为准、其余 → 原样显示服务端中文原因。
- **订单详情页（`/order/:id`）**：点订单号进入，与销售/采购详情页同一套勾选——**隐藏单价与金额**、**显示售价**、**显示进价**、**展开历史价与商品档案**、**对外查看（隐藏价格·只读）**、**显示客户信息详情**（采购订单为「显示供应商信息详情」）。明细默认只看本次数据（本次数量 / 单价 / 折扣 / 金额），勾选后才叠加商品档案的售价、进价、历史采购价/销售价、规格包装与照片；「对外查看」同时隐藏价格与编辑入口，页面只读。有整单折扣时明细追加「折后金额」、单头折扣加框高亮；没有行折扣时打印不输出「折扣率 / 本次折扣」列。**打印 与 导出CSV 严格跟随这些勾选**：隐藏价格时只输出编码/名称/单位/数量，订金卡片的金额也一并隐藏；正常模式单据头带业务单号、折扣链、订金与未收(未付)，并可按需带出客户/供应商的联系人、电话、地址。
- **商品管理页**：表格含「备注」列；每行可**展开**查看「历史采购价」「历史销售价」两张明细表（日期 / 供应商或客户 / 数量 / 单价 / 金额），展开区同时显示规格/包装、分级售价、备注与商品照片。历史采购价与历史销售价均在首次展开时按需拉取（见「items.json 瘦身」），未取到时展开区显示加载状态，收起再展开可重试。
- **采购单 / 销售单详情页**：默认**只显示本次数据**——明细表保留「本次数量 / 本次单价 / 本次金额」；有行级折扣时才显示「本次折扣」，有整单折扣时追加「**折后金额**」（每行摊完整单折扣后的金额，累计四舍五入保证各行合计＝单头折后金额，单头「整单折扣」加框高亮）。商品档案的售价、进价与「本次单价」重复，默认隐藏（顶部「显示售价 / 显示进价」勾选后可看）；「备注」固定置于条目最后；「历史采购价 / 历史销售价 / 商品照片」等档案信息默认收起，由顶部「展开历史价与商品档案」勾选开启。导出 CSV 与打印遵循同一口径（无行折扣时不输出「本次折扣」列）。
  - **隐藏单价与金额（实时生效）**：勾选后明细表只留编码/名称/单位/数量/备注，单头合计/原价合计/整单折扣/折后金额/优惠/应收(应付)/实收(实付)/未收(未付)以及明细「本次折扣」列、收款(付款)金额、退货核销金额同步隐藏——**打印与导出的折扣金额也一并去掉**，与页面同一口径；页面仍可编辑、可继续记收付款。
  - **对外查看（隐藏价格·只读）**：自动叠加上述价格脱敏，并隐藏编辑/删除/退货/记收付款/上传照片等写操作，隐藏收款(付款)/核销卡片与历史价展开，顶部显示「对外查看模式」提示；导出与打印同样不含价格与折扣金额。
  - **打印单头只给外部看得懂的信息**：客户编码、客户类别（客户类型）、供应商编码属于系统内部标识，导出 CSV 与打印 A4 **一律不带**；联系人 / 电话 / 地址由顶部新增的「**显示客户信息详情**」（采购单为「**显示供应商信息详情**」）勾选控制，**默认既不打印也不在页面上显示**——单据经常要递给外部，联系方式不该跟着一起流出去。勾选后**页面信息行与打印/导出同步显示**同一份档案（同一个 `customerInfo` / `supplierInfo` computed 供两边取用），不会出现「纸上有了、屏幕上还得看打印预览」。
  - **备注就地添加 / 编辑**：详情页信息行常驻「备注：…」与「**添加备注**」（已有备注时按钮文案为「编辑备注」）——以前备注只在有值时纯文本显示，要补一句必须开整单编辑弹窗（会重算金额、明细、收付款，风险与耗时都大得多）。新组件 `OrderRemarkDialog.vue` 与 `OrderPhotoDialog.vue` 同一套路：只回写 `remark` 一个字段、保存失败本地回滚、`externalView` 只读模式下不显示。后端资金保护的退货单锁比对的是「去掉 `photos` / `remark` 的其余字段」，因此补备注既不会被锁挡住，也改不到金额。
  - 两个开关互不相同：前者只做价格脱敏、保留业务操作；后者是对外展示用的完整只读模式。
- **供应商页 / 客户页**：名称可点击进入详情。列表支持**按时间段（起止日期）筛选**，并实时统计该区间内每家的**采购总金额 / 销售总金额**（折后成交金额合计）与**最新成交日期**；提供「按总金额排序」「按最新成交排序」两个按钮（默认按编码/最新添加），导出/打印列同步包含这两项。
- **供应商详情 / 客户详情**：以标签页组织——
  - **产品列表**：该供应商/客户关联的全部商品（商品库样式 `ProductTable`，可展开历史价）；
  - **采购单 / 销售单**：列出与该供应商/客户相关的单据（单号可跳转详情、日期、金额、备注），并支持**按时间段（起止日期）筛选**。
- **采购单 / 销售单列表页**：支持**按时间段（起止日期）筛选**，表格含「备注」列；详情页信息区显示备注。
- **备注**：商品、供应商、客户、采购单、销售单均可在表单中填写备注。
- **汇总金额**：采购单 / 销售单列表、以及供应商 / 客户详情页的单据表格，底部均有**合计金额行**（`show-summary`，随筛选结果实时汇总）；经营看板的单据汇总卡片同样带合计行。

### 经营看板（首页）
- **时间段选择**：快捷「今日 / 昨日 / 近7天 / 本月」按钮，或自定义起止日期；可一键回到全部。
- **今日汇总**：默认進入即为今日，顶部统计本期**采购金额 / 销售金额 / 毛利 / 单据数**，标题随所选区间自动切换（今日 / 本期）。
- **本期具体单据**：分别列出该时间段内的每一张**采购单**与**销售单**（单号可跳转详情、供应商/客户、日期、金额、备注），并合计金额。
- 底部保留库存概览与低库存预警。

### 统计报表
「统计报表」页按**采购/销售两个分区**组织，筛选条件与指标同区联动：
- **时间段**（顶部，全局）：对两个分区同时生效，带「清除」按钮与区间标签；**所有筛选条件（时间段/供应商/客户/两个商品关键词）自动记住，刷新页面后恢复上次选择**（localStorage）。
- **采购与应付款分区**：**供应商筛选只作用于本区**（并联动下方商品采购汇总），指标含采购总额、累计实付（含付款流水笔数）、应付款（未付合计，红色，附未付清单数）；卡片标题栏实时显示当前供应商与时间段；分区内带**月度采购趋势条**（纯 CSS 按月柱状图，随本区筛选联动，未选时间段时默认近 12 个月；**点击柱子显示当月数额**——柱顶浮动标签 + 标题栏「月份 金额 · 单数」明细，再点一次取消，选中柱高亮）。
- **销售与应收款分区**：**客户筛选只作用于本区**（并联动下方商品销售汇总），指标含销售总额、毛利、应收款（未收合计，红色，附未收清单数）；同样带**月度销售趋势条**（同样支持点击柱子显示当月数额）。
- **毛利口径**：`毛利 = 销售总额 − 销售成本`，销售成本 = Σ（销量 × 商品当前库存成本），因此**毛利为 0 表示所选范围内商品的售价与进价相同**（零加价销售），并非计算错误；报表所有金额指标均做两位小数四舍五入与负零归一化（不会出现 "-0.00"）。
- **按商品销售汇总**：随「客户 + 时间段 + 商品关键词」联动，底部带合计行；**排序可切换「按金额 / 按时间」**（按时间取该商品最近一次销售日期、新的在前，同日期按金额兜底），表格含**最近销售**列，导出与打印顺序随当前排序；排序选择刷新后保留。
- **按商品采购汇总**：随「供应商 + 时间段 + 商品关键词」联动，按进价维度聚合**采购单数 / 采购数量 / 平均进价 / 采购金额 / 最近采购**，底部带合计行；同样支持**「按金额 / 按时间」排序切换**（按时间取最近一次采购日期），导出与打印顺序随当前排序。
- 应收/应付口径与全站账务规则一致（`合计 − 优惠 − 累计收付款`，见「账务规则」），欠款与结算状态解耦。

### 资金管理（应收款 / 应付款 / 来往账）
左侧「资金」菜单下三个页面，分别从**客户**和**供应商**视角管理往来欠款：
- **来往账**（合并视图）：将客户应收与供应商应付合并展示，含两个页签——「按往来单位汇总」（每单位列出应收(折后)/实收/应付(折后)/实付/净额(未收−未付)，净额正为客户欠我方、负为我方欠供应商，可跳转单位详情）与「单据明细」（应收/应付单据统一列表，带类型标签与结算状态）；顶部统计卡给出应收合计、应付合计、往来净额与单据总数；**统计卡下方额外提供「净额分布与排行」区块**——按净额正负拆分应收净额（客户欠我方）与应付净额（我方欠供应商）的占比条形，并列出往来单位排行（可切换「按净额 / 按应收 / 按应付」，可导出 CSV / A4 打印）；其下「金额区间分布」按净额绝对值分桶（>1万 / 1千~1万 / ≤1千）展示各桶金额合计与单位数占比（亦可导出）；支持类型（应收/应付）、时间段、仅看有余额筛选与关键词搜索，**排行区另提供「全部 / 只看客户 / 只看供应商」快捷筛选**，分布与排行随筛选/时间段实时联动；**只要有往来单位即展示该区块（不再因全结清而整块隐藏）**。
- **资金操作中心（来往账页内一站式完成）**：「单据明细」支持**跨分页多选**——勾选后表格上方显示「已选 N 单」并提供「合并收付款」「清空选择」（分页间选择不丢，因 `reserve-selection` + `row-key="id"`）；点「合并收付款」按**往来单位（客户应收/供应商应付）分组**结算，每组填一笔金额、按日期升序且单笔封顶未收分摊到该单位名下选中单据，超出部分自动转存**预存款/预付款**（幂等标记，不泄漏）；每组有实际收付时生成**一张**资金单据，`items[]` 逐单记录分摊金额、本次优惠与是否结清（一张凭证对应多张单据，单据流水上回写该编号）；页面顶部另提供「**记一笔（收/付款）**」与「**存预存/预付**」两个按钮：记一笔选类型+单位+金额，分摊到该单位未结单据（超额转预资）：**「所选未结合计 − 本单优惠 = 需收付金额」三个数同一条链实时联动**——优惠金额输入框按本单未收封顶、优惠铺满未收时该行自动设为「结清」，批量优惠同样逐行按未收封顶并联动结清；「按所选未结合计填入」一键把优惠后需收付合计填进金额框，并提示「还差多少（按日期先后分摊、摊不到的继续挂账）」或「超出多少（转预存款）」；本组有实际收付才生成一张资金单据；存预存/预付直接向客户预存款/供应商预付款充值（流水结构与详情页完全一致、为`无 order 字段的独立余额`；来往账与详情页两个充值入口都会生成「预存预付充值」资金单据）；**按往来单位汇总表新增「预存/预付余额」列**（按类型显示客户预存款或供应商预付款），顶部统计卡新增「预存款合计（客户侧）」「预付款合计（供应商侧）」。所有收付款与预资写回复用 `account.js` 与详情页同结构的 `payments / deposits / advances` 流水，应收/应付、经营看板、报表、菜单角标自动保持一致。
- **筛选**：时间段、往来单位（客户/供应商，选项取自全部单据）、关键词（单号/商品/备注），全部指标与表格实时联动；支持导出 CSV 与 A4 打印（范围为当前筛选结果）。
- **汇总卡片**：应收(应付)总额、累计实收(实付)（含流水笔数）、**抹零优惠**（未实际收款/付款，含含优惠单数）、未收(未付)合计（红色）及未结清单数。
- **单据明细**标签页：逐单列出单号、**往来单位（客户/供应商）**、日期、商品、应收/应付、已收/已付（N 笔）、优惠（抹零，未实际收付）、未收/未付、结算状态，操作列可直接**登记收款/付款**（复用收付款流水弹窗，支持一单多笔、结清、抹零结清、用预存款/预付款抵扣；保存后自动刷新并幂等处理超额转存/抵扣预存款流水）；底部合计行基于全部筛选结果，每页 60 条。
- **按往来单位汇总**标签页：按客户/供应商聚合单数、应收/应付、已收/已付、未收/未付，可跳转该单位来往账；**「单数 / 应收(折后) / 实收 / 应付(折后) / 实付 / 净额」任意列均可点击表头排序**，在降序 / 升序 / 按单位名复位间切换，排序对全量数据（跨分页）生效。**排序状态、排行 Top 数量、类型/余额筛选与「全部/客户/供应商」选择均记忆到浏览器本地（localStorage），刷新页面后自动恢复。**
- **往来排行可切换口径与 Top 数量**：「往来排行」支持「按净额 / 按应收 / 按应付」三种口径（净额显示债权/债务两组，应收/应付各显示一组），标题旁提供 Top 数量选择（3 / 5 / 10 / 20）；排行、导出与「全部/客户/供应商」筛选联动，口径与 Top 数量记忆到本地。
- 口径与全站账务规则一致（`合计 − 优惠 − 累计收付款`），欠款与结算状态解耦。

### 销售价带出规则
新增销售单录入时，单价按以下优先级自动带出，**带出后仍可手动修改**：
1. 该**客户最近一次**购买此商品的成交价（从 `GET /api/sale-history` 的对应商品行里取 `customer` 匹配且日期最新的一条）；
2. 若该客户无此商品成交记录，则用商品当前售价 `price`。
切换客户会按新客户的最近售价刷新已填行的单价。

### 照片（图床）
- 商品可上传**商品照片**；采购单 / 销售单可上传**原始单据照片**，支持多张（单张 ≤10MB，最多 9 张）。
- 上传过程中组件显示「正在上传 N 张」，此时点保存会拦截并提示，防止照片未上传完成被丢弃。
- 上传由 Worker 代理：`POST /api/upload`（multipart `file`）→ 转发到图床 `https://netpan.1234.nyc.mn/upload`，authCode 存放在 Worker Secret **不暴露给前端**：
  ```bash
  npx wrangler secret put IMGBED_AUTH_CODE
  ```
- 存储的是图床返回的完整 URL；有照片的地方自动显示**缩略图**，点击可放大预览（商品展开区、采购/销售详情页，详情页标题标注照片张数）。
- **已有单据补照片**：采购 / 销售列表操作列有「照片(N)」按钮，详情页照片区有「添加照片」，点击弹出轻量照片弹窗，可上传或移除照片后单独保存——只更新本单 `photos` 字段，单号、金额、明细、付款流水等其他信息不受影响。

### 账务规则（统一，全站唯一入口 `src/utils/account.js`）

**核心原则：欠款按「金额」计算，结算状态(`settle`)只用于显示与校验，不参与欠款金额计算。**

| 概念 | 公式 |
|---|---|
| 应付/应收金额 | `合计 × 整单等效折扣率 − 优惠(discount)` |
| 采购单未付 | `max(0, 合计 − 优惠 − 累计实付)` |
| 销售单未收 | `max(0, 合计 − 优惠 − 累计实收)` |
| 供应商应付款 | 该供应商**全部**采购单未付金额之和（不再按「挂账」过滤） |
| 客户应收款 | 该客户**全部**销售单未收金额之和（不再按「挂账」过滤） |

- **累计实付/实收 = 收付款流水 `payments` 各笔金额之和**（兼容旧数据：无 `payments` 时取 `paid`/`received` 字段本身，见「多次收付款」）。
- **优惠(`discount`)是独立字段**，不得用「合计 − 实收/实付」反推。折扣、应收金额、实际收款、未收金额各自含义不同，分开保存。
- **一键「改结清」**（销售/采购列表与详情页「结算状态」旁的按钮）：若仍有未付/未收，确认后把**差额全部记为抹零优惠**（计入 `discount`，不产生实际收付款流水、现金不增不减），本单按实收/实付金额结清；改回挂账不动金额。
- 客户列表、客户详情、销售单列表、供应商列表、供应商详情、来往账**全部使用同一套公式**，金额不会互相打架。

> 旧数据兼容：历史单据没有 `discount` 字段时按 0 处理，即「未结 = 合计 − 实收/实付」。

### 多次收付款（payments 流水）
采购单 / 销售单均支持**一单分多次付款 / 收款**：
- 每张单据内嵌 `payments` 流水数组：`{ date, amount, remark, time }`，销售单为**收款**流水、采购单为**付款**流水。
- **记录入口**：列表页操作列「收款 / 付款」按钮、单据详情页「收款记录 / 付款记录」卡片右上角按钮，弹出流水对话框。
- 对话框实时显示 `应收(应付) / 累计已收(已付)（N 笔）/ 未收(未付)`；「记一笔」先入本地列表（可删除、可连续记多笔），点「保存」统一生效；**超额收款/付款会被拒绝**。
- **流水可编辑**：每笔记录行内「编辑」按钮，将该笔日期/金额/备注载入下方表单（保留原录入时间戳），改完点「保存修改」写回原位置，也可「取消编辑」；编辑时金额上限自动按「应收 − 其他各笔合计」校验，删除某笔后编辑位置自动跟随修正；所有改动仍需点弹窗底部「保存」统一生效。
- **优惠结清（抹零）**：保存时若本次收付合计**低于**应收/应付（差额 > 0），弹窗提示「差额将作为优惠入账，本单按实收金额结清」——**确认**则差额自动计入单据 `discount`（优惠）字段并结清；**取消**则仅记为部分收付，账单保持挂账。抹零部分在全站统一标记为「抹零优惠（未实际收款/付款）」：收付款弹窗顶部、单据详情信息行与收款记录卡标题、销售/采购列表「优惠」列（悬停有说明）、应收/应付款管理明细表与汇总卡（含「抹零优惠」指标）、经营看板汇总表、客户/供应商来往账单据表均有展示。这样少收的钱以优惠形式入账，全站应收/应付、未收清单、报表口径自动保持一致（不会出现"结了清但还显示欠款"）。
- 保存后自动：同步 `paid`/`received` 汇总字段、按金额自动更新 `settle`（收满→`结清`，未收满→`挂账`）。
- 列表「实收 / 实付」列显示累计金额与笔数；详情页、来往账均按流水汇总展示。
- **旧数据零迁移**：历史单据没有 `payments` 数组时，原有 `paid`/`received` 金额自动视为一笔「历史收付」记录，首次操作该单时自动转入流水。

### 资金单据（收款单 `SK-` / 付款单 `FK-`）联动
**红线：只要发生资金变动，就必须有一张对应的资金单据。** 单据里的 `payments` 流水是「账面记录」，资金单据是「凭证」，二者一一对应、同批落库。外部脚本代收款时按同一顺序（先流水带编号、后凭证），见「AI / 脚本对接（接口契约）」的「脚本代收款的标准顺序」。

统一入口 `src/utils/voucherFlow.js`（纯逻辑，不引 UI 库），各页面一律通过它开单，不允许各自拼数组：

| 资金变动来源 | 生成的资金单据 |
|---|---|
| 单据收款/付款弹窗「记一笔」「结清」「抹零结清」「保存」 | 每笔新增流水一张 `SK-`/`FK-`（类别 `normal`，关联本单号） |
| 「用预存款/预付款支付」抵扣 | 一笔流水一张「预存款抵扣」划转单（类别 `deposit-deduct`，关联单号） |
| 超额收付转入预存/预付 | 一张「超额转存」单（类别 `deposit-over`，无关联单号） |
| 新增采购/销售单时填写的「本次实付/实收」与抵扣 | 逐笔生成资金单据（与单据同批落库） |
| 列表页 / 详情页「改结清」选择**收款结清 / 付款结清** | 差额记为一笔实际收付款 + 生成一张资金单据 |
| 来往账「记一笔」「合并收付款」 | **每组一张**：可覆盖该单位名下多张单据，`items[]` 逐单记录金额/本次优惠/是否结清 |
| 来往账「存预存/预付」或客户/供应商详情页「预存款/预付款充值」 | 一张「预存预付充值」单（类别 `deposit-recharge`，无关联单号） |
| 纯优惠、纯结清（钱未动） | **不生成任何资金单据**（一分未收/付时不占用编号，也不留 ¥0.00 空单） |

详情页「预存款 / 预付款」表的「关联销售单 / 关联采购单」列显示该笔流水对应的单据：用预存款/预付款抵扣货款、超收/超付转入余额的流水会带订单号，点击可打开销售单/采购单详情（退款单 `XT-`/`CT-` 红字；原单已删除时保留单号静态展示并提示）；手动充值、批量收付款产生的 `batch:` 标记流水显示「—」。相邻的「关联收付款单据」列逐条显示对应的 `SK-` / `FK-` 编号，点击可直接打开资金单据详情；新充值会把编号回写到流水，历史流水按订单号或单位/日期/金额兜底匹配，匹配不到的显示「—」。

要点：
- **编号回写到流水**：`savePaymentWithVouchers()` 先从库内现有资金单据预分配连续编号（`allocVoucherCodes`），把编号写进 `payments[].voucher`，再整表保存单据集合，最后写资金单据集合。因此「流水 ↔ 凭证」在同一次保存里就绑定，销售/采购列表的「收付款单」列与详情页的「资金单据编号」不再常显「—」。
- **顺序不能反**：若等单据落库后再生成编号，要么多一次整表覆盖，要么留下「有流水无凭证」的悬挂记录。
- **失败不静默**：`stage` 为 `orders`（单据未存，本地列表未被修改）/ `vouchers`（流水已存、凭证写入失败）时页面明确报错并给出补救入口（来往账「记一笔」补开）；`voucherNotices()` 统一把结果翻译成提示文案。
- **一次性标记 `mid`**：弹窗用 `mid` 在内存里把「本次新增流水」与资金单据编号精确对应（`payments` 会按日期时间重排，同名同额同日的光靠金额会串位），回写完即删除，后端 `normalizeOrderPayments` 再兜一道，**绝不落库**。
- 类别常量 `VOUCHER_CATEGORY` 只用于列表/抽屉展示区分，不参与金额计算。
- **两个集合文件可能不存在**：`receipts.json` / `payment-vouchers.json` 是后期新增的，老数据仓里从来没有过；GitHub Contents API 对不存在的文件返回 404，`readJSON` 抛错 → `GET /api/receipts` 变 500。而「来往账」「收付款单」两页原先把这两个请求和单据请求塞在同一个 `Promise.all` 里，catch 后静默清空所有列表——表现就是**页面一条信息都没有**，而欠款其实算得出来。现在两头都修：后端 `readOptionalArray()` 对这两个文件按空集合兜底（其余主数据缺失仍必须报错，整表覆盖语义下把读失败当空数组等于删库），前端按「必要数据 / 可选数据」分开加载并明确报错，绝不再静默变白页。数据仓侧已补建两个空集合。

### 挂账 / 结清 与 应收 / 应付
- 采购单、销售单均带 `settle` 字段：`挂账`（默认）或 `结清`；列表与详情页的「结算状态」列除标签外，还提供「改结清 / 改挂账」两个改账按钮。
- 状态仅用于显示与校验；欠款金额一律按上表公式计算（`settleActionOf` 统一判定按钮动作）。
- **仍有未收（未付）时点「改结清」**，会当场二选一（旧版只有「记优惠」这一条路，所以结清后查不到收款单）：
  - **收款结清 / 付款结清**：把差额记为一笔实际收付款，并按「资金单据联动」生成 `SK-`/`FK-`，现金真的增减；
  - **差额记优惠**：差额计入 `discount`（抹零核销尾款），**钱没有动，因此不生成任何资金单据**，提示里也会如实说明；
  - 关闭弹窗 = 放弃操作。
- **金额已平但含抹零优惠时，按钮显示「改挂账」**：点击会二次确认，确认后撤销该单的抹零优惠（`discount = 0`），未收/未付恢复为原优惠金额、结算状态回到「挂账」。若钱其实已经收到/付出，应改用「收款 / 付款」补登记，而不是改挂账。
- **未收/未付为 0 且没有抹零优惠时，不显示改账按钮**：此时按实收/实付已经结清，没有可恢复的欠款；要恢复欠款只能修改或删除对应的收付款流水。退货单（`XT-`/`CT-`）也不显示改账按钮。

### 单据编辑、删除与作废
采购单 / 销售单操作列提供**查看 / 编辑 / 作废 / 删除**：
- 编辑复用录入对话框，**沿用原单号**，可改供应商/客户、明细、日期、结算状态、备注、照片；
- 删除有二次确认，保存后后端 `derive()` 会自动重算库存、供应商关系与历史价。
- **两种情况下明细会被锁定**（编辑弹窗顶部出现红色锁定条，明细整表改纯文本，「实收金额」仍可补收）：
  ① 这张单**已经动过钱**（有 `payments` 流水、有退货核销 `settlements`、或旧字段 `received`/`paid` 不为 0）——
  改小金额等于凭空抹掉一张已开的收款凭证；
  ② 这张单**已经有下级单**（退货单 / 补差单按原单行索引 `sourceLine` 定位商品，明细一改索引就错位）。
- 锁定后要增减商品，点锁定条上的「**变更明细**」：减少的商品生成退货单（`XT-`/`CT-`，可选退现金 / 冲抵欠款 / 转预存款 / 先挂着），
  新增的商品生成补差单（`XA-`/`CA-`，挂账），原单一个数字都不动。变更**不允许改价**，价格不一致会被拒。
  完整规则与接口见 [docs/orders.md](docs/orders.md)。
- 销售 / 采购详情页为此单族显示「**关联变更单**」卡片，顶部给出「变更后净成交 ¥X · 未收/未付 ¥Y」；列表页补差单单号前带「补」标记。
- **作废**与删除不同：单与凭证都保留（`status:"作废"`，可查可审计），但应收/应付、实收/实付、库存、历史价一律归零，关联的 `SK-`/`FK-` 同步作废。作废是终态、不可恢复；有退货子单/核销记录/合并凭证未拆时会被拦下（`409`）。详见 [docs/void.md](docs/void.md)。

### 列表分页与导出打印
- 商品库 / 客户 / 供应商 / 采购单 / 销售单 / 应收款 / 应付款管理均**每页 60 项**；经营看板的本期采购单汇总、销售单汇总**每页 20 项**。
- 每个列表都有「**导出CSV**」与「**打印**」按钮：CSV 带 BOM（Excel 打开不乱码），打印在新窗口按**打印设置里选的纸张**排版（默认 **A4 纵向**，可切 A5 / 自定义与横纵向）并自动调起打印。
- 导出/打印范围与列表**当前页同步**（输出当前所在页的数据，不写死条数，跟随每页条目数），副标题标注「第 X/Y 页」；表格底部合计行仍基于全部筛选结果，便于对账。
- 表格底部的「合计」也按**全部筛选结果**计算，而不是当前页。

### 来往账（客户 / 供应商）
供应商详情与客户详情均有「**来往账**」页签，按时间顺序列出与该往来单位的全部单据，滚动计算**累计欠款**：

| 列 | 说明 |
|---|---|
| 日期 / 单号 | 单号可跳转单据详情 |
| 摘要 | 采购入库 / 销售出库 |
| 应收(应付)金额 | 单据合计 |
| 优惠 | 单据优惠额 |
| 实收(实付)金额 | 实际收付款 |
| 未结金额 | 合计 − 优惠 − 实收/实付 |
| 累计欠款 | 从**期初余额**开始逐单滚动累加 |

**期初 / 期末余额**：时间筛选只影响展示的明细行，欠款不会因此丢失——
- 期初欠款 = 筛选起点**之前**所有单据的未结金额之和；
- 期末欠款 = 期初 + 本期各单未结金额之和；
- 页签上方直接显示「期初欠款 / 本期应收(应付) / 期末欠款」。
未设置时间段时期初为 0、展示全部单据，口径一致。

时间段筛选位于页签上方，对「单据列表」和「来往账」同时生效。

### 数据备份与恢复（数据管理页）
- **全量导出 / 导入**：**九类数据**（商品 / 客户 / 供应商 / 销售单 / 采购单 / 收款单 / 付款单 / 未过账订单 / 退款核销单）打包为一个 JSON 备份文件；导入为**整表覆盖**语义，面向定期存档、换设备恢复。导入顺序固定：主数据 → 单据 → 资金单据 → 订单/退款，其中订单与退款走 `restore` 动作整表写回。
- **旧备份兼容**：订单与退款是后加入的集合。旧备份文件里没有 `orders` / `refunds` 键时，摘要不显示这两行、导入**也不动**现有草稿与退款凭证；只有键存在（哪怕是 `[]`）才覆盖——空数组表示「备份时确实没有」，会一并清空。
- **分类导入导出**：九类数据**各自独立**导出（单类型 JSON）与导入；导入走 `POST /api/import-merge`（**合并去重，不覆盖**）：
  - 商品 / 客户 / 供应商按**编码**查重，采购单 / 销售单 / 未过账订单按**单号**查重，退款/核销单按**凭证号**查重；客户 / 供应商额外按**名称**查重（防止同名多码把一家单位拆成两份档案）；
  - 导入前前端先用同一份 `src/utils/dedupe.js` 纯函数做**比对预览**（将新增 / 重复跳过 / 无效及逐条明细），确认后才写库；服务端落库前会重新比对一次，以服务端结果为准；
  - 重复与无效记录自动跳过，只追加新记录；单据类导入后自动 `derive()` + `rebuildStock()` 重建库存、历史价与档案链接，并过 `normalizeOrderPayments` 防实付漏算；未过账订单与退款凭证只是档案/凭证，导入不触发派生（订单不占库存、退款不影响库存）；
  - 单次上限 5000 条。

### 清空数据（独立菜单项，位于「系统」分组）
- 从「数据备份」页抽离为独立视图（`/clear`），与导出/导入互不干扰，避免误操作。
- 提供**清空所有数据**（商品 / 客户 / 供应商 / 销售单 / 采购单一并清空）与**分项清空**（五类各一项）两种入口。
- 每项清空均**两步确认**：先警告弹窗告知后果 → 再输入**管理密码**（复用登录接口服务端校验）才执行，密码错误拦截。
- 清空客户 / 供应商后，其名下销售单 / 采购单保留并自动加「(已删除客户) / (已删除供应商)」前缀（幂等，已加前缀不再重复加），防止孤儿单在汇总里对不齐；清空销售单 / 采购单不影响客户 / 供应商档案；清空所有数据则全量清空，无孤儿标记必要。

### 已知限制（尚未实现，需进一步设计）
1. **无跨单核销**：一笔付款分摊给多张单据（如「付款 1500 元，1000 元核销 A 单、500 元核销 B 单」）暂不支持；当前以**单内多次收付款流水**（`payments`）表达，已覆盖同单分多次收付款。
2. **无编辑审计**：单据允许编辑/删除，金额、往来单位、日期变更会改变历史账务结果，目前没有修改前后留痕与操作原因记录。
3. **无自动对账报表**：暂未内置「列表余额 vs 流水余额不一致 / 付款超过未结 / 重复核销 / 状态与余额矛盾」的异常检测。
4. **无退款/预收预付**：负向金额调整需手工修改流水或删除重记。

若需要完整的往来账务（跨单核销、退款折让、预收预付、对账），建议下一步在后端增加 `payments.json`（独立收付款流水）与 `allocations`（核销明细），并以上述公式为基础重构欠款计算。

### 经营看板筛选
本期采购单汇总支持**按供应商筛选**，本期销售单汇总支持**按客户筛选**（下拉选项取自该时间段内出现过的往来单位），叠加在时间段筛选之上。

### 低库存预警值
看板「低库存预警」表格中，每行的**预警值可直接修改**并即时保存；也可在商品编辑对话框里改。库存数量 ≤ 预警值 的商品会出现在该表。

### 实收 / 实付 与 优惠折扣
- 采购单有**实付金额** (`paid`)、销售单有**实收金额** (`received`)，均由收付款流水 `payments` 汇总自动同步，录入/编辑时不再直接填写（见「多次收付款」）。
- **优惠金额** (`discount`) 是**独立字段**，需单独填写（默认 0），不再由「合计 − 实收」反推。
- 录入弹窗实时显示：`应付/应收 = 合计 − 优惠`、`未付/未收 = 应付/应收 − 累计实收/实付`；列表与详情页也按此展示。

### 多级折扣（折扣链）
销售单 / 采购单的**整单折扣支持多级叠加**（如「打完 9 折后，再打 9 折，再打 8 折」，等效 6.5 折）。

- **数据结构**：整单折扣以折扣链数组 `discountRates` 存储（如 `[0.9, 0.9, 0.8]`），各级折扣率连乘得到**等效折扣率**（`0.9 × 0.9 × 0.8 = 0.648`）；同时**冗余保留标量 `discountRate`**（= 等效乘积），兼容仍在直接读取它的旧代码路径。
- **向后兼容**：早期单据只有标量 `discountRate`（如 `0.9`）时视为单级折扣链 `[0.9]`，折扣不丢失；无折扣字段按 `1`（不打折）处理；数组中的非法项（非数字 / >1 / ≤0）自动剔除。
- **计算口径**（`src/utils/account.js`，全站唯一入口）：`discountRatesOf(order)` 规范化折扣链（优先数组、回退旧标量、非法/缺失返回 `[]`）；`effectiveRateOf(order)` 连乘得到等效折扣率（无折扣返回 `1`）；`grossOf(order)`（应收/应付金额）= `round2(合计 × effectiveRateOf − 优惠)`。
- **录入**：录入/编辑弹窗「整单折扣」区可「+ 添加一级折扣」逐级叠加，每级一个 0~1 的折扣率（1＝不打折，0.9＝九折），可单独删除（删到空＝不打折），实时显示「累计等效折扣」。
- **展示**：详情页与导出/打印的「整单折扣」字段显示完整折扣链——单级 `×0.90`，多级 `×0.90 ×0.90 ×0.80 = ×0.65`（含等效），无折扣不显示。
- **单项折扣**（`line.discountRate`，每行一个）与整单折扣链相互独立、叠加生效：行折扣先作用于各行小计，整单折扣链再作用于合计。
- **行级多级折扣**：明细行也可以带折扣链 `line.discountRates`（如 `[0.9, 0.9, 0.8]`），口径与整单折扣链完全一致——连乘得等效值，并把**等效乘积同步写进 `line.discountRate` 标量**。这样「过账后金额不变数」这条铁律不用改任何服务端代码就仍然成立：`orderToOrderDoc` 用 `{ ...l }` 原样搬行，`resolveLine` / `normalizeRate` 读的还是那个标量。开单页的勾选行批量设折扣就走这条路（见「开单页明细行批量操作」）。
- **折扣金额与优惠金额联动**：折扣链不仅展示折扣率，还会实时算出它从合计里减掉的**折扣金额（人民币）** `discountAmountOf(order) = round2(合计 × (1 − 等效折扣率))`，与「整单优惠金额」（`discount` 字段，抹零）并列作为应收/应付的减项，二者一起联动：改折扣率 → 折扣金额与应收同步更新。展示形态示例：
  - 详情页 info 区：`整单折扣：×0.90 ×0.90 ×0.80 = ×0.65（减 ¥352.00）`
  - 编辑弹窗结算明细：`整单折扣 ×0.90 ×0.90 ×0.80 = ×0.65（减 ¥352.00）` + `整单优惠金额 -¥48.00`
  - 自洽关系：`折扣金额 + 优惠金额 = 合计 − 应收`，即 `352 + 48 = 1000 − 600`。
  - 折扣金额**不入库**（可由 `discountRates + total` 还原），避免冗余字段与源数据失同步。
- **测试**：`tests/account-test.mjs` 的「折扣链」段用纯逻辑断言锁定连乘、旧标量回退、非法项剔除、展示文本格式，以及折扣金额与折后金额的互补关系（`折扣金额 + 折后金额 = 合计`）。

### 结清联动与红线（录入弹窗）
- **编辑单可直接改实收/实付金额**：打开任意采购单/销售单点「编辑」，`实收金额`（现金部分）变为**可编辑**，保存即按新金额重建该单现金收付流水；抵扣部分沿用原单已用预付款（`fromDeposit` 流水原样保留，避免重复扣减往来单位档案余额），改抵扣仍走「收款/付款」弹窗。新增单保持原行为（直接填本次现金实收 + 预付款抵扣）。
- **编辑单实付/实收的下限 = 已记现金流水合计**（`cashFloor`，不含 `fromDeposit` 抵扣笔）：这一栏看起来能随便调，实际**只能持平或往上调**（调高即补一笔付款/收款），调低不会生效——历史流水各自对应已开的资金凭证，编辑弹窗不替你删账。因此输入框带 `:min="cashFloor"`，结清联动算出的实付若低于下限，就把实付钉在下限、按剩余量反算优惠（仍保持未付款 = 0），输入框下方文案也明确说明「减少请到详情页『记录付款/收款』里逐笔删改」。此前该框允许填任意小值、填了静默无效，是易用性坑。
- **结清模式下「以用户手填金额为基准」**：选「结清」后，未付款必须为 0。三个金额（实收、抵扣、整单优惠）中**用户手填的那一项为基准，另一项自动补差**以保持未付款=0：
  - 填「实收金额」或「抵扣」→ 整单优惠自动补差 = `毛额 − 实收合计`（毛额 = 合计 × 整单等效折扣率，不含优惠金额）；
  - 填「整单优惠金额」→ 实收自动补差 = `毛额 − 优惠 − 抵扣`。
  - 计算入口统一走纯函数 `settleBalance({gross, paidNow, depositPay, discount, anchor})`（`src/utils/account.js`），锚点 `anchor` 取最近被手填的字段；挂账模式下三项相互独立、互不联动。
  - 例：应付 10 元、选结清、手填实收 8 元 → 优惠自动变 2 元（未付款 0）；若再手填优惠 5 元 → 实收自动补成 5 元。
- **折后金额展示**：单据有折扣（整单折扣链或单项折扣）时，录入弹窗结算明细与单据详情页会额外显示**「折后金额」**（应用全部折扣后、未扣优惠前的金额 = `合计 × 整单等效折扣率`，纯函数 `discountedTotalOf`）。它与「折扣金额」「整单优惠金额」「应收/应付」构成清晰链路：`原价合计 → 整单折扣链 → 折后金额 → 整单优惠(抹零) → 应收/应付`。无折扣时不显示（折后金额＝合计）。
- **结清联动的补差读的是「v-model 落地后的值」**（`markAnchor` + `nextTick`）：`el-input-number` 的 `input` 事件比 `update:modelValue` **早一步**发出（Element Plus `handleInput` 先 `emit('input')` 再写回模型），所以在 `@input` 里直接算补差，读到的是**上一个值**。踩到的现场：实收先填 7 → 点「结清」（优惠补成 68）→ 把实收改成 75 → 联动仍按 7 算，优惠停在 68，页面出现「应收 7 / 实收 75 / 未收 0」的自相矛盾，保存还会撞红线①。现在三个金额框的 `@input` 只记锚点（`markAnchor('paid'|'discount'|'deposit')`），等一个 tick 让值落地后再 `reconcile()`。
- **结清模式下实收/实付框还有上限 `cashCeil` = 折后金额 − 已用抵扣**：结清单据多收的部分只能变成优惠，收不进钱的数字不该让用户填出来（填 200 会被夹回 75）。挂账模式不封顶（多收可转预存，由红线提示）；上限低于下限时也不封顶，避免历史超付单据被夹死。
- **红线校验①（实付上限）**：保存单据时，累计实付/实收合计**不得超过应收/应付总额（合计 × 折扣链 − 整单优惠）**，超出 `> 0.005` 元（容忍半分钱浮点尘）**直接报错拦截、不保存**。上限取的是 `grossOf`（总额），**不是 `payableOf` / `receivableOf`（未付/未收余额）**——结清单据的余额恒为 0，误用余额当上限会把「实付＝应付」的正常单据全拦下：编辑任何一张已付满的单保存不了、新增时选「结清」并填实付也保存不了。**这个错误自 `1f3fc72`（2026-10-26）引入起就存在，2026-10-29 修掉**；判定式已抽成纯函数 `overpaidOf(order, kind)`（返回超出额，欠付夹 0），前端与测试共用同一入口，避免再有人拿余额当总额。提示文案分两种：新增单提示「调低实付金额或减少抵扣」（照做即可）；**编辑单不再给这种走不通的建议**——编辑弹窗不会改写历史收付款流水（每笔流水各自对应已开的资金凭证），提示改为指向详情页「记录收款/付款」逐笔修改，或把应付/应收（合计、折扣、优惠）调回不低于已付金额，多付部分可转预存款/预付款。
- **红线校验②（结清未付款=0）**：保存单据时，若结算状态为「结清」且按金额算出的未付款 `> 0.005` 元（容忍半分钱浮点尘），**直接报错拦截、不保存**，提示用户调高实收或优惠。结清时小额超额（实收 > 毛额）被 ≥0 夹取吸收，不制造欠款。
- **测试**：`tests/account-test.mjs`（`node tests/account-test.mjs`，27 项）三段覆盖：①「总额 ≠ 余额」——结清单据不拦、未付满不拦、真超额才拦且超额额准确、整单优惠与多级折扣链进入上限、旧字段回退、红字退货单与 `settlements` 核销不误拦、红线②与 `settleActionOf` 三种动作口径；② `settleBalance` 结清联动——`anchor='paid'/'discount'` 各自补差、抵扣只凑钱不计入返回的现金额、超额与非法输入夹 0、与 `grossOf`/`payableOf` 联动后未付恰为 0；③ 折扣链口径（见上节）。`settleBalance` 此前在仓库内无任何测试覆盖（旧文档提到的 `money-test.mjs` 从未入库），本轮补齐。④ 弹窗时序（`@input` 早于 v-model、上下限夹值、自动结清）在纯 Node 里测不出来，另由真浏览器用例 `tests/settle-link-browser-test.mjs` 覆盖：先 `npx vite --port 5173 --strictPort` 起 dev server，再 `node tests/settle-link-browser-test.mjs`（5 项，全部走 `context.route('**/api/**')` 的内存数据，不碰线上仓）。把 `markAnchor` 换回 `reconcile('paid')` 直接跑，第 1 条就会以「优惠停在 68」复现本次 bug。

### 客户类别与商品分级售价
- 客户有类别：`批发` / `零售` / `安装师傅`，列表可按类别筛选。
- 商品有对应的三档售价：`priceWholesale`（批发价）、`priceRetail`（零售价）、`priceInstaller`（安装师傅价）。
- 新增销售单时单价**按客户类别自动带出对应档位价格**，优先级为：
  **客户类别对应分级售价 → 该客户最近成交价 → 商品当前售价**，带出后仍可手动修改。

### 编码自动流水
商品 / 供应商 / 客户在「新增」表单中，**编码默认按流水号自动预填**（取同类现有最大序号 +1：`P00001` / `S00001` / `C00001`），可手动修改。

### 用户信息与打印落款
- 「系统 → 用户信息」（`/profile`，`src/views/Profile.vue`）保存自己的**联系名称 / 电话 / 地址 / 备注**，存数据仓 `profile.json`（单份覆盖，不是列表）。四个字段服务端限长 40 / 60 / 160 / 200 并裁空白，页面带「打印落款预览」，所见即所印。
- 销售单、采购单、订单详情页顶部都有「**显示用户信息**」勾选框：勾选后落款出现在商品列表**下方**，打印（A4）与页面同一位置、同一口径（`printA4()` 第 6 参 `footerFields` → `.foot` / `.fi`）。
- 落款字段全空时不产生落款块（不印一排空标签），并提示「尚未填写用户信息，请到「系统 → 用户信息」补充」；取消勾选后页面与打印一起消失。

### 外链分享（只读）
详见 [docs/shares.md](docs/shares.md)。要点：
- 销售单 / 采购单 / 订单详情页的「**分享**」按钮生成只读链接 `https://<站点>/share/<token>`，对方打开只能看，**没有任何编辑入口**，也不需要登录。作废单不显示分享入口。
- 分享只保存「指向哪张单」，不复制单据内容：单据改名、改金额即时生效；单据被删除或作废时链接自动 `404`，不会出现两份数据对不上。
- 「系统 → **外链分享**」（`/shares`）统一汇总三类单据的全部链接，可**复制链接、查看二维码、改时效、取消**；有效期支持 1 / 7 / 30 天与长期有效。

### 打印排版（纸张、字号与分页）
- **纸张统一在「打印设置」里选**（`PrintHeaderToggle`，页面上只有一个「打印」按钮）：A4 / A5 / 自定义三选一，再选横向 / 纵向，**默认 A4 纵向**；按钮上直接显示当前纸张与方向（如「A4 纵向」「100×150mm」）。面板里实时显示**自动算出的每页行数**与拆解（`每页 N 行 = 标头 X 行 + 商品 Y 行（首页）`、`后续页：商品 N 行`）：换 A4 / A5 / 自定义、切横纵向、改宽高都会即时重算；数字与切片用的 `rowsPerPageOf()` / `headRowsOf()` 同源，手动填「每页行数」时标注「手动」并附上自动值。设置存 `localStorage`（`stock.print.paper`），全站所有打印入口（列表、单据详情、订单批量、模板）共用同一份。
- **纸张换算**（`src/utils/export.js`）：`PAPER_SPECS` 里 A4 / A5 给的是横向尺寸（A4 基准 11px、A5 基准 9.5px），每页行数不分横纵，统一由 `rowsPerPageOf()` 按纸高与「虚拟边距」重算（旧常量 40 / 28 只是历史参考，真机边距一宽就会每页多排几行、把尾巴挤到下一张纸）；自定义纸张按填入的宽高出纸，字号按纸宽取 11px / 9.5px 两档，每页行数按纸高推算或手填。`paperSpec()` 是唯一解析入口，`printA4(…, paper)` 的 `paper` 参数只为脚本调用留覆盖口，页面按钮不再传它。
- 单头字段可带强调样式：`tone = 'hl'` 加框强调（整单折扣用），`tone = 'xl'` = **基准字号 × 1.2 并加粗**（A4 下 13.2px，A5 下 11.4px）。**订单金额**、模板合计统一用 `xl`；以前是写死的 24px＝正文两倍，太大且换纸张就飘。所有强调字号都从同一个 `base` 按比例算，所以「1.2 倍」在 A4/A5 上都成立。
- **跨页每页都要重复商品表头**：不再指望浏览器自觉实现 `thead { display: table-header-group }`。`packPageSlices()` 先按「每页行数」把明细切成若干片，每片渲染成**自己带 `<thead>` 的 `<table>`**，片与片之间 `page-break-after: always` ⇒ 分片数就是真实页数（Chromium 出 PDF 实测相等，销售单/采购单/订单都验过）。首页扣单头预留、末页扣 2 行给落款，保证单头/落款不会把某页顶到多出一张纸。
- **按「折行后的行数」而不是「条目数」分页**：`rowLineCosts()` 依据每列实际宽度估算一条明细会折几行（名称折成两行就占两行高度），`packPageSlices()` 按累计行数切页。以前只数条目，长名称一多就会溢出，而每片末尾强制换页，溢出的那两三行会单独占一张纸、下面全空。
- **行数预算用「虚拟边距」**：`@page` 写 8mm，但 iOS / AirPrint 一类链路实际边距常是 12.7mm 左右，按 8mm 算的行数每页会多排两三行、把尾巴挤到下一张纸（故出现「第二页只有几行」）。`rowsPerPageOf()` 因此按至少 24mm 边距推算（窄纸按纸高 16% 封顶），每页底部会留几行余量；真机仍不够时可在打印设置里手动调小「每页行数」。
- `th, td { line-height: 1.25 }` 是「每页 40 行」这条预算的前提：用默认 `normal` 时行高跟随本机中文字体（每行约高 4px），实测 4 片会被排成 7 页。
- 单头无值字段自动过滤；明细没有行折扣时打印隐藏「折扣率 / 本次折扣」两列，有整单折扣时保留「折后金额」列，行合计与单头折后金额分文不差（`allocateNetOf()` 累计取整）。
- **所有能打印的位置只有一个「打印」按钮**（列表工具栏 `TableToolbar`、订单列表行、订单批量详情页弹窗、单据详情页、订单模板），纸张、方向、每页行数、跨页表头统一在按钮旁的打印设置里改；订单模板另有「空表」按钮，空表同样按当前纸张设置出纸。
- **跨页列宽必须一致**：`columnWidths()` 按**整份明细**（不是每一片各自的内容）算一次列宽，写成每片表共用的 `<colgroup>` + `table-layout: fixed`。自动布局下第 1 页有「PE管外牙直接50\*112M」这种长名称、末页只有短行，两页的列就会错开。权重按显示宽度取（中日韩算 2、半角算 1），夹在 4~44 之间，并给每列额外留 2 个半角宽的内边距——不留白的话「编码」这种列会换行，一行变两行，每页 40 行的预算就崩了。
- **跨页表头可以关掉**（`PrintHeaderToggle`，默认开）：勾上＝按每页行数切片、每页重复商品表头；取消＝整份明细一张连续大表，表头只印第一页。关闭时除了不再切片，还必须把 `thead { display: table-header-group }` 改成 `table-row-group`，否则 Chromium 会自己按那条声明在续页顶上重排表头，这个选项就名不副实了。A4 / A5 共用这一个开关，选择记在 `localStorage`（`stock.print.repeatHeader`），换页面、重开浏览器都还在。

### 订单页「从模板导入」
- 订单列表表头的「**从模板导入**」打开模板选择窗，选一份模板后把它的商品明细（数量、单价、行折扣率）**预填进新建订单表单**——不是直接落库：客户/供应商、日期、整单折扣仍然由用户现场填，改完再保存。
- 实现上复用既有链路：`OrderFormDialog` 认「没有 id 的 `props.order`」为预填草稿，标题、保存、单号生成一律按新建处理，所以「导入」不需要也不可能绕开列表页那一份 `POST /api/orders { action: 'save' }`。
- 金额三条路径同一口径（模板列表、导入弹窗、表单合计）：模板行只有 `qty/price/discountRate` 没有 `total`，必须先按 `normalizeRate` + `round2` 补出行小计，再交给 `orderAmount()`；直接把模板原样丢进去会算出 ¥ 0.00。

### 折后单价
- 销售单 / 采购单 / 订单的明细在有整单折扣时多一列「**折后单价**」，页面、单张打印、CSV 同一口径（`src/utils/account.js` 的 `allocateUnitOf()`）。
- 算法口径：先用 `allocateNetOf()` 按累计四舍五入把整单折扣摊到每行金额（铁律是 **Σ行折后金额 = 单头折后金额**），再用 `行折后金额 ÷ 数量` 得到折后单价。
- 折后单价是**展示值**，不参与任何金额计算：`折后单价 × 数量` 与该行折后金额可能差 1 分钱（数量越大越明显），这是保证合计不变的必然结果。反过来若为了让每行 `单价×数量=行金额` 去改金额，就会破坏合计，属于不允许的做法。
- 勾选「隐藏单价」（不给对方看进价/售价）时该列一并隐藏。

### 订单模板
详见 [docs/templates.md](docs/templates.md)。要点：
- 「业务 → **订单模板**」（`/templates`）可以建**多份**模板，每份预设一批商品（商品 + 数量 + 单价 + 行折扣），不存客户/供应商、不存金额。
- 模板支持新增 / 编辑 / 删除 / **复制**，上限 100 份、单份 200 行。
- **一键转订单**：选类型（销售/采购）、往来单位、日期、业务单号后按订单口径 `orderAmount()` 重算金额，走 `POST /api/orders` 的 `save` 生成未过账订单并跳详情页。
- **打印**：`打印` / `空表` 两个按钮，纸张跟在打印设置里选的一致；正常打印带数量单价小计与合计，空表只有编码 / 商品名称 / 单位，**不出现任何数量、单价、金额**，用于手写勾选。
- 订单列表还有「**从模板导入**」：挑一份模板把明细预填进新建订单表单（详见上面「订单页从模板导入」）。

### 整页开单路由（销售 / 采购 / 订单）
- 列表页表头只保留「新增销售 / 新增采购 / 新建订单」弹窗入口，**不再有「新页面开单」按钮**；`/sales/new`、`/purchases/new`、`/orders/new` 三个整页路由仍保留，书签、外链、历史链接直接打开依然可用。
- 实现口径：`src/utils/entryMode.js` 返回 `{ entry, backToList }`，由路由判断是否整页开单；表单保存链路仍复用列表页那一份代码——另起一套保存链路会让金额口径漂移。
- 新标签页靠路由 `meta.standalone` 去掉应用外壳：`App.vue` 在这种路由下不渲染侧边菜单与顶栏，整个窗口**只有开单表单**（需求原话是「只有开订单的窗口」）。该分支必须排在登录检查之后，票据过期时这个标签页也要能落到登录页。
- 新标签页的「返回」是 `window.close()`（脚本自己开的标签页才允许关）；关不掉（比如手动输地址进来的）就 `router.replace` 回列表。整页模式不显示右上角 ×，只留「返回」一个出口，保存成功后同样自动关闭/回列表。
- 整页模式的明细表高度从 320px 提到 480px，几十行商品不用再在小窗里来回滚。

### 开单页明细行批量操作
详见 [docs/line-discount.md](docs/line-discount.md)。要点：
- 新增/编辑采购单、销售单、订单的表单里，每行明细前有**勾选框**（表头可全选），上方「批量设置折扣（已选 N 项）」与「批量删除（已选 N 项）」两个按钮，未勾选时禁用。
- 批量折扣弹窗（`src/components/LineDiscountDialog.vue`）两种给法：**统一折扣链**（一组级联折扣率套用到所有勾选行，可逐级增删，实时显示累计等效与逐行折后预览）与**逐行单独设置**（每行一个折扣率，可就地展开成多级链）。
- 预览与写回共用 `applyLineRates()`：先 `round2` 折扣额、再从原价里减，绝不出现「预览一个数、落库另一个数」。
- **批量删除**走 `ElMessageBox` 二次确认，按行索引倒序移除（正序删会错位），删完清空勾选态。
- 金额不另算：写回只改行上的折扣字段，小计、合计、原价合计、单项折扣、整单折扣、应收/实收全部由既有 computed 重算。
- 已动过钱的单据（`moneyLocked`）不出现勾选框与批量按钮，仍然只能走「变更明细」生成退货单 / 补差单。

## 本地开发
```bash
npm install
npm run dev
```

## 部署
```bash
npm run cf:deploy
```
部署前需设置 GitHub Token 为 Worker 的 secret（用于读写数据仓）：
```bash
npx wrangler secret put GITHUB_TOKEN
```
`wrangler.json` 中已配置 `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH`，对应数据仓 `idakcl/stock-git-ai-data@main`。

**访问地址**（两个都可用，自定义域名为主）：
- 自定义域名：https://stock-git-ai.1234.nyc.mn/ （已固化在 `wrangler.json` 的 `routes.custom_domain`，部署不会丢失）
- workers.dev：https://stock-git-ai.dakcl.workers.dev/

> 提示：`*.workers.dev` 域名在国内常被网络干扰，已为该 Worker 绑定自定义域名（Custom Domain）以获得稳定访问。

**可复现构建（省流量）**：页面与抽屉里显示的「构建 …」是注入的 `__BUILD_TIME__`，取值改为 **短 sha · 该提交的提交时间**（`vite.config.js` 的 `buildStamp()`，CI 上用 `GITHUB_SHA`，本地用 `git rev-parse`），不再是构建当刻的墙上时间。此前注入 `new Date()` 会让同一份源码每次构建的内容哈希都不同 → JS 产物文件名每次都变，Cloudflare 视作全新资源，**每次部署整份重传约 1.38MB**；现在同一 commit 重复构建字节完全一致（文件名不变即命中去重），左下角显示的还是真正的版本号。

## 商品改名全站即时生效
单据 `items[].name` 是开单时冻结的**快照名**，商品在主数据改名后，历史单据不会自动变。展示层统一按「编码 → 主数据当前名」解析（`src/utils/catalog.js` 的 `lineDisplayName` / `withCurrentNames` / `aggregateByItem`）：

- **详情页 / 列表搜索 / 应收应付搜索**：按编码取商品主数据当前名，旧单也显示新名，用新名或编码都能搜到旧单。
- **统计报表按商品汇总**：按**编码**分组（无编码的历史行退化为按名字），同一商品只出一行，改名不会让汇总裂成两行。
- 存储层不动历史快照（审计需要），仅展示层解析；如确需连快照一起改，可对数据仓执行一次性订正。

## 登录与安全（重要）

系统已启用登录保护。打开站点会先进入登录页，验证通过后才加载任何业务数据。

### 登录方式
- 打开站点 → 输入**管理密码** → 登录（默认勾选「记住登录」，30 天内免登录）
- 登录态保存在浏览器本地；点右上角「退出登录」立即失效
- 会话默认 12 小时过期，勾选记住我则为 30 天；过期后任意操作会提示重新登录

### 修改密码
密码与签名密钥保存在 Cloudflare Worker Secret（**不写入代码、不进仓库**）：

```bash
npx wrangler secret put APP_PASSWORD      # 登录密码
npx wrangler secret put SESSION_SECRET    # 会话签名密钥（随机串即可）
```

`SESSION_SECRET` 可用 `openssl rand -hex 32` 生成。修改 `SESSION_SECRET` 会使所有已登录会话立即失效。

### 安全设计
| 措施 | 说明 |
|---|---|
| 全站鉴权 | 除 `/api/login`、`/api/session` 与公开的 `/api/share/<token>` 外，所有读、写接口均校验 `Authorization: Bearer <票据>` |
| 票据签名 | HMAC-SHA256 自签票据，含过期时间；密钥在 Secret 中，前端不可见 |
| 常量时间比对 | 密码与签名比对均为常量时间，避免时序侧信道 |
| 登录节流 | 同一来源连续失败 6 次锁定 15 分钟，返回剩余尝试次数 |
| CORS 白名单 | 仅允许 `ALLOWED_ORIGINS` 中配置的域名，不再对全网开放 |
| 派生数据保护 | 库存为采购/销售派生数据，禁止直接写入（返回 403），须由单据重建 |
| 安全响应头 | `X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` |
| 数据仓私有 | 数据仓应设为 private（`gh repo edit idakcl/stock-git-ai-data --visibility private`） |

> 注意：GitHub Token 与登录密码均存放于 Worker Secret，仓库代码里没有任何凭据。
