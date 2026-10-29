import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fmtCNTime } from './src/utils/time.js'

// 可复现构建：注入的是「提交标识 + 该提交的提交时间」，不是构建当刻的墙上时间。
// 原来注入 new Date()：同一份源码两次构建只差几秒，但内容哈希随之改变 →
// JS 产物文件名每次都变，Cloudflare 认为是全新资源，每次部署整份重传 1.38MB；
// 页面上的「构建 …」也说不清线上到底是哪个版本。改成按提交取值后，
// 同一 commit 重复构建字节一致（文件名不变 → 命中 CF 去重，不再重传），
// 左下角显示的也是真正的版本号。
function git(args) {
  try {
    return execSync(`git ${args}`, {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim()
  } catch {
    return ''   // 没有 git（如从 tarball 构建）时退化为只用环境变量
  }
}
function buildStamp() {
  const sha = (process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 7) : git('rev-parse --short=7 HEAD')) || 'dev'
  const when = git('log -1 --format=%cI HEAD')
  return when ? `${sha} · ${fmtCNTime(when).slice(0, 16)}` : sha
}

export default defineConfig({
  base: '/',
  plugins: [vue()],
  define: {
    __BUILD_TIME__: JSON.stringify(buildStamp())
  },
  server: {
    allowedHosts: ['.monkeycode-ai.online'],
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
