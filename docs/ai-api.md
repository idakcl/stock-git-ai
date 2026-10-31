# AI-API：给 AI / 脚本的限权接口

面向「把钥匙交给 AI」的场景：在左侧菜单 **AI-API** 里签发一把密钥，勾选它能做什么，
把密钥和接口地址交给 AI。AI 只能在你勾选的范围内读数据、开单；越权返回 403，吊销立即失效。

与登录态接口（`/api/...` + 管理密码票据）的关系：同一份数据、同一套派生与事务，
区别只是**凭据**和**只开放操作型写接口**（不提供整表覆盖）。

---

## 1. 签发与管理

1. 左侧菜单 → **AI-API** → **新建密钥**。
2. 填名称（给谁用）、选有效期（1 / 7 / 30 / 90 天或**永久**）、勾权限。
3. 点 **签发**。完整密钥 `ai_live_…` **只显示这一次**，请立即复制或复制「使用说明」。
   还能复制一条**密钥链接**（`…/api/ai/v1/schema?key=ai_live_…`），对方打开即可看到能力清单；
   链接里带完整密钥，能走请求头时优先用请求头。
4. 之后列表里只保留前缀（如 `ai_live_AbCdEf…`），可随时 **改权限** 或 **吊销**。

安全设计：

- 明文密钥只在创建响应里出现一次；数据仓只存 **SHA-256** 与显示前缀，数据仓泄露也拿不到可用密钥。
- 吊销/改权限 **最长 15 秒**生效（Worker 内的密钥缓存）。
- 同时最多 **20 把生效中的密钥**；操作记录保留 60 条，吊销满 30 天的记录会自动清理。
- AI **永远不能**管理密钥、改登录密码、做备份恢复、清空数据 —— 这些能力不在任何权限里。
- 密钥走请求头 `Authorization: Bearer <key>`；也兼容 `?key=`，但会留在访问日志里，不推荐。

> 密钥就是钱：勾了开单权限的密钥，等于能把库存和应收改掉。按需勾选，用完即吊销。

---

## 2. 权限（scope）

权限拆得很细，是因为「能看成本」与「能开单」的风险完全不同。

### 查看

| id | 名称 | 说明 |
|---|---|---|
| `read:catalog` | 商品与库存 | 商品档案、规格价格、当前库存数量 |
| `read:docs` | 单据查询 | 订单 / 销售 / 采购 / 退货单的列表与明细 |
| `read:parties` | 客户供应商与欠款 | 往来单位档案、应收应付余额、来往账 |
| `read:vouchers` | 资金单据 | 收款单 `SK-` / 付款单 `FK-` 的列表、金额与关联单号 |
| `read:reports` | 报表汇总 | 区间营业额、采购额、单量等汇总数字 |
| `read:cost` | 看进价与毛利 | 成本价 / 进价 / 毛利（敏感，默认关闭） |
| `read:profile` | 看用户信息 | 打印落款里的姓名、电话、地址（敏感） |

### 操作

| id | 名称 | 说明 |
|---|---|---|
| `write:draft` | 建订单草稿 | 存成未过账，不占库存、不进欠款；可改 / 删自己建的草稿 |
| `write:templates` | 建改订单模板 | 模板增删改查，不影响任何单据 |
| `write:upload` | 上传图片 | 图片传到图床，返回链接 |
| `write:post` | 过账订单 | 草稿转正式单据，改库存与应收应付（敏感） |
| `write:docs` | 直接开销售单 / 采购单 | 跳过订单直接生成正式单据（敏感） |
| `write:refunds` | 退货退款 | 生成退货单，可能开出现金退款凭证（敏感） |
| `write:voids` | 作废单据 | 单据与关联凭证一起作废，账与库存归零（敏感） |
| `write:master` | 改商品 / 客户 / 供应商档案 | 改主数据（名称、价格、联系方式）（敏感） |
| `write:deposits` | 存 / 预付充值抵扣 | 给客户预存款 / 供应商预付款充值或抵扣，充值会生成收 / 付款单（敏感） |
| `write:payments` | 记收付款 / 结清 | 给已开的销售单收款、采购单付款或按差额结清（敏感） |
| `write:amend` | 变更已开单据 | 改明细：减少的生成退货单、增加的生成补差单，原单不动（敏感） |
| `write:shares` | 外链分享 | 生成 / 取消 / 改有效期的只读公开链接 |

