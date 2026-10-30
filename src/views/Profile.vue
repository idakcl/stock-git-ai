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
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
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

onMounted(load)
</script>

<style scoped>
.card-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.header-hint { color: var(--text-secondary); font-size: var(--fs-sub); }
.profile-form { max-width: 560px; }
.preview { margin-top: 8px; padding: 12px 16px; background: var(--bg-stat); border-radius: var(--radius-md); max-width: 720px; }
.preview-title { color: var(--text-secondary); font-size: var(--fs-sub); margin-bottom: 6px; }
.preview-body { display: flex; flex-wrap: wrap; gap: 4px 24px; font-size: var(--fs-base); color: var(--text-regular); }
</style>
