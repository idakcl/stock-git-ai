// AI-API 权限目录：前端勾选框、服务端校验、/schema 自描述共用这一份。
// 权限拆得细是刻意的：给 AI 开权限时，用户要能一眼看出「这一勾意味着它能动钱」，
// 而不是面对一个笼统的「读写」开关。id 一旦发布就不要改名（已发出的密钥按 id 存）。

export const AI_SCOPE_GROUPS = [
  {
    key: 'read',
    title: '查看',
    hint: '只读，不会改动任何数据',
    scopes: [
      { id: 'read:catalog', label: '商品与库存', desc: '商品档案、规格价格、当前库存数量' },
      { id: 'read:docs', label: '单据查询', desc: '订单 / 销售 / 采购 / 退货单的列表与明细' },
      { id: 'read:parties', label: '客户供应商与欠款', desc: '往来单位档案、应收应付余额、来往账' },
      { id: 'read:vouchers', label: '资金单据', desc: '收款单 SK- / 付款单 FK- 的列表、金额与关联单号' },
      { id: 'read:reports', label: '报表汇总', desc: '区间营业额、采购额、单量等汇总数字' },
      { id: 'read:cost', label: '看进价与毛利', desc: '成本价 / 进价 / 毛利。默认关闭，避免把底价交给 AI', danger: true },
      { id: 'read:profile', label: '看用户信息', desc: '打印落款里的姓名、电话、地址', danger: true }
    ]
  },
  {
    key: 'write',
    title: '操作',
    hint: '越往下越危险：会改库存、应收应付或资金',
    scopes: [
      { id: 'write:draft', label: '建订单草稿', desc: '把单子填好存成「未过账」，不占库存、不进欠款；可改 / 删自己建的草稿', danger: false },
      { id: 'write:templates', label: '建改订单模板', desc: '新增 / 修改 / 删除 / 复制订单模板，不影响任何单据', danger: false },
      { id: 'write:upload', label: '上传图片', desc: '把图片传到图床，返回链接给单据照片用', danger: false },
      { id: 'write:post', label: '过账订单', desc: '草稿转成销售单 / 采购单，直接改库存与应收应付', danger: true },
      { id: 'write:docs', label: '直接开销售单 / 采购单', desc: '跳过订单，直接生成正式单据（同样动库存与欠款）', danger: true },
      { id: 'write:refunds', label: '退货退款', desc: '生成退货单，并可能开出现金退款凭证', danger: true },
      { id: 'write:voids', label: '作废单据', desc: '单据与关联凭证一起作废，应收应付库存全部归零', danger: true },
      { id: 'write:master', label: '改商品 / 客户 / 供应商档案', desc: '修改主数据（名称、价格、联系方式等）', danger: true },
      { id: 'write:deposits', label: '存 / 预付充值抵扣', desc: '给客户预存款 / 供应商预付款充值或抵扣，会生成对应的收 / 付款单', danger: true },
      { id: 'write:payments', label: '记收付款 / 结清', desc: '给已开的销售单收款、采购单付款或按差额结清，会生成收 / 付款单', danger: true },
      { id: 'write:amend', label: '变更已开单据', desc: '改明细：减少的生成退货单、增加的生成补差单，原单不动', danger: true },
      { id: 'write:shares', label: '外链分享', desc: '把单据生成只读公开链接 / 取消 / 改有效期', danger: false }
    ]
  }
]

// 扁平清单：服务端校验「这个 scope 是否存在」、前端做全选都从这里取
export const AI_SCOPES = AI_SCOPE_GROUPS.flatMap(g => g.scopes)
export const AI_ALL_SCOPE_IDS = AI_SCOPES.map(s => s.id)
const ALL = new Set(AI_ALL_SCOPE_IDS)

export const isAiScope = (id) => ALL.has(id)

// 快捷预设：点一下勾好一组，之后还能逐项微调
export const AI_PRESETS = [
  { id: 'readonly', label: '只读问答', scopes: ['read:catalog', 'read:docs', 'read:parties', 'read:reports'] },
  { id: 'assistant', label: '开单助手', scopes: ['read:catalog', 'read:docs', 'read:parties', 'read:reports', 'write:draft', 'write:templates'] },
  { id: 'business', label: '业务全流程', scopes: ['read:catalog', 'read:docs', 'read:parties', 'read:reports', 'write:draft', 'write:templates', 'write:post', 'write:docs'] },
  { id: 'max', label: '最大权限', scopes: [...AI_ALL_SCOPE_IDS], max: true }
]

