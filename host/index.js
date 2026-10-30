/**
 * whale-overlay-host —— 宿主侧插件
 *
 * 职责：
 *   1) 打开宿主的「普通浏览器访问」开关（desktop 端默认关闭，所有 HTTP 路由会 403 "Browser access is disabled"）；
 *   2) 用 connection.authenticatedUrl() 生成带进程启动令牌的 URL（这是宿主官方生成浏览器入口的方式）；
 *   3) 把它写到 ~/.dsh/whale-overlay.json，并拉起 Electron 置顶窗口（~/.dsh/whale-overlay）。
 *
 * 安全边界：只写本机回环 URL + 一次性令牌，令牌随宿主每次启动更换，不落任何外发通道。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const name = 'whale-overlay-host'

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = path.join(HOME, 'whale-overlay.json')
const APP_DIR = path.join(HOME, 'whale-overlay')
const ELECTRON = path.join(HOME, 'electron', 'electron.exe')
const LOG_DIR = path.join(HOME, 'logs')

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(path.join(LOG_DIR, 'whale-overlay-host.log'),
      `[${new Date().toISOString()}] ${msg}\n`)
  } catch {}
}

export function apply(ctx) {
  // 临时探针：挂件的「-0.0x」浮动气泡靠 session/event 里的 usage 触发，
  // 这里把收到的事件形状记下来，查它为什么不出数。
  try {
    ctx.on('session/event', (session, event) => {
      try {
        const type = event && event.type
        if (type !== 'assistant/message' && type !== 'turn/end') return
        const d = event && event.data
        const u = d && d.usage
        const model = d && d.message && d.message.source ? d.message.source.model : '?'
        log('EV ' + type + ' turn=' + (d && d.turn) + ' model=' + model
          + ' usage=' + (u ? JSON.stringify(u) : 'none'))
      } catch (e) { log('EV err ' + (e && e.message)) }
    })
    log('probe: session/event hook installed')
  } catch (err) {
    log('probe: session/event hook failed: ' + (err && err.message))
  }

  // 让 DSH 自己的窗口里不再渲染小鲸鱼：桌面端是靠 webserver/index-inject 推一行内联脚本，
  // 我们在鲸鱼插件之后注册监听，把那一行摘掉即可（不影响 Web/浏览器路径的 tapIndex 注入，
  // 置顶窗口加载的正是浏览器路径）。
  let stripped = 0
  try {
    ctx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return
      for (let i = table.length - 1; i >= 0; i--) {
        const row = table[i]
        if (!row) continue
        const text = typeof row.text === 'string' ? row.text : ''
        if (row.src === '/dsh-whale/widget.js' || text.indexOf('/dsh-whale/widget.js') >= 0) {
          table.splice(i, 1)
          stripped++
        }
      }
      if (stripped > 0 && stripped < 50) log('stripped ' + stripped + ' in-window whale row(s)')
    })
  } catch (err) {
    log('index-inject hook failed: ' + (err && err.message))
  }

  ctx.inject(['webServer', 'connection'], (c) => {
    let url = ''
    try {
      try {
        // 打开普通浏览器访问；不打开的话宿主会直接 403 "Browser access is disabled"
        if (typeof c.webServer.setBrowserAccess === 'function') c.webServer.setBrowserAccess(true)
      } catch (err) {
        log('setBrowserAccess failed: ' + (err && err.message))
      }
      const base = c.webServer.getOrigin()
      url = c.connection.authenticatedUrl(base)
      fs.writeFileSync(STATE_FILE, JSON.stringify({ url, pid: process.pid, at: Date.now() }))
      log('published ' + url.replace(/token=[^&]+/, 'token=***'))
    } catch (err) {
      log('publish failed: ' + (err && err.message))
      return
    }

    // 拉起/刷新置顶窗口。已有实例会请求单例锁失败而自行退出，由旧实例读新 URL 重载。
    try {
      if (!fs.existsSync(ELECTRON)) {
        log('electron runtime missing: ' + ELECTRON)
        return
      }
      // 注意：宿主是 Electron 的 node 子进程，环境里带着 ELECTRON_RUN_AS_NODE=1 ——
      // 不删掉的话 electron.exe 会退化成 node，直接跑崩。
      const env = { ...process.env, DSH_HOME: HOME, DSH_OVERLAY_STATE: STATE_FILE }
      delete env.ELECTRON_RUN_AS_NODE
      delete env.ELECTRON_NO_ATTACH_CONSOLE
      const child = spawn(ELECTRON, [path.join(APP_DIR, 'main.js')], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env,
      })
      child.unref()
      log('helper spawned pid=' + child.pid)
    } catch (err) {
      log('spawn failed: ' + (err && err.message))
    }

    return () => {
      // 宿主卸载本插件时：让 helper 自己退出
      try { fs.rmSync(STATE_FILE, { force: true }) } catch {}
      try {
        if (typeof c.webServer.setBrowserAccess === 'function') c.webServer.setBrowserAccess(false)
      } catch {}
    }
  })
}