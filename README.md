# 进销存系统（GitHub 数据仓 + Cloudflare 部署）

单 Worker 同时托管：
- 前端静态资源（Vite 构建产物 `dist/`，通过 `assets` 绑定 `ASSETS`）
- 后端 API（`/api/*`，读写 GitHub 数据仓 JSON）

## 目录
- `src/` — Vue 3 + Element Plus 前端
- `api/github.js` — GitHub API 读写辅助
- `api/routes.js` — API 路由 + 自动推导逻辑（`derive` / `rebuildStock`）
- `web/index.js` — Worker 入口（静态 + SPA 回退 + API）
- `wrangler.json` — Cloudflare Workers 配置

## 数据仓
独立 GitHub 仓库 `stock-git-ai-data`，JSON 文件：
`items.json / suppliers.json / customers.json / purchases.json / sales.json / stock.json / logs.json`

数据仓由 Worker 直接读写，是系统的**唯一数据源**。

## 数据模型

### items.json（商品目录）
每个商品除了基础字段，还带有与供应商的关系链接和历史价：

| 字段 | 说明 |
|---|---|
| `code` / `name` / `unit` | 编码、名称、单位 |
| `cost` / `price` | 当前进价、当前售价 |
| `warning` | 库存预警值 |
| `package` | 包装规格，如 `"90个/件"` |
| `suppliers` | **关联供应商 code 数组**，如 `["G001"]` |
| `purchaseHistory` | **历史采购价明细**数组（见下） |
| `saleHistory` | **历史销售价明细**数组（见下） |

历史明细条目结构：
```json
{
  "date": "2026-10-11",
  "supplier": "G001",
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
| `products` | **关联商品 code 数组**，由商品 `suppliers` 反推（双向链接） |

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
  "items": [ { "code": "S001", "name": "三通国标25", "qty": 20, "price": 2.72, "total": 54.4 } ],
  "total": 736.2
}
```

## 自动推导（核心机制）
保存采购单 `POST /api/purchases`、销售单 `POST /api/sales`、AI 导入 `POST /api/import` 后，后端自动调用 `derive()` + `rebuildStock()`（`api/routes.js`），从单据**重建**以下数据并回写 GitHub 数据仓：

1. `商品.suppliers` —— 供应商关系链接
2. `商品.purchaseHistory` / `saleHistory` —— 历史采购价 / 销售价
3. `供应商.products` —— 关联商品（与商品.suppliers **双向链接**）
4. `stock.json` —— 库存数量与最近进价

设计要点：
- **单一数据源**：所有关系与历史价都由采购单 / 销售单派生，手工只维护单据，永不失步。
- **幂等**：历史每次从单据全量重建（而非追加），同一单据重复保存不会让历史翻倍。
- 新供应商在采购单中出现时自动建档（`G` + 序号）；新商品在单据中出现时自动建档。

## 前端展示
- **商品管理页**：新增「供应商」列；每行可**展开**查看「历史采购价」「历史销售价」两张明细表（日期 / 供应商或客户 / 数量 / 单价 / 金额）。
- **供应商页**：新增「关联商品」列，展示该供应商关联的全部商品。

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

> 提示：`*.workers.dev` 域名在国内常被网络干扰，建议为该 Worker 绑定自定义域名（Custom Domain）以获得稳定访问。