// 最大权限：全部勾上（密钥管理、改密码、备份恢复、清空数据永远不在此列）
export const isMaxScopes = (scopes) => AI_ALL_SCOPE_IDS.every(id => (scopes || []).includes(id))

export const scopeLabelOf = (id) => (AI_SCOPES.find(s => s.id === id) || {}).label || id
export const scopesTextOf = (scopes) => (scopes || []).map(scopeLabelOf).join(' · ') || '未授予任何权限'

// 接口 → 需要的权限（服务端按这张表拒绝越权，也用它生成 /schema）
export const AI_ENDPOINTS = [
  { method: 'GET', path: '/api/ai/v1/schema', scope: '', desc: '能力清单与调用说明' },
  { method: 'GET', path: '/api/ai/v1/items', scope: 'read:catalog', desc: '商品档案 + 库存，支持 q / limit / cursor' },
  { method: 'GET', path: '/api/ai/v1/stock', scope: 'read:catalog', desc: '库存列表，low=1 只看零库存/负库存' },
  { method: 'GET', path: '/api/ai/v1/orders', scope: 'read:docs', desc: '订单列表，支持 status / party / from / to / include=lines' },
  { method: 'GET', path: '/api/ai/v1/sales', scope: 'read:docs', desc: '销售单列表，支持 party / from / to / type / include=lines' },
  { method: 'GET', path: '/api/ai/v1/purchases', scope: 'read:docs', desc: '采购单列表，参数同销售单' },
  { method: 'GET', path: '/api/ai/v1/parties', scope: 'read:parties', desc: '客户或供应商 + 当前欠款，type=customer|supplier' },
  { method: 'GET', path: '/api/ai/v1/ledger', scope: 'read:parties', desc: '某个往来单位的来往账与累计欠款' },
  { method: 'GET', path: '/api/ai/v1/summary', scope: 'read:reports', desc: '区间营业额、采购额、单量、应收应付' },
  { method: 'GET', path: '/api/ai/v1/profile', scope: 'read:profile', desc: '用户信息（打印落款）' },
  { method: 'GET', path: '/api/ai/v1/templates', scope: 'write:templates', desc: '订单模板列表' },
  { method: 'POST', path: '/api/ai/v1/orders', scope: 'write:draft', desc: '订单操作：save / delete / remark；post / unpost 需要 write:post；save 可加 allowNewItems / allowNewSuppliers 自动建档' },
  { method: 'POST', path: '/api/ai/v1/sales', scope: 'write:docs', desc: '直接开一张销售单（金额由服务端重算，挂账；可加 allowNewItems 自动建商品）' },
  { method: 'POST', path: '/api/ai/v1/purchases', scope: 'write:docs', desc: '直接开一张采购单（金额由服务端重算，挂账；可加 allowNewItems / allowNewSuppliers 自动建档）' },
  { method: 'POST', path: '/api/ai/v1/refunds', scope: 'write:refunds', desc: '退货 / 退款：action=create|settle' },
  { method: 'POST', path: '/api/ai/v1/voids', scope: 'write:voids', desc: '作废单据：kind=sale|purchase + id + reason' },
  { method: 'POST', path: '/api/ai/v1/master', scope: 'write:master', desc: '改主数据：type=item|customer|supplier，action=upsert|delete；item.suppliers 传名称时需 allowNewSuppliers' },
  { method: 'GET', path: '/api/ai/v1/vouchers', scope: 'read:vouchers', desc: '资金单据查询，支持 type / party / from / to / q' },
  { method: 'GET', path: '/api/ai/v1/shares', scope: 'write:shares', desc: '当前分享链接列表' },
  { method: 'POST', path: '/api/ai/v1/deposits', scope: 'write:deposits', desc: '预存 / 预付：type=customer|supplier，action=add|deduct|edit|delete，amount>0' },
  { method: 'POST', path: '/api/ai/v1/payments', scope: 'write:payments', desc: '记收付款：kind=sale|purchase，id，action=pay|settle，amount>0' },
  { method: 'POST', path: '/api/ai/v1/amends', scope: 'write:amend', desc: '变更已开单据：kind + sourceOrderId + refundLines / amendLines（原单不动）' },
  { method: 'POST', path: '/api/ai/v1/shares', scope: 'write:shares', desc: '分享：action=create|cancel|update' },
  { method: 'POST', path: '/api/ai/v1/templates', scope: 'write:templates', desc: '订单模板：action=create|update|delete|duplicate' },
  { method: 'POST', path: '/api/ai/v1/upload', scope: 'write:upload', desc: '上传图片（multipart，字段名 file）' }
]
