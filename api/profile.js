// 用户信息（本店/本人联系方式）：打印单据时跟在商品列表底部。
// 单独存 profile.json，不改动任何业务集合；文件不存在时按空资料处理（首次保存自动创建）。
import { readJSON, writeJSON } from './github.js'

const PROFILE_FILE = 'profile.json'
// 字段长度上限：只用于联系人名片的短文本，超长内容会撑爆打印页脚，也容易把无关信息带进单据
const LIMITS = { name: 40, phone: 60, address: 160, remark: 200 }
const FIELDS = Object.keys(LIMITS)

const clamp = (v, max) => String(v == null ? '' : v).trim().slice(0, max)

export function normalizeProfile(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const out = {}
  for (const key of FIELDS) out[key] = clamp(src[key], LIMITS[key])
  return out
}

export async function readProfile(env) {
  try {
    return normalizeProfile(await readJSON(env, PROFILE_FILE))
  } catch (e) {
    if (/GitHub 404/.test(String((e && e.message) || e))) return normalizeProfile({})
    throw e
  }
}

export async function saveProfile(env, body) {
  const profile = normalizeProfile(body)
  await writeJSON(env, PROFILE_FILE, profile, 'update profile')
  return profile
}
