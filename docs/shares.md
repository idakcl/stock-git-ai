# 外链分享（只读）与用户信息落款

给外部看单的两件事：**只能看、不能改**；**随时能收回**。
配套的小能力是「用户信息落款」——把自己店铺的联系方式印在商品列表下面，让发出去的单据自带署名。

## 一、设计前提：分享「指向」单据，而不是「复制」单据

一条分享记录只存三样东西：`kind`（`sale` / `purchase` / `order`）、`docId`、时效字段。单据内容**不落进分享**。

这样做的收益：

- 改名、改金额、加备注**即时生效**，不存在「分享出去的是旧版本」这种事故；
- 单据被删除或作废，链接自动失效，不需要额外做「同步清理」；
- `shares.json` 每条记录几十字节，不会因为分享多张单而膨胀。

代价是每次公开访问都要回源读一次单据集合，这本来就是对的——只读页必须反映当前账。

## 二、公开读取：脱敏是第一要务

`GET /api/share/<token>` 是**唯一不需要票据**的业务接口，注册在 `api/routes.js` 的 `verifyToken` **之前**。

返回的载荷由 `buildPayload()` 现场组装，只包含展示口径：

| 字段 | 内容 |
|---|---|
| `readOnly` | 恒为 `true`，前端据此不渲染任何操作入口 |
| `kind` / `share` | 单据类型、`token`、`createdAt`、`expiresAt` |
| `doc` | `id`、业务单号 `no`、`date`、往来单位及其标签、单据中文名、状态、备注、是否退款单 |
| `lines[]` | `code` / `name` / `unit` / `qty` / `price` / `discountRate` / `discount` / `total` / `net` |
| `totals` | 原价合计、单项折扣、合计、折扣链文本、折后金额、整单优惠、应收（付）、实收（付）、未收（付），以及两个列开关 `hasLineDiscount` / `hasOrderDiscount` |

**刻意不返回**：商品进价 `cost`、`payments` 收付款流水、照片、客户 / 供应商档案里的联系方式与地址、内部备注字段。
金额口径全部复用 `src/utils/account.js` 与 `src/utils/orders.js` 的纯函数（与前端列表、打印同一份实现），
不会出现「页面显示 20.85，别人打开是 21.85」这种对不齐。

`token` 是 `crypto.getRandomValues` 生成的 **36 位十六进制**随机串。格式不合法直接 `404`（不查库），挡住枚举与无效回源。

失效语义：

| 情况 | 状态码 | 前端表现 |
|---|---|---|
| `token` 格式不合法 / 无记录 / 单据已删除 / 单据已作废 | `404` | 「分享链接无效或已取消」提示卡片 |
| 已过 `expiresAt` | `410` | 「分享链接已过期」提示卡片 |

公开页走 `meta.public`：`App.vue` 见到它就跳过登录自检与后台布局，`/session` 不会被调用，
带着过期票据的店员打开外链也不会被弹「登录已过期」。深链能直接访问，靠的是 `wrangler.json` 里
`assets.not_found_handling = "single-page-application"` + `run_worker_first = true`。

## 三、三个接口动作

`POST /api/shares`（需票据），返回 `{ ok, share?, token?, reused? }`：

| action | 入参 | 行为 |
|---|---|---|
| `create` | `{ kind, docId, days }` | 生成链接。`days` 取 `1 / 7 / 30`，`0`（或空）为**长期有效**，> 3650 天报 400。同一张单已有**有效**链接时不新建，返回原记录并带 `reused: true`；顺带清掉该单已过期 / 已失效的旧记录。作废单 `409`，单据不存在 `404`，总数超过 500 条 `409` |
| `update` | `{ token, days }` | 改时效，**按「现在」重新起算**（不是从原创建时间叠加）。已取消的链接改不了，需要重新生成 |
| `cancel` | `{ token }` | 立即失效。只删分享记录，单据本身不受影响 |

`GET /api/shares` 返回列表时，会把每条记录去 `sales` / `purchases` / `orders` 三个集合里查一次真实单据，
补上单据号、往来单位、日期、金额、状态，因此**列表里能直接看出「单据已删除 / 已作废 / 已过期」**，
而不是等别人打开链接才发现。按 `createdAt` 倒序。

