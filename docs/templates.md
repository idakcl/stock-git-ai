# 订单模板（可多份、可一键转订单、可打印、可打印空表）

## 一、功能定位

把「常用商品组合」存成可复用的模板，每次下单时一键生成订单，避免重复录入同样的商品清单。

**典型场景**：
- 某个客户每次订货都是同样的 10 种管件，数量固定 → 存成「客户 A 标准配件包」模板
- 采购时经常向某供应商补货同样的商品 → 存成「供应商 B 补货清单」模板
- 需要打印一份空白商品清单给客户手写勾选 → 打印「空表」（只有商品名称/编码/单位，不出现数量/单价/金额）

## 二、数据模型

模板只存**商品明细**，不存客户/日期/单号（这些信息每次生成订单时由用户现场填写）：

```json
{
  "id": "T<timestamp><random>",
  "name": "常用管件组合",
  "kind": "sale",           // sale | purchase
  "items": [
    { "code": "P00001", "name": "管件", "unit": "个", "qty": 10, "price": 10, "discountRate": 0.9 }
  ],
  "createdAt": "2026-10-30T...",
  "updatedAt": "2026-10-30T..."
}
```

**字段说明**：
- `id`：自动生成，`T` + 时间戳 base36 + 随机串
- `name`：模板名称，最长 60 字
- `kind`：`sale`（销售模板）或 `purchase`（采购模板）
- `items[]`：商品明细，每条包含 `code/name/unit/qty/price/discountRate`
- **不存金额**：金额由 `orderAmount` 在生成订单时按订单口径重算，保证「模板打印」与「转订单」两条路径的金额口径完全一致

**上限保护**：
- 模板总数上限：100 个
- 单模板商品行数上限：200 行

## 三、接口契约

### 读接口

**`GET /api/templates`**（需票据）

返回模板数组，按创建时间倒序：

```json
[
  {
    "id": "T...",
    "name": "常用管件组合",
    "kind": "sale",
    "items": [...],
    "createdAt": "...",
    "updatedAt": "..."
  }
]
```

### 写接口

**`POST /api/templates`**（需票据）

请求体：

```json
{
  "action": "create" | "update" | "delete" | "duplicate",
  "id": "模板 ID（update/delete/duplicate 时必填）",
  "template": {
    "name": "模板名称",
    "kind": "sale",
    "items": [...]
  }
}
```

返回：

```json
{ "ok": true, "template": {...} }  // delete 时返回 { "ok": true }
```

**动作说明**：

| action | 入参 | 行为 |
|---|---|---|
| `create` | `{ template: { name, kind, items } }` | 新建模板。`name` 限长 60 字，`kind` 必须为 `sale` 或 `purchase`，`items` 至少 1 行且不超过 200 行。模板总数超过 100 个时拒绝创建 |
| `update` | `{ id, template }` | 更新模板名称与明细。`id` 不变，`createdAt` 不变，`updatedAt` 更新为当前时间 |
| `delete` | `{ id }` | 删除模板。模板不存在时返回 404 |
| `duplicate` | `{ id }` | 复制模板。生成新 ID，名称追加「（副本）」，模板总数超过 100 个时拒绝复制 |

**校验规则**：
- `name`：不能为空，超长截断
- `kind`：必须是 `sale` 或 `purchase`
- `items[]`：每行必须包含 `code`（非空）、`qty`（>0）、`price`（>=0）；`discountRate` 非法值按 1 处理（复用 `normalizeRate`）

## 四、前端入口

| 位置 | 组件 | 作用 |
|---|---|---|
| 业务 → 订单模板（`/templates`） | `src/views/OrderTemplates.vue` | 模板列表：新建、编辑、删除、复制、一键转订单、打印、打印空表 |
| 模板编辑弹窗 | `src/components/TemplateFormDialog.vue` | 新增/编辑模板：选商品、填数量/单价/折扣率 |
| 一键转订单弹窗 | 内嵌在 `OrderTemplates.vue` | 选客户/供应商、日期、业务单号后生成订单 |

## 五、一键转订单

从模板生成订单时，金额口径必须走 `orderAmount`（与订单/单据完全一致）：

1. 用户在模板列表页点「转订单」，弹出确认窗口
2. 选择订单类型（销售/采购）、客户/供应商、日期、业务单号
3. 前端按模板明细生成订单草稿，调用 `POST /api/orders` 的 `{ action: 'save', order }` 接口
4. 生成成功后跳转到订单详情页 `/order/<id>`

**金额计算**：
- 每行小计 = `qty × price × discountRate`（复用 `normalizeRate` 与 `round2`）
- 订单金额 = Σ 行小计（无整单折扣时）
- 模板本身不存金额，生成订单时按订单口径重算

## 六、打印与空表打印

### 正常打印

调用 `printA4(title, columns, rows, subtitle, headerFields)`，列包含：
- 编码、商品名称、单位、数量、单价、折扣、小计
- `headerFields` 显示合计金额

### 空表打印

空表 = 只有商品名称（和编码/单位），**不出现数量、单价、任何金额**。用于手写。

调用 `printA4(title, columns, rows, subtitle)`，列只包含：
- 编码、商品名称、单位
- **不传 `headerFields`**（避免金额字段泄露）

同一个函数用 `empty` 开关切换列集，避免两套逻辑漂移。

## 七、测试

`tests/templates-test.mjs`（纯 Node 接口测试）覆盖：
- 空列表
- 创建（含字段裁剪与超长拒绝）
- 更新
- 删除
- 复制
- 行数与总数上限
- 非法 kind / 空明细 / 数量或单价非法的拒绝
- 生成订单时的金额口径（模板 2 件×10 元、行折 0.9 → 小计 18）

跑法：

```bash
node tests/templates-test.mjs
```

## 八、与现有约定的对齐

- **数据存数据仓私有 repo 的 `order-templates.json`**：用 `readCollection(env, 'order-templates')` / `writeCollection(env, 'order-templates', rows, message)`
- **校验复用现有纯函数**：`normalizeRate`（`src/utils/catalog.js`）、`round2`（`src/utils/account.js`）
- **金额口径与订单一致**：生成订单时调用 `orderAmount`（`src/utils/orders.js`）
- **打印用 `printA4`**：只传前 6 个参数，不依赖 `opts`（避免与 `export.js` 的同期改造冲突）
- **列表页样式参照 `Shares.vue`**：el-card + card-header + el-table + 操作列