预设按钮：**只读问答 / 开单助手 / 业务全流程 / 最大权限**。预设只是替你勾好，之后还能逐项微调。

**最大权限** = 上表全部勾满（可设为永久），但**不包含**密钥管理、改密码、备份恢复、清空数据。

---

## 3. 调用方式

基址：`https://stock-git-ai.1234.nyc.mn/api/ai/v1`

```bash
KEY=ai_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
BASE=https://stock-git-ai.1234.nyc.mn/api/ai/v1

# 先看能力清单（含当前密钥能调哪些接口）
curl -s -H "Authorization: Bearer $KEY" $BASE/schema

# 查商品（默认 50 条，可用 limit / cursor / q）
curl -s -H "Authorization: Bearer $KEY" "$BASE/items?q=三通&limit=20"
```

所有响应都是 JSON，且 **`Cache-Control: no-store`**（响应随密钥权限变化，任何一层都不缓存）。
分页统一用 `limit`（默认 50，最大 200）与 `cursor`（上一页返回的 `nextCursor`，为 `null` 表示到底）。

错误码：

| 状态 | 含义 |
|---|---|
| 401 | 缺少密钥 / 密钥无效 / 已过期 / 已吊销（信息故意笼统，避免被枚举） |
| 403 | 这把密钥没有该权限（错误信息会写明缺哪个 scope） |
| 400 / 404 / 409 | 参数错误 / 对象不存在 / 被引用或有下游单据，不能操作 |
| 429 / 500 | 上游限流 / 服务端异常 |

---

## 4. 读接口

| 方法 路径 | 所需权限 | 参数 |
|---|---|---|
| `GET /schema` | 无 | 返回权限目录、预设、接口表（每项带 `allowed`）、调用说明 |
| `GET /items` | `read:catalog` | `q`、`limit`、`cursor`；`read:cost` 才返回 `cost` |
| `GET /stock` | `read:catalog` | `low=1` 只看零库存/负库存；`limit`、`cursor` |
| `GET /orders` | `read:docs` | `status=draft\|posted`、`party`、`from`、`to`、`q`、`include=lines` |
| `GET /sales` | `read:docs` | `party`、`from`、`to`、`q`、`type=normal\|return`、`include=lines` |
| `GET /purchases` | `read:docs` | 同 `/sales` |
| `GET /parties` | `read:parties` | `type=customer\|supplier`、`open=1`（仅有余额）、`q`、`limit`、`cursor` |
| `GET /ledger` | `read:parties` | `party`（必填）、`type=customer\|supplier` |
| `GET /summary` | `read:reports` | `from`、`to`；有 `read:cost` 时附 `cost` / `margin` |
| `GET /profile` | `read:profile` | 无 |
| `GET /templates` | `write:templates` | 无 |

金额口径与页面完全一致：`gross` = 合计×整单折扣−优惠，`paid` = 累计实收/实付，
`unpaid` = 应收/应付余额（作废单为 0）。`/summary` 的 `cost` 按商品档案当前成本估算，不追溯历史成本。

---

## 5. 写接口

**通用规则**

- 所有写接口都必须带 `requestId`：16~80 位字母、数字或短横线。
  网络超时重试时**复用同一个值**，服务端据此保证不重复开单（返回 `duplicate:true` 与已存在的单号）。
- 金额一律服务端重算：只给 `code`（或已建档商品的名称）与 `qty`，单价默认取商品档案（销售取售价、采购取成本），
  可选 `price`、`discountRate`（0~1）。AI 自己算的 `total` 会被忽略。
- 直接开单与订单默认只接受**已建档**的商品编码；销售/采购的往来单位也必须已存在。
  确实要一步到底时，可在请求体顶层加两个显式开关（默认关闭、只对本次请求生效，见 5.6）。

### 5.6 自动建档开关（`allowNewItems` / `allowNewSuppliers`）

默认关闭。只有请求体顶层明确写了才生效，其他调用方行为完全不变。

