<template>
  <el-card v-loading="loading">
    <template #header>
      <div class="card-header">
        <b>用户信息</b>
        <span class="header-hint">打印销售单 / 采购单 / 订单时，可勾选把以下信息印在商品列表底部</span>
      </div>
    </template>
    <el-form :model="form" label-width="96px" class="profile-form" :disabled="saving">
      <el-form-item label="联系名称">
        <el-input v-model="form.name" maxlength="40" show-word-limit placeholder="例如：某某建材经营部 / 张三" />
      </el-form-item>
      <el-form-item label="电话">
        <el-input v-model="form.phone" maxlength="60" placeholder="例如：13800000000" />
      </el-form-item>
      <el-form-item label="地址">
        <el-input v-model="form.address" maxlength="160" placeholder="例如：城南路 1 号" />
      </el-form-item>
      <el-form-item label="备注">
        <el-input v-model="form.remark" type="textarea" :rows="3" maxlength="200" show-word-limit
          placeholder="例如：微信同号 / 营业时间 8:00-18:00 / 对公账户…" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        <el-button :disabled="saving" @click="reset">重置</el-button>
      </el-form-item>
    </el-form>

    <div class="preview" v-if="hasAny">
      <div class="preview-title">打印落款预览</div>
      <div class="preview-body">
        <span v-if="form.name">联系名称：{{ form.name }}</span>
        <span v-if="form.phone">电话：{{ form.phone }}</span>
        <span v-if="form.address">地址：{{ form.address }}</span>
        <span v-if="form.remark">备注：{{ form.remark }}</span>
      </div>
    </div>
  </el-card>

  <el-card class="security-card">
    <template #header>
      <div class="card-header">
        <b>登录安全</b>
        <span class="header-hint">改密码后，其他设备上的登录会在约 30 秒内失效</span>
      </div>
    </template>

    <el-form :model="pwd" label-width="96px" class="profile-form" :disabled="pwdBusy">
      <el-form-item label="当前密码">
        <el-input v-model="pwd.current" type="password" show-password autocomplete="current-password" />
      </el-form-item>
      <el-form-item label="新密码">
        <el-input v-model="pwd.next" type="password" show-password autocomplete="new-password"
          placeholder="至少 8 位" />
      </el-form-item>
      <el-form-item label="确认新密码">
        <el-input v-model="pwd.confirm" type="password" show-password autocomplete="new-password"
          @keyup.enter="changePwd" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="pwdBusy" @click="changePwd">修改密码</el-button>
        <el-button type="danger" plain :loading="revokeBusy" @click="revokeAll">退出所有设备</el-button>
      </el-form-item>
      <div class="security-tip">
        忘记密码时：在数据仓删除 <code>auth.json</code>，即可用 Worker Secret 里的初始密码登录。
      </div>
    </el-form>
  </el-card>
</template>

<script setup>
import { ref, computed, reactive, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'

const EMPTY = () => ({ name: '', phone: '', address: '', remark: '' })
const loading = ref(true)
const saving = ref(false)
const form = ref(EMPTY())
let loaded = EMPTY()

const hasAny = computed(() => ['name', 'phone', 'address', 'remark'].some(k => String(form.value[k] || '').trim()))

function fill(data) {
  form.value = { ...EMPTY(), ...(data || {}) }
  loaded = { ...form.value }
}

async function load() {
  loading.value = true
  try {
    fill(await api.getProfile())
  } catch (e) {
    ElMessage.error(`加载失败：${e.message || '网络异常'}`)
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    const r = await api.saveProfile(form.value)
    fill(r.profile || form.value)
    ElMessage.success('用户信息已保存')
  } catch (e) {
    ElMessage.error(e.message || '保存失败')
  } finally {
    saving.value = false
  }
}

function reset() {
  form.value = { ...loaded }
  ElMessage.info('已恢复到上次保存的内容')
}

// ---- 登录安全 ----
// 为什么还要输当前密码：手机被别人拿到时，会话还在，但密码不知道；
// 这一层让「拿到手机」不等于「能改锁」。
const MIN_PASSWORD = 8
const pwd = reactive({ current: '', next: '', confirm: '' })
const pwdBusy = ref(false)
const revokeBusy = ref(false)
const clearPwd = () => { pwd.current = ''; pwd.next = ''; pwd.confirm = '' }

async function changePwd() {
  if (!pwd.current) return ElMessage.warning('请输入当前密码')
  if (String(pwd.next).length < MIN_PASSWORD) return ElMessage.warning(`新密码至少 ${MIN_PASSWORD} 位`)
  if (pwd.next !== pwd.confirm) return ElMessage.warning('两次输入的新密码不一致')
  pwdBusy.value = true
  try {
    await api.changePassword(pwd.current, pwd.next)
    clearPwd()
    ElMessage.success('密码已修改，本机已换用新票据，其他设备需重新登录')
  } catch (e) {
    ElMessage.error(e.message || '修改密码失败')
  } finally {
    pwdBusy.value = false
  }
}

async function revokeAll() {
  // 不用 prompt 输入密码：Element Plus 的 prompt 在手机上体验差，且容易把密码留在输入框里。
  // 改成确认框 + 本页密码字段（复用上面那栏），语义也更清楚。
  try {
    await ElMessageBox.confirm(
      '将立即注销所有设备（包括本机）的登录，之后用当前密码重新登录即可。确定继续？',
      '退出所有设备', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' })
  } catch { return }
  if (!pwd.current) return ElMessage.warning('请在上方「当前密码」里填入密码后再确认')
  revokeBusy.value = true
  try {
    await api.revokeSessions(pwd.current)
    // 服务端已吊销并递增版本；api.revokeSessions 内部会清理本地票据并广播，
    // App.vue 收到后切回登录页。这里不再保留任何本地状态。
  } catch (e) {
    ElMessage.error(e.message || '操作失败')
  } finally {
    revokeBusy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.header-hint { color: var(--text-secondary); font-size: var(--fs-sub); }
.profile-form { max-width: 560px; }
.preview { margin-top: 8px; padding: 12px 16px; background: var(--bg-stat); border-radius: var(--radius-md); max-width: 720px; }
.preview-title { color: var(--text-secondary); font-size: var(--fs-sub); margin-bottom: 6px; }
.preview-body { display: flex; flex-wrap: wrap; gap: 4px 24px; font-size: var(--fs-base); color: var(--text-regular); }
.security-card { margin-top: 12px; }
.security-tip { color: var(--text-secondary); font-size: var(--fs-sub); line-height: 1.6; padding: 0 4px; }
.security-tip code { background: var(--bg-stat); border-radius: 4px; padding: 0 4px; }
</style>
