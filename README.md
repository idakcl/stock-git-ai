# 进销存系统（GitHub 数据仓 + Cloudflare 部署）

单 Worker 同时托管：
- 前端静态资源（Vite 构建产物 `dist/`，通过 `assets` 绑定 `ASSETS`）
- 后端 API（`/api/*`，读写 GitHub 数据仓 JSON）

## 目录
- `src/` — Vue 3 + Element Plus 前端
- `api/github.js` — GitHub API 读写辅助
- `api/routes.js` — API 路由处理
- `web/index.js` — Worker 入口（静态 + SPA 回退 + API）
- `wrangler.json` — Cloudflare Workers 配置

## 数据仓
独立 GitHub 仓库 `stock-git-ai-data`，JSON 文件：
`items.json / suppliers.json / customers.json / purchases.json / sales.json / stock.json / logs.json`

## 本地开发
```bash
npm install
npm run dev
```

## 部署
```bash
npm run cf:deploy
```
部署前需设置 GitHub Token 为 Worker 的 secret：
```bash
npx wrangler secret put GITHUB_TOKEN
```