```json
POST /api/ai/v1/purchases
{ "requestId": "req-20260203-0001", "allowNewItems": true, "allowNewSuppliers": true,
  "supplier": "新上供应商", "date": "2026-02-03",
  "items": [{ "name": "新阀门", "unit": "个", "qty": 3, "price": 12.5 }] }
```

- `allowNewItems`：明细行可以只写 `name`（+ `price` + 可选 `unit`）。解析顺序：
  按 `code` 找 → 按 `name` 精确匹配 → 都找不到才新建 `P` 编码。
  **新建时必须传 `price`**：销售单写入售价、采购单写入成本，另一项留 `null`。
- `allowNewSuppliers`：采购单 / 采购订单的供应商可以只写名称；建商品时 `item.suppliers`
  也可以直接写名称（与编码混传）。按名称精确匹配，命中就复用编码。
- 只写名称这类确定信息，不猜联系人/电话；条数不限，整单在同一事务里提交，任一条失败即整体回滚。
- 显式写了 `code` 却查不到 → 仍然 404（多半是打错，绝不悄悄换个编码建档）。
- 与单据同一次提交：要么全成、要么全不写；同一 `requestId` 重试不会重复建档。
- 返回里多出 `createdItems: [{ code, name }]` / `createdSuppliers: [{ code, name }]`，方便事后核对有没有写重复。
- 客户目前不开放自动建档（重名率更高），销售单仍要求客户先建档。

### `POST /orders` — 订单（需要 `write:draft`；过账另需 `write:post`）

```json
{ "action": "save", "requestId": "req-20260201-0001",
  "order": { "kind": "sale", "customer": "客户甲", "date": "2026-02-01",
             "items": [{ "code": "P00001", "qty": 3 }] } }
```

`action` 支持：

| action | 作用 |
|---|---|
| `save` | 新建或修改草稿（带 `order.id` 为修改）。不占库存、不进欠款 |
| `remark` | 只改备注：`{ action:'remark', orderId, remark }` |
| `delete` | 删除草稿：`{ action:'delete', orderId }`（已收订金/已过账不可删） |
| `post` | 过账：`{ action:'post', orderId }`，生成正式单据，改库存与应收应付 |
| `unpost` | 撤销过账（要求该单还没有任何收付款/退货/核销） |

### `POST /sales`、`POST /purchases` — 直接开单（需要 `write:docs`）

```json
{ "customer": "客户甲", "date": "2026-02-01",
  "items": [{ "code": "P00001", "qty": 3, "price": 12, "discountRate": 1 }],
  "discount": 0, "remark": "AI 代开", "requestId": "req-20260201-0002" }
```

服务端会：

1. 校验客户/供应商已建档、商品编码存在、数量 > 0、折扣在 0~1；
2. 按商品档案补全名称、单位、单价，逐行重算 `total`；
3. 生成单号（销售 `X…`、采购 `C…`），挂账、无收款流水，`createdBy: "ai:<密钥名>"`；
4. 一次 git 提交写入单据 + 重算库存/商品档案/供应商链接 + 审计日志。

返回 `{ ok, id, kind, amount }`。

### `POST /refunds` — 退货退款（需要 `write:refunds`）

与页面「退货 / 退款」同一套事务与校验：`action=create|settle`，参数见 `GET /schema` 与
[refunds.md](./refunds.md)。服务端按原单重新计算可退量与金额，不接受前端报价。

### `POST /voids` — 作废（需要 `write:voids`）

```json
{ "kind": "sale", "id": "X202602011000000001", "reason": "录错了" }
```

有变更单（退货/补差）、退货核销或共享收款单时会被拒绝（409），需先处理下游。

### `POST /master` — 主数据（需要 `write:master`）

```json
{ "type": "item", "action": "upsert", "item": { "name": "新阀门", "unit": "个", "price": 20, "cost": 13 } }
```

- `type`：`item` / `customer` / `supplier`；`action`：`upsert` / `delete`。
- 新增只填 `name`，编码自动生成（`P/C/S` + 5 位）；改档按 `code`（商品）或 `name`（客户/供应商）。
- **显式传了不存在的编码会 404**，绝不静默新建一个别的编码。
- 删除被单据引用的商品/往来单位、或还有预存/预付款流水的单位 → 409。
- 商品还能写 `photos`（http(s) 链接数组，≤20）与 `suppliers`（供应商编码数组，必须已建档）；新建时一并传即可直接挂上。
  传 `allowNewSuppliers: true` 时 `suppliers` 也可以直接写尚未建档的供应商名称，服务端按名称建档后挂上（返回 `createdSuppliers`）。
