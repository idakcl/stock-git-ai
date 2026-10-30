# 退货与退款：实现与接口契约

用户确认：默认退现金；补齐两张历史采购退货单退款凭证。

## 操作入口

资金菜单「退货 / 退款」，销售或采购详情「退货 / 退款」，来往账「退货 / 退款 / 抵扣」。
选择原单、填写本次退货数量（原因选填，留空落库记「无」）。数量默认 0；按原单各行折后净额（含整单折扣和抹零的比例分摊）计算退货款，分次全退最后一次吸收分差。现金模式须确认资金实际交付，系统只记账，不执行银行转账。

支持销售退货、采购退货、部分/多次退货、先退货后退款、部分/合并退款（同一往来单位）、冲抵同单位欠款（先旧单）、转客户预存或供应商预付余额。待退余额继续挂账。

现金退款生成 TK 单（TK-YYYYMMDD-NNNN）；非现金抵扣或转余额生成 HX 核销凭证（HX-YYYYMMDD-NNNN）。退款及核销在「收付款单」的对应页签查看，支持明细和 CSV。单据可在原有详情中补照片。

## 数据和公式

- 退货单继续存在 sales.json / purchases.json。新单 type = sale-return / purchase-return；新编号 XT-/CT-YYYYMMDD-NNNN（4 位流水）。
- sourceOrderId 精确关联原单 id；items[].sourceLine 关联原单行索引（同商品可以在不同原单行出现）。no 保留业务单号含义，不假定历史 no 是可解析的原单 id。
- qty、total 为负；price 为原行正价；行 total 为分摊后的负净额，不能再乘折扣或重复减抹零。
- 现金退款在退货单 payments 中写负 amount，凭证写正 total。direction 为 to_customer（资金出）或 from_supplier（资金入）。received/paid 仅汇总 payments。
- 非现金使用 settlements，绝不写入 payments 或 discount。正单核销 amount 为正，退货单为负。HX 的 total = 0，settlementTotal 为本次核销额；抵扣双边 items 不能累加当作现金。
- 未结 = grossOf(order) − Σpayments − Σsettlements；普通正单维持不小于 0，退货单允许负数（待退），绝对值为 0 才结清。
- 退款记录只存 refunds.json，不再重复生成 SK/FK。统计现金时加入供应商 TK、减去客户 TK；HX 不计现金。
- 库存负数量反向回冲；退货行不覆盖商品档案成本/售价，也不覆盖库存的最新采购价。当前系统不是移动加权平均成本，本次不改成本体系。

## 接口

GET /api/refunds：返回 TK、HX 集合；文件不存在返回 []。
POST /api/refunds：操作接口，不是整表覆盖！需要现有登录票据。

创建退货（cash 默认；offset/deposit/pending 可选）：

```json
{
  "action": "create",
  "requestId": "f6edb235-217a-48c8-b745-cf5bc422bc31",
  "kind": "sale",
  "sourceOrderId": "原销售单id",
  "date": "2026-10-28",
  "reason": "规格不符",
  "mode": "cash",
  "lines": [{ "index": 0, "qty": 2 }],
  "remark": "已退现金"
}
```

登记已有退货单的退款 / 非现金核销：

```json
{
  "action": "settle",
  "requestId": "5563edb0-0d52-4868-92f6-ae61d95793bf",
  "kind": "purchase",
  "orderIds": ["CT-20261028-0001"],
  "date": "2026-10-28",
  "mode": "cash",
  "amount": 100,
  "remark": "收到供应商退款"
}
```

kind = sale / purchase；请求标识为一次操作唯一 UUID，网络重试必须保持同一 requestId 和请求内容。金额只能正数、最多两位小数，不得超过未退额。同一请求再次提交返回 duplicate，不重记账。400 表示输入不合法；409 表示并发冲突，应重新读取后确认；网络中断或 5xx 可能结果不明，使用原 requestId 查重重试。

服务端固定一个 Git 提交快照读取，重新核算可退数量和净价，订单、退款凭证、余额、库存和日志在同一提交中发布；分支使用 force:false，冲突不覆盖、不自动重放。不能由 AI 直接拼造凭证、手填负旧汇总字段代替此接口。

action=backfill 只处理 CT-20260519-0001/CT-20260519-0002（原 T20260519120000001/T20260519120000002）。已于数据仓提交 74a3c2e 执行：TK-20260519-0001 金额 8618；TK-20260519-0002 金额 302；方向均 from_supplier，总额 8920。仅改 purchases.json（按年分片后为 purchases-2026.json）的 payments、refunds.json、logs.json；原金额、库存、明细、结算状态未变。重复执行不新增单据。

action=restore：仅供「数据管理 → 全量导入」恢复备份，请求体 `{ "action": "restore", "refunds": [全量凭证数组] }`，整表替换 refunds.json（传 [] 即清空）。校验与其它写入同口径：必须是数组、≤ 5000 条、每条是对象且 code 非空不重复，否则 400 不落库；内容与库内一致时返回 `{ ok: true, restored, unchanged: true }`，不产生空提交。退款/核销是凭证、不影响库存，故 restore 不触发派生；旧备份没有 refunds 键时前端不调用它，现有凭证保持不动。`POST /api/import-merge` 也接受 key=refunds，按 code 去重后追加。

## 与初版方案的修正与边界

不把退货抵扣当优惠，不把非现金核销当退款流水；正常收付款函数保留旧口径，退货抵扣通过独立入口显式选择，不在普通「记一笔」中静默抵扣。退款不是折让；目前不提供独立无货折让、预存款直接退款、作废冲红或现金银行账户功能。

已有退货的原单禁止改商品/金额或删除；已记账退货单只允许改备注和照片。旧页面整表保存若漏掉或修改已有退货/核销记录，服务端拒绝。普通收款仍可追加，核销金额参与剩余应收计算。

历史 T 单没有可靠 sourceOrderId 时不猜原单映射。需要对相关旧原单再次退货前，先人工核实历史已退数量，避免重复退货。

浏览器提交前把原请求保存在当前标签页的 sessionStorage；成功或明确的 4xx 拒绝后清除。网络结果不明时锁定表单和关闭按钮，刷新或返回此页面恢复原请求重试。请勿关闭标签页、清除浏览器存储或换设备重新录入；这些情况应先核对订单和凭证是否已生成。

## 验证与发布状态

已通过 `node --test refund-test.mjs`（11 项）、`node deposit-test.mjs`（9 项断言）、`node tests/backup-api-test.mjs`（8 项，含退款 restore 与 import-merge 去重）、`git diff --check`、`npm run build`。构建只有主包体积警告。

浏览器验收脚本：`refund-browser-test.mjs`，需要环境可加载 Playwright 及 Chromium，并先启动 `npm run dev -- --host 0.0.0.0 --port 5173`，然后运行 `node refund-browser-test.mjs`。API 全部使用隔离内存数据，不接触生产数据。

已验收现金、暂不退款、冲欠款、转余额、同单位两单合并部分退款、400/409 拒绝、提交成功但响应丢失后刷新恢复并幂等重试、390px 手机采购退款、TK 编号与方向、详情携带原单、核销后普通收款金额、零金额退货单编辑/删除/收付限制。无浏览器未捕获异常。

历史两张补单已发布到数据仓。应用通过推送 main 触发现有 GitHub Actions「Deploy to Cloudflare Workers」发布；部署结果以对应提交的工作流状态为准。数据仓 README 待发布副本包含在此前交付的源码包中，本次应用发布不覆盖生产 JSON 数据。部署后仍需真实登录及只读接口验收，不能把本地验收视为线上验收。
