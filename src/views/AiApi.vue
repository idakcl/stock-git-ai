<template>
  <el-card v-loading="loading">
    <template #header>
      <div class="card-header">
        <div class="title">
          <b>AI-API</b>
          <span class="hint">给 AI 或脚本发一把钥匙：权限由你勾选，随时可吊销</span>
        </div>
        <div class="actions">
          <el-button :loading="loading" @click="load">刷新</el-button>
          <el-button @click="openLogs">调用日志</el-button>
          <el-button type="primary" @click="openCreate">新建密钥</el-button>
        </div>
      </div>
    </template>

    <el-alert type="warning" :closable="false" show-icon class="notice">
      <template #title>密钥只在创建时完整显示一次</template>
      请当场复制交给 AI。丢失只能吊销后重新生成。AI 永远不能管理密钥、改密码、备份或清空数据——这四项不在任何权限里。
    </el-alert>

    <el-table :data="rows" stripe empty-text="还没有 AI 密钥。点右上角「新建密钥」签发一把。">
      <el-table-column label="名称" min-width="150" show-overflow-tooltip>
        <template #default="{ row }">
          <b>{{ row.name }}</b>
          <el-tag v-if="isMaxScopes(row.scopes)" type="danger" size="small" effect="plain" disable-transitions class="tag-gap">最大权限</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="密钥前缀" width="150">
        <template #default="{ row }"><code class="key-prefix">{{ row.prefix }}…</code></template>
      </el-table-column>
      <el-table-column label="权限" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">{{ isMaxScopes(row.scopes) ? '全部权限（不含密钥管理/改密码/备份/清空）' : scopesTextOf(row.scopes) }}</template>
      </el-table-column>
      <el-table-column label="有效期" width="160">
        <template #default="{ row }">
          <span :class="{ expired: !row.active }">{{ row.expiresAt ? `至 ${fmtCNTime(row.expiresAt)}` : '永久' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="最近使用" width="190">
        <template #default="{ row }">
          <template v-if="row.usage && row.usage.lastUsedAt">
            <div>{{ fmtCNTime(row.usage.lastUsedAt) }}</div>
            <div class="usage-sub">读 {{ row.usage.reads || 0 }} · 写 {{ row.usage.writes || 0 }}</div>
          </template>
          <span v-else class="muted">尚未使用</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="statusOf(row).type" size="small" disable-transitions>{{ statusOf(row).text }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="180" class-name="ops-col">
        <template #default="{ row }">
          <template v-if="!row.revokedAt">
            <el-button size="small" @click="openEdit(row)">改权限</el-button>
            <el-button size="small" type="danger" plain @click="revoke(row)">吊销</el-button>
          </template>
          <span v-else class="muted">已吊销</span>
        </template>
      </el-table-column>
    </el-table>
  </el-card>

  <!-- 新建 -->
  <el-dialog v-model="create.visible" title="新建 AI 密钥" width="680px" top="6vh" :close-on-click-modal="false">
    <el-form label-width="86px" label-position="left">
      <el-form-item label="名称" required>
        <el-input v-model="create.name" maxlength="40" show-word-limit placeholder="给谁用，例如：采购助手 / 我的脚本" />
      </el-form-item>
      <el-form-item label="有效期">
        <el-radio-group v-model="create.days">
          <el-radio-button :value="1">1 天</el-radio-button>
          <el-radio-button :value="7">7 天</el-radio-button>
          <el-radio-button :value="30">30 天</el-radio-button>
          <el-radio-button :value="90">90 天</el-radio-button>
          <el-radio-button :value="0">永久</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="权限" required>
        <AiScopePicker v-model="create.scopes" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="create.visible = false">取消</el-button>
      <el-button type="primary" :loading="create.saving" @click="submitCreate">签发</el-button>
    </template>
  </el-dialog>

  <!-- 改权限 -->
  <el-dialog v-model="edit.visible" title="修改密钥权限" width="680px" top="6vh" :close-on-click-modal="false">
    <el-alert type="info" :closable="false" show-icon class="notice">
      改权限立即生效（最长 15 秒缓存）。已发出的密钥文本不变，不需要重新复制。
    </el-alert>
    <el-form label-width="86px" label-position="left">
      <el-form-item label="名称" required>
        <el-input v-model="edit.name" maxlength="40" show-word-limit />
      </el-form-item>
      <el-form-item label="有效期">
        <el-radio-group v-model="edit.days">
          <el-radio-button value="keep">不变</el-radio-button>
          <el-radio-button :value="1">1 天</el-radio-button>
          <el-radio-button :value="7">7 天</el-radio-button>
          <el-radio-button :value="30">30 天</el-radio-button>
          <el-radio-button :value="90">90 天</el-radio-button>
          <el-radio-button :value="0">永久</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="权限" required>
        <AiScopePicker v-model="edit.scopes" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="edit.visible = false">取消</el-button>
      <el-button type="primary" :loading="edit.saving" @click="submitEdit">保存</el-button>
    </template>
  </el-dialog>

  <!-- 一次性展示 -->
  <el-dialog v-model="created.visible" title="密钥已生成" width="680px" top="6vh" :close-on-click-modal="false" :show-close="false">
    <el-alert type="warning" :closable="false" show-icon class="notice">
      这是唯一一次显示完整密钥。关掉这个窗口后就再也看不到它，只能吊销重发。
    </el-alert>
    <div class="key-box">
      <code>{{ created.key }}</code>
    </div>
    <div class="copy-row">
      <el-button type="primary" @click="copyKey">复制密钥</el-button>
      <el-button @click="copyLink">复制密钥链接</el-button>
      <el-button @click="copyManual">复制使用说明</el-button>
    </div>
    <div class="manual">
      <div class="manual-title">交给 AI 时一起给这两样：</div>
      <div>接口地址：<code>{{ baseUrl }}</code></div>
      <div>请求头：<code>Authorization: Bearer &lt;密钥&gt;</code></div>
      <div class="key-link">密钥链接：<code>{{ keyLink }}</code></div>
      <div class="manual-sub">先让 AI 请求 <code>{{ baseUrl }}/schema</code>，它会拿到自己的能力清单与调用说明。权限范围：{{ scopeText }}</div>
      <div class="manual-warn">链接里带着完整密钥，只发给你信任的 AI / 脚本；能走请求头时优先用请求头，链接更容易留在日志里。</div>
    </div>
    <template #footer>
      <el-button type="primary" @click="created.visible = false">我已保存，关闭</el-button>
    </template>
  </el-dialog>

  <!-- 调用日志 -->
  <el-drawer v-model="logs.visible" title="AI 调用日志" size="86%" :destroy-on-close="true">
    <div class="log-bar">
      <el-select v-model="logs.filters.keyId" placeholder="全部密钥" clearable style="width: 160px" @change="loadLogs">
        <el-option v-for="r in rows" :key="r.id" :label="r.name" :value="r.id" />
      </el-select>
      <el-select v-model="logs.filters.status" placeholder="全部结果" clearable style="width: 130px" @change="loadLogs">
        <el-option label="成功" value="ok" />
        <el-option label="失败" value="error" />
        <el-option label="401 未认证" value="401" />
        <el-option label="403 无权限" value="403" />
        <el-option label="400 参数错" value="400" />
      </el-select>
      <el-input v-model="logs.filters.q" placeholder="搜接口 / 单号 / 错误" clearable style="width: 220px" @keyup.enter="loadLogs" @clear="loadLogs" />
      <el-button :loading="logs.loading" @click="loadLogs">刷新</el-button>
      <span class="log-total">共 {{ logs.total }} 条，显示最近 {{ logs.rows.length }} 条</span>
    </div>
    <el-table v-loading="logs.loading" :data="logs.rows" stripe size="small" empty-text="还没有调用记录，AI 一开口就会出现在这里">
      <el-table-column label="时间" width="160">
        <template #default="{ row }">{{ fmtCNTime(row.at) }}</template>
      </el-table-column>
      <el-table-column label="密钥" min-width="120" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.key">{{ row.key }}</span>
          <span v-else class="muted">未认证</span>
        </template>
      </el-table-column>
      <el-table-column label="接口" min-width="200" show-overflow-tooltip>
        <template #default="{ row }"><code class="log-path">{{ row.method }} {{ row.path }}</code></template>
      </el-table-column>
      <el-table-column label="结果" width="90">
        <template #default="{ row }">
          <el-tag :type="logTagType(row.status)" size="small" disable-transitions>{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="耗时" width="80" align="right">
        <template #default="{ row }">{{ row.ms }} ms</template>
      </el-table-column>
      <el-table-column label="单号 / 错误" min-width="200" show-overflow-tooltip>
        <template #default="{ row }">
          <span v-if="row.code" class="log-code">{{ row.code }}</span>
          <span v-if="row.error" :class="row.status >= 400 ? 'log-error' : 'muted'">{{ row.error }}</span>
          <span v-if="row.code && row.error" class="muted"> · </span>
          <span v-if="!row.code && !row.error" class="muted">—</span>
        </template>
      </el-table-column>
    </el-table>
    <div class="log-foot">
      日志只保留最近 {{ logs.retainedDays }} 天、最多 {{ logs.max }} 条，超出自动丢弃最老的；不记录请求体，也不记录密钥明文。
    </div>
  </el-drawer>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { copyText } from '../utils/clipboard'
import { fmtCNTime } from '../utils/time.js'
import { isMaxScopes, scopesTextOf, AI_PRESETS } from '../utils/aiScopes.js'
import AiScopePicker from '../components/AiScopePicker.vue'

const loading = ref(false)
const rows = ref([])
const baseUrl = computed(() => `${window.location.origin}/api/ai/v1`)

const create = ref({ visible: false, saving: false, name: '', days: 30, scopes: [] })
const edit = ref({ visible: false, saving: false, id: '', name: '', days: 'keep', scopes: [] })
const created = ref({ visible: false, key: '', name: '', scopes: [] })
const logs = ref({
  visible: false,
  loading: false,
  rows: [],
  total: 0,
  retainedDays: 7,
  max: 1500,
  filters: { keyId: '', status: '', q: '' }
})
const scopeText = computed(() => (isMaxScopes(created.value.scopes)
  ? '最大权限（全部业务权限，不含密钥管理/改密码/备份/清空数据）'
  : scopesTextOf(created.value.scopes)))
// 密钥链接：把 key 放进 query，对方打开就能看能力清单（服务端同时支持 ?key=）
const keyLink = computed(() => (created.value.key ? `${baseUrl.value}/schema?key=${encodeURIComponent(created.value.key)}` : ''))

function statusOf(row) {
  if (row.revokedAt) return { text: '已吊销', type: 'info' }
  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) return { text: '已过期', type: 'info' }
  return { text: '有效', type: 'success' }
}

async function load() {
  loading.value = true
  try {
    const r = await api.getAiKeys()
    rows.value = r.keys || []
  } catch (e) {
    ElMessage.error(`加载失败：${e.message || '网络异常'}`)
  } finally {
    loading.value = false
  }
}

function openCreate() {
  create.value = { visible: true, saving: false, name: '', days: 30, scopes: [...AI_PRESETS[0].scopes] }
}

async function submitCreate() {
  const name = create.value.name.trim()
  if (!name) return ElMessage.warning('请填写密钥名称（给谁用）')
  if (!create.value.scopes.length) return ElMessage.warning('请至少勾选一项权限')
  create.value.saving = true
  try {
    const r = await api.aiKeyOperation({
      action: 'create',
      name,
      scopes: create.value.scopes,
      expiresInDays: create.value.days
    })
    create.value.visible = false
    created.value = { visible: true, key: r.key, name: r.record && r.record.name, scopes: r.record ? r.record.scopes : [] }
    await load()
  } catch (e) {
    ElMessage.error(`签发失败：${e.message || '网络异常'}`)
  } finally {
    create.value.saving = false
  }
}

function openEdit(row) {
  edit.value = { visible: true, saving: false, id: row.id, name: row.name, days: 'keep', scopes: [...(row.scopes || [])] }
}

async function submitEdit() {
  const name = edit.value.name.trim()
  if (!name) return ElMessage.warning('请填写密钥名称')
  if (!edit.value.scopes.length) return ElMessage.warning('请至少勾选一项权限')
  edit.value.saving = true
  try {
    const body = { action: 'update', id: edit.value.id, name, scopes: edit.value.scopes }
    if (edit.value.days !== 'keep') body.expiresInDays = edit.value.days
    await api.aiKeyOperation(body)
    edit.value.visible = false
    ElMessage.success('已保存')
    await load()
  } catch (e) {
    ElMessage.error(`保存失败：${e.message || '网络异常'}`)
  } finally {
    edit.value.saving = false
  }
}

async function revoke(row) {
  try {
    await ElMessageBox.confirm(
      `吊销后「${row.name}」这把密钥立即失效（最长 15 秒），使用它的 AI 会被拒绝。此操作不可恢复。`,
      '吊销密钥',
      { type: 'warning', confirmButtonText: '确认吊销', cancelButtonText: '取消' }
    )
  } catch { return }
  try {
    await api.aiKeyOperation({ action: 'revoke', id: row.id })
    ElMessage.success('已吊销')
    await load()
  } catch (e) {
    ElMessage.error(`吊销失败：${e.message || '网络异常'}`)
  }
}

async function copyKey() {
  try {
    await copyText(created.value.key)
    ElMessage.success('密钥已复制')
  } catch {
    ElMessage.error('复制失败，请手动选中复制')
  }
}

async function copyLink() {
  try {
    await copyText(keyLink.value)
    ElMessage.success('密钥链接已复制')
  } catch {
    ElMessage.error('复制失败，请手动选中复制')
  }
}

async function copyManual() {
  const text = [
    `AI-API 接口地址：${baseUrl.value}`,
    `密钥：${created.value.key}`,
    `密钥链接（含密钥，可直接打开看能力清单）：${keyLink.value}`,
    `请求头：Authorization: Bearer ${created.value.key}`,
    `权限范围：${scopeText.value}`,
    '',
    `使用说明：请先 GET ${baseUrl.value}/schema，返回内容包含可用接口、所需权限、参数说明与调用示例。`,
    '所有写接口都必须带 requestId（16~80 位字母/数字/短横线），网络重试时复用同一个值，避免重复开单。'
  ].join('\n')
  try {
    await copyText(text)
    ElMessage.success('使用说明已复制')
  } catch {
    ElMessage.error('复制失败，请手动选中复制')
  }
}

onMounted(load)

function logTagType(status) {
  if (status < 300) return 'success'
  if (status < 500) return 'warning'
  return 'danger'
}

function openLogs() {
  logs.value.visible = true
  loadLogs()
}

async function loadLogs() {
  logs.value.loading = true
  try {
    const r = await api.getAiLogs({ ...logs.value.filters, limit: 200 })
    logs.value.rows = r.logs || []
    logs.value.total = r.total || 0
    logs.value.retainedDays = r.retainedDays || 7
    logs.value.max = r.max || 1500
  } catch (e) {
    ElMessage.error(`日志加载失败：${e.message || '网络异常'}`)
  } finally {
    logs.value.loading = false
  }
}
</script>

<style scoped>
.notice { margin-bottom: 12px; }
.tag-gap { margin-left: 6px; }
.key-prefix { font-size: var(--fs-sub); color: var(--text-secondary); }
.usage-sub { font-size: var(--fs-sub); color: var(--text-disabled); }
.muted { color: var(--text-disabled); }
.expired { color: var(--color-danger); }
.key-box {
  background: var(--el-fill-color-light);
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
  padding: 14px;
  margin: 12px 0;
  word-break: break-all;
}
.key-box code { font-size: 15px; font-weight: 600; user-select: all; }
.copy-row { display: flex; gap: 10px; margin-bottom: 14px; }
.manual { font-size: var(--fs-sub); color: var(--text-secondary); line-height: 1.9; }
.manual code { background: var(--el-fill-color-light); padding: 1px 5px; border-radius: 4px; }
.manual-title { font-weight: 600; color: var(--text-primary); }
.manual-sub { margin-top: 4px; }
.key-link { word-break: break-all; }
.manual-warn { margin-top: 4px; color: var(--color-warning); }
.log-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 12px; }
.log-total { font-size: var(--fs-sub); color: var(--text-disabled); margin-left: auto; }
.log-path { font-size: var(--fs-sub); color: var(--text-secondary); }
.log-code { font-weight: 600; }
.log-error { color: var(--color-danger); }
.log-foot { margin-top: 12px; font-size: var(--fs-sub); color: var(--text-disabled); }
</style>
