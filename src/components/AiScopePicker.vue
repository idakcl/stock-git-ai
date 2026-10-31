<template>
  <div class="scope-picker">
    <div class="preset-row">
      <el-button
        v-for="p in AI_PRESETS"
        :key="p.id"
        size="small"
        :type="presetActive(p) ? 'primary' : 'default'"
        plain
        @click="applyPreset(p)"
      >{{ p.label }}</el-button>
      <span class="preset-hint">点一下勾好一组，之后还能逐项微调</span>
    </div>

    <div v-for="g in AI_SCOPE_GROUPS" :key="g.key" class="scope-group">
      <div class="group-head">
        <b>{{ g.title }}</b>
        <span>{{ g.hint }}</span>
      </div>
      <div class="scope-list">
        <div
          v-for="s in g.scopes"
          :key="s.id"
          class="scope-item"
          :class="{ danger: s.danger, on: has(s.id) }"
          @click="toggle(s.id, !has(s.id))"
        >
          <el-checkbox
            class="scope-check"
            :model-value="has(s.id)"
            @click.stop
            @update:model-value="v => toggle(s.id, v)"
          />
          <span class="scope-text">
            <span class="scope-label">
              {{ s.label }}
              <el-tag v-if="s.danger" type="danger" size="small" effect="plain" disable-transitions>敏感</el-tag>
            </span>
            <span class="scope-desc">{{ s.desc }}</span>
          </span>
        </div>
      </div>
    </div>

    <div class="scope-summary">
      已选 <b>{{ value.length }}</b> / {{ AI_ALL_SCOPE_IDS.length }} 项
      <el-tag v-if="isMaxScopes(value)" type="danger" size="small" disable-transitions>最大权限</el-tag>
      <span v-else-if="!value.length" class="warn">至少勾选一项</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { AI_SCOPE_GROUPS, AI_PRESETS, AI_ALL_SCOPE_IDS, isMaxScopes } from '../utils/aiScopes.js'

const props = defineProps({ modelValue: { type: Array, default: () => [] } })
const emit = defineEmits(['update:modelValue'])

const value = computed(() => props.modelValue || [])
const has = (id) => value.value.includes(id)

function toggle(id, on) {
  const set = new Set(value.value)
  if (on) set.add(id)
  else set.delete(id)
  // 按权限目录顺序输出：同一组勾选无论先后，落库都是同一份
  emit('update:modelValue', AI_ALL_SCOPE_IDS.filter(x => set.has(x)))
}

function applyPreset(p) {
  emit('update:modelValue', p.scopes.slice())
}

function presetActive(p) {
  if (p.max) return isMaxScopes(value.value)
  const a = new Set(p.scopes)
  return value.value.length === a.size && value.value.every(id => a.has(id))
}
</script>

<style scoped>
.preset-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 14px;
}
.preset-hint { font-size: var(--fs-sub); color: var(--text-disabled); }
.scope-group {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.group-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
.group-head span { font-size: var(--fs-sub); color: var(--text-secondary); }
.scope-list { display: flex; flex-direction: column; gap: 2px; }
.scope-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.scope-item:hover { background: var(--el-fill-color-light); }
.scope-item.on { background: var(--el-color-primary-light-9); }
.scope-item.danger.on { background: var(--el-color-danger-light-9); }
.scope-text { display: flex; flex-direction: column; line-height: 1.35; }
.scope-label { font-weight: 500; display: inline-flex; align-items: center; gap: 6px; }
.scope-desc { font-size: var(--fs-sub); color: var(--text-secondary); }
.scope-summary { font-size: var(--fs-sub); color: var(--text-secondary); display: flex; align-items: center; gap: 8px; }
.scope-summary .warn { color: var(--color-danger); }
</style>