- 商品没填 `price` / `cost` 时**留 `null`**（不是 0）；显式传 `0` 才表示 0 元。
  传 `null` 或 `""` 表示清空该字段。注意：有销售/采购历史的商品，售价/成本会按最近一张单据回填（与网页端同一口径）。
- 客户 / 供应商可在新建时直接带预存/预付款流水，不必事后补：

```json
{ "requestId": "new-supplier-20261031-0001", "type": "supplier", "action": "upsert",
  "supplier": { "name": "新供应商", "contact": "张三",
                "advances": [{ "date": "2026-10-31", "amount": 300, "remark": "预付订金" }] } }
```

  `advances`（供应商预付款）/ `deposits`（客户预存款）每条：`date`（可省略＝今天）、`amount`（非零；正数存入、负数抵扣）、`remark`。
  正数流水会自动生成对应的 `FK-` / `SK-` 资金单据并回写编号；同一 `requestId` 重试不会重复加钱。
  返回里多一个 `balance`（该单位的可用预存/预付款余额）。

### `POST /deposits` — 预存款 / 预付款（需要 `write:deposits`）

```json
{ "requestId": "recharge-20261031-0001", "type": "supplier", "party": "S00001", "action": "add", "amount": 1000, "date": "2026-10-31", "remark": "银行转账" }
```

- `type`：`customer`（客户预存款） / `supplier`（供应商预付款）；`party` 可填编码或名称。
- `action`：`add` 充值 / `deduct` 抵扣 / `edit` 编辑 / `delete` 删除；`amount` 恒为正数。
- `edit` / `delete` 需要 `flowId`（充值接口返回，只有本接口写入的流水带）。已生成资金单据的流水：
  金额不能改、不能删，请用相反方向冲回。
- 充值 = 资金变动：同时生成一张无关联单号的收款单 `SK-` / 付款单 `FK-`，编号回写到流水。
- 抵扣不超过当前余额（409）；写错请用相反方向冲回，**不提供删除流水**（保证可审计）。
- 同一 `requestId` 重试返回 `duplicate: true`，余额不会重复增加。
- 返回 `{ ok, type, action, party, amount, balance, voucher, flowId, date }`；`balance` 是操作后的可用余额。
- 查余额：`GET /parties?type=supplier` 的每行多了 `prepaid` 字段（也可用 `GET /ledger` 的 `prepaid`）。

### `POST /payments` — 收付款（需要 `write:payments`）

```json
{ "requestId": "pay-20261031-0001", "kind": "sale", "id": "X202602011000000001",
  "action": "pay", "amount": 100, "date": "2026-10-31", "remark": "微信" }
```

- `action=pay` 记一笔；`action=settle` 按当前未收 / 未付差额一次结清（不用传 amount）。
- 金额不能超过未收 / 未付（409）；多余的钱请用 `/deposits` 记成预存款 / 预付款。
- 写入单据 `payments`，同步 `received/paid` 与结算状态，并生成关联单号的 `SK-` / `FK-` 资金单据。
- 作废单、退货单不能收付款；同一 `requestId` 重试只记一次。
- 返回 `{ ok, kind, id, amount, outstanding, settle, voucher }`。

### `POST /amends` — 变更已开单据（需要 `write:amend`）

与页面「变更明细」同一套事务：原单不动，减少的商品生成退货单、增加的商品生成补差单。

```json
{ "requestId": "amend-20261031-0001", "kind": "sale", "sourceOrderId": "X202602011000000001",
  "party": "客户甲", "date": "2026-10-31",
  "refundLines": [{ "index": 0, "qty": 1 }],
  "amendLines": [{ "code": "P00002", "qty": 2 }],
  "reason": "客户改单", "mode": "pending" }
```

`refundLines` 用原单明细下标 `index`（先 `GET /sales?include=lines` 查），`amendLines` 用商品编码。
同一 `requestId` 幂等。

### `GET /vouchers` — 资金单据（需要 `read:vouchers`）

