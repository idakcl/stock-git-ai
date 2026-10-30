# 开单页明细行批量操作（勾选 / 批量折扣 / 批量删除）

需求：新增或编辑采购单、销售单、订单时，商品明细每行前面有勾选框；一个「所选」入口可以为勾选的商品批量设折扣（支持多级折扣链，同时生效）；再有一个删除按钮删掉选中的行。

## 落点

| 文件 | 作用 |
|---|---|
| `src/utils/catalog.js` | 三个纯函数：`lineDiscountRatesOf` / `lineEffectiveRate` / `applyLineRates` |
| `src/components/LineDiscountDialog.vue` | 批量折扣弹窗（统一折扣链 / 逐行单独设置） |
| `src/components/OrderEditDialog.vue` | 采购 / 销售开单表单：勾选列 + 批量按钮 + 写回 |
| `src/components/OrderFormDialog.vue` | 订单开单表单：同上 |

弹窗与整页开单（`/sales/new`、`/purchases/new`、`/orders/new`）用的是同一个组件，所以批量操作在两种形态下自然一致。

## 行级折扣链的口径

行上允许两个字段并存：

- `discountRates: number[]` —— 折扣链本身，例如 `[0.9, 0.9, 0.8]`。
- `discountRate: number` —— **链的等效乘积**（上例为 `0.648`）。

`lineEffectiveRate(line)` 优先读数组、回退标量、非法项剔除；`applyLineRates(line, rates, gross)` 返回
`{ discountRate, discountRates, discount, total }`，其中 `discount = round2(gross × (1 − 等效率))`、
`total = round2(gross − discount)`。

### 为什么必须冗余写标量

过账时 `src/utils/orders.js` 的 `orderToOrderDoc` 用 `{ ...l }` 原样把行搬进正式单据，
而正式单据的金额计算（`resolveLine` / `normalizeRate`）只读 `discountRate` 标量。
只存数组就会在过账后把行折扣丢掉、金额变数——这是全站不允许的事。
反过来，只要等效乘积落在标量上，**服务端一行都不用改**，链数组纯粹是额外的展示信息。

### 与旧数据、旧行为的关系

- 早期行只有标量 `discountRate`：视为单级链，结果与现在完全一致。
- `discountRate = 0` 是既有口径里的「整行全免」（`normalizeRate` 认 0），所以 `lineDiscountRatesOf`
  对标量保留 0；批量弹窗里的折扣率输入框则直接限制 `min 0.01`，避免填 0 被当成非法值剔除后
  静默变回原价。
- 批量折扣只写回行上的折扣字段；小计、合计、原价合计、单项折扣、整单折扣、应收/实收全部由
  既有 computed 重算，弹窗内不另算一套金额。
- 预览（`lineNetWithChain`）与写回（`confirm`）走同一个 `applyLineRates`：先 `round2` 折扣额、
  再从原价里减。若预览直接算 `gross × rate`，双重取整会让「预览一个数、落库另一个数」。

## 勾选与批量删除

- 选中态是 `Set<行索引>`，由 `el-table` 的 `selection-change` 反查行对象在 `form.lines` 里的下标得到。
- 批量删除二次确认后**按索引倒序** `splice`（正序删会让后面的索引错位），删完清空勾选态并
  `clearSelection()`。
- 已动过钱的单据（`moneyLocked`）不渲染勾选列与批量按钮：那些单的明细只能走「变更明细」
  生成退货单 / 补差单，批量操作会绕过这条保护。
- 订单弹窗没有 `moneyLocked`：已过账的订单在列表页就没有「编辑」入口（`Orders.vue` 里按钮按
  `status === POSTED` 禁用），能进这张表单的订单本来就可改。

## 测试

| 文件 | 覆盖 |
|---|---|
| `tests/line-batch-test.mjs` | 纯逻辑：链规范化、连乘、`applyLineRates` 金额、向后兼容（`normalizeRate` / `resolveLine` 行为不变）、多级链等效值写回标量后过账金额一致 |
| `tests/line-batch-browser-test.mjs` | 真浏览器：勾选框与全选、按钮可用性、两种模式、批量删除确认、采购单与订单表单同样生效 |

```bash
node tests/line-batch-test.mjs
node tests/line-batch-browser-test.mjs   # 需先起 dev server：npx vite --port 5173 --strictPort --host 127.0.0.1
```