`purchases` / `sales` 是按年分片的集合，读取走 `readCollection(env, key)`——注意它接收的是**集合键**（内部自己拼 `.json`），
传 `'shares.json'` 会写成 `shares.json.json`，这是最容易踩的一个坑。

## 四、前端入口

| 位置 | 组件 | 作用 |
|---|---|---|
| 销售单 / 采购单 / 订单详情页「分享」按钮 | `src/components/ShareDialog.vue` | 选有效期 → 生成；已有链接就直接展示链接、状态、二维码、取消。作废单不出现该按钮 |
| 二维码弹窗 | `src/components/ShareQr.vue` | `qrcode` 包现场生成 `toDataURL`（240px，纠错 M），手机扫码即开；`renderSeq` 防重开竞态 |
| 系统 → 外链分享（`/shares`） | `src/views/Shares.vue` | 统一汇总三类单据的全部链接：复制链接、二维码、改时效、取消（二次确认），单据号可跳回内部详情页 |
| 系统 → 用户信息（`/profile`） | `src/views/Profile.vue` | 联系名称 / 电话 / 地址 / 备注 + 打印落款预览 |
| 公开只读页（`/share/:token`） | `src/views/ShareView.vue` | 无登录、无按钮、无菜单；明细列与打印同规则（有行折扣才出「折扣率 / 本次折扣」，有整单折扣才出「折后金额」） |

复制链接走 `src/utils/clipboard.js`：优先 `navigator.clipboard`（需 https / localhost），
失败回退隐藏 `textarea` + `execCommand('copy')`，局域网 `http://` 访问也能复制。

## 五、用户信息落款

`profile.json` 是单份对象，`api/profile.js` 里 `normalizeProfile()` 逐字段 `trim()` 后按 40 / 60 / 160 / 200 截断，
多余字段直接丢弃——避免脚本往里面塞大段文本把数据仓撑胖。

打印时它是 `printA4()` 的第 6 个参数 `footerFields`，渲染成表格下方的 `.foot` 块：

- 空字段由 `normFields()` 过滤，四项全空就不产生落款块；
- 页面上的 `.print-foot` 与打印 HTML 用同一份 `profileFields` 计算属性，所见即所印；
- 未填写就勾选「显示用户信息」会给一条 warning，提示去「系统 → 用户信息」补充，而不是印出一排空标签。

## 六、字号强调（同一处排版能力）

`src/utils/export.js` 的单头字段元组是 `[label, value, tone]`，`tone` 只影响打印 HTML，不影响 CSV 与脱敏过滤：

- `'hl'` —— 加框强调，整单折扣用（`×0.95（减 ¥1.15）`）；
- `'xl'` —— 字号放大到两倍（基础 12px → 24px 加粗），**订单金额**在订单详情页打印与订单列表（单张 / 批量详情）打印中统一使用。

## 七、测试

`tests/shares-test.mjs`（接口层 15 项）覆盖：profile 空读 / 保存裁剪 / 超长截断；创建分享与 token 形状；公开读取的金额口径
（行折后 17.10 / 4.75、应收 20.85、未收 15.85）；**脱敏断言**（载荷里不得出现 `"cost"`、`"payments"`、照片 URL、客户电话、地址）；
同单复用；长期有效；作废 409 / 不存在 404；列表倒序；改时效与过期 410；过期后重建换新 token（旧记录在重建时被清理，旧 token 变 404）；
取消后 404；非法 token 404；500 条上限。

`tests/profile-share-browser-test.mjs`（真浏览器 19 项）覆盖：菜单入口与保存回显；三类详情页勾选落款的**页面位置与打印 HTML**；
未填写时的提示与「不印空落款」；订单金额 `f xl` 字号；分享弹窗生成 / 二维码 / 取消；`/shares` 列表状态、时效重算、取消确认；
公开页未登录可渲染、列开关、404 / 410 提示卡片、无编辑入口。

写浏览器测试时有两个坑值得记住：`context.route('**/api/**', …)` 会把 Vite 的 `/src/api/index.js` 模块也吞掉，
handler 第一行必须 `if (!pathname.startsWith('/api/')) return route.continue()`；
`el-radio-button` 的真实 `input` 是透明的，点 `.el-radio-button__inner` 才生效。
