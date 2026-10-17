<template>
  <div class="login-page">
    <div class="login-card">
      <div class="brand">
        <div class="brand-logo">进</div>
        <div class="brand-text">
          <div class="brand-title">进销存管理系统</div>
          <div class="brand-sub">采购 · 销售 · 库存 · 资金 一体化</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">登录</div>
        <div class="panel-sub">请输入管理密码以进入系统</div>

        <el-form @submit.prevent="onSubmit" class="form">
          <el-form-item :error="error">
            <el-input
              v-model="password"
              type="password"
              size="large"
              placeholder="请输入管理密码"
              :prefix-icon="Lock"
              show-password
              autofocus
              :disabled="loading"
              @keyup.enter="onSubmit"
            />
          </el-form-item>

          <el-checkbox v-model="remember" class="remember">记住登录（30 天免登录）</el-checkbox>

          <el-button
            class="submit"
            type="primary"
            size="large"
            :loading="loading"
            @click="onSubmit"
          >
            {{ loading ? '登录中…' : '登 录' }}
          </el-button>
        </el-form>

        <div class="tip">
          <el-icon><InfoFilled /></el-icon>
          <span>登录状态仅保存在本机浏览器，退出后即失效</span>
        </div>
      </div>
    </div>
    <div class="foot">进销存 · 数据由 GitHub 数据仓托管</div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Lock, InfoFilled } from '@element-plus/icons-vue'
import { api, auth } from '../api'

const emit = defineEmits(['success'])

const password = ref('')
const remember = ref(true)
const loading = ref(false)
const error = ref('')

async function onSubmit() {
  if (loading.value) return
  if (!password.value) { error.value = '请输入密码'; return }
  error.value = ''
  loading.value = true
  try {
    const r = await api.login(password.value, remember.value)
    auth.set(r.token, remember.value)
    password.value = ''
    ElMessage.success('登录成功')
    emit('success')
  } catch (e) {
    error.value = e.message || '登录失败'
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background: linear-gradient(135deg, #e8f2ff 0%, #f6f8fb 45%, #eef1f6 100%);
}
.login-card {
  width: 100%;
  max-width: 420px;
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 18px 48px rgba(31, 45, 61, 0.12);
  overflow: hidden;
}
.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 24px 28px 20px;
  background: linear-gradient(135deg, #409eff 0%, #2f7fe0 100%);
  color: #fff;
}
.brand-logo {
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.22);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size:22px;
  font-weight: 700;
}
.brand-title { font-size:18px; font-weight: 700; letter-spacing: .5px; }
.brand-sub { margin-top: 2px; font-size:var(--fs-sub); opacity: .85; }
.panel { padding: 24px 28px 26px; }
.panel-title { font-size:20px; font-weight: 700; color:var(--text-primary); }
.panel-sub { margin: 4px 0 18px; font-size:var(--fs-table); color:var(--text-secondary); }
.form { margin-top: 4px; }
.remember { margin-bottom: 14px; }
.submit { width: 100%; letter-spacing: 4px; }
.tip {
  margin-top: 16px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size:var(--fs-sub);
  color:var(--text-disabled);
}
.foot { margin-top: 18px; font-size:var(--fs-sub); color:#b1b3b8; }
</style>