`type=receivable|payable|all`、`party`、`from`、`to`、`q`（单号 / 单位 / 关联单号 / 备注），
返回 `{ total, nextCursor, vouchers: [{ code, kind, category, party, date, total, items }] }`。

### `POST /shares` — 外链分享（需要 `write:shares`）

`action=create|update|cancel`：`create` 传 `kind=sale|purchase|order` + `docId` + `days`（0＝长期）；
`cancel/update` 传 `token`。`GET /shares` 列出当前链接。

### `POST /templates` — 订单模板（需要 `write:templates`）

`action=create|update|delete|duplicate`，字段与页面一致，见 [templates.md](./templates.md)。

### `POST /upload` — 图片（需要 `write:upload`）

`multipart/form-data`，字段名 `file`，仅图片、≤10MB，返回 `{ url }`。

---

## 6. 给 AI 的最小提示词

把下面这段和密钥一起交给 AI：

```
你是本店进销存系统的助手。接口地址：https://stock-git-ai.1234.nyc.mn/api/ai/v1
请求头：Authorization: Bearer <密钥>
第一步先 GET /schema，它会告诉你：你有哪些权限、每个接口要什么权限、参数说明。
规则：
1. 只能用 schema 里 allowed=true 的接口。
2. 开单前先 GET /items 用编码确认商品与库存；不要自己编商品编码。
3. 写接口必须带 requestId（16~80 位字母数字短横线），重试复用同一个值。
4. 金额由服务端算，你只提供商品编码与数量；不要相信自己的算术。
5. 报错按 401/403/400/409 分类处理，不要盲目重试。
```

---

## 7. 调用日志

页面右上角 **调用日志**（接口 `GET /api/ai-logs`，仅登录态）能看到每一次调用：
时间、密钥名、`方法 + 路径`、状态码、耗时、产生的单号或错误信息。可按密钥、结果（成功 / 失败 / 401 / 403 / 400）筛选，也可搜接口、单号、错误信息。

几个取舍：

- **不记请求体**，也不记密钥明文（`?key=` 会被剔除），日志泄露也拿不到可用的东西。
- 日志 **不阻塞业务**：写日志失败只丢记录，不影响这次调用返回。
- 为了省 GitHub 写入配额，同一瞬间的并发调用会先在 Worker 内存里合并，再于响应结束后 1.2 秒左右
  写一次（`ctx.waitUntil`，不拖慢响应）；打开日志页会先强制冲刷一次，所以刚发生的调用也能立刻看到。
- 只保留最近 **7 天**、最多 **1500 条**，超出自动丢弃最老的。
- 写操作的业务审计仍在数据仓 `logs.json`（`source: "ai"`），与这里的调用日志互不替代：
  前者回答「改了哪张单」，后者回答「谁在什么时候调了什么、成没成」。

---

## 8. 实现位置

| 文件 | 作用 |
|---|---|
| `src/utils/aiScopes.js` | 权限目录 / 预设 / 接口表（前后端唯一口径，`/schema` 也用它） |
| `api/ai-keys.js` | 密钥存储（只存 SHA-256）、签发/改权限/吊销、使用统计、鉴权 |
| `api/ai.js` | 所有 `/api/ai/v1/*` 读写接口、金额重算、幂等、审计 |
| `api/ai-logs.js` | 调用日志：内存缓冲、合并落盘、保留策略、查询筛选 |
| `api/ai-catalog.js` | 单据里的自动建档（allowNewItems / allowNewSuppliers）：名称匹配、编码生成、整单事务提交 |
| `api/ai-deposits.js` | 预存款 / 预付款：充值 / 抵扣 / 编辑 / 删除、资金单据生成、requestId 幂等 |
| `api/ai-payments.js` | 单据收付款 / 结清：流水追加、结算状态同步、资金单据生成 |
| `api/routes.js` | `/ai/*` 分发；`/ai-keys`、`/ai-logs` 管理接口（仅登录态） |
| `web/index.js` | `/api/ai/*` 绕开边缘缓存（响应随密钥权限变化） |
| `src/views/AiApi.vue` + `src/components/AiScopePicker.vue` | 左侧菜单页面与权限勾选器 |
| `tests/ai-api-test.mjs` / `tests/ai-api-browser-test.mjs` | 62 项接口回归 + 8 项页面回归 |
