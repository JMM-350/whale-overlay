/**
 * whale-overlay —— 独立的置顶透明窗口，只显示 DSH 的小鲸鱼挂件。
 *
 * 工作方式：
 *   - 宿主侧插件（whale-overlay-host）把带令牌的 URL 写进 ~/.dsh/whale-overlay.json；
 *   - 本程序加载该 URL（就是 DSH Web GUI 本身），再注入 CSS 把除 .dshwv-* 之外的一切隐藏；
 *   - 窗口是 transparent + frameless + alwaysOnTop('screen-saver')，覆盖整个主屏；
 *   - 默认鼠标穿透（点击落到下层应用），只有指针进到鲸鱼/菜单的矩形里才接管；
 *   - 宿主重启后 URL 变化 → 自动重载；宿主进程消失 → 自动退出。
 */
const { app, BrowserWindow, screen, Tray, Menu, nativeImage, ipcMain, globalShortcut } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const mouth = require('./mouth')

// 用独立的应用名与 userData：否则 `electron main.js` 会退化成 "Electron"，
// localStorage 与其他 Electron 应用共用，位置等状态会互相污染。
app.setName('whale-overlay')
try { app.setPath('userData', path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'whale-overlay')) } catch {}

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const STATE_FILE = process.env.DSH_OVERLAY_STATE || path.join(HOME, 'whale-overlay.json')
const LOG_FILE = path.join(HOME, 'logs', 'whale-overlay.log')
const SHOT_FILE = path.join(HOME, 'whale-overlay-shot.png')
const MEDIA_HELPER = path.join(__dirname, 'media-helper.ps1')
const MEDIA_CMD_FILE = path.join(process.env.TEMP || os.tmpdir(), 'whale-media-cmd.txt')

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, line)
  } catch {}
}

/** 把除小鲸鱼自身 DOM 以外的一切隐藏：只留下 body 下带 dshwv 类名的节点。 */
const HIDE_CSS = `
html, body {
  background: transparent !important;
  background-color: transparent !important;
  overflow: hidden !important;
}
body > *:not([class*="dshwv"]) {
  opacity: 0 !important;
  pointer-events: none !important;
}
body::-webkit-scrollbar { display: none !important; }
`

/** 收集所有需要接住指针的矩形（鲸鱼本体、菜单、各种面板）。 */
const RECTS_JS = `(() => {
  const out = [];
  const sel = '.dshwv-root,.dshwv-menu,.dshwv-menu-btn,.dshwv-pop,.dshwv-rolelist,.dshwv-audiolist,.dshwv-usagepanel,.dshwv-custmenu,.dshwv-custbtn,.dshwv-confirmmask,.dshwv-bubmask,.dshwv-cropmask,.dshwv-audiomask,.dshwv-snapmask,.dshwv-framemask,.dshwv-qedit,.dshwv-resmask,.dshwv-usage-mask';
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width > 1 && r.height > 1) out.push([r.left, r.top, r.right, r.bottom]);
  }
  const whale = document.querySelector('.dshwv-root');
  let wr = null;
  if (whale) { const b = whale.getBoundingClientRect(); if (b.width > 1) wr = [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; }
  return { rects: out, whale: wr, dragging: !!document.querySelector('.dshwv-root.dshwv-dragging'), vw: innerWidth, vh: innerHeight };
})()`

const DIAG_JS = `(() => {
  const out = { bodyChildren: [], whale: null, imgs: [] };
  for (const el of document.body.children) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.bodyChildren.push({ cls: String(el.className || el.id || el.tagName).slice(0, 40), opacity: cs.opacity, display: cs.display, w: Math.round(r.width), h: Math.round(r.height) });
  }
  const w = document.querySelector('.dshwv-root');
  if (w) {
    const cs = getComputedStyle(w);
    const r = w.getBoundingClientRect();
    out.whale = { opacity: cs.opacity, display: cs.display, visibility: cs.visibility, z: cs.zIndex, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], children: w.children.length };
    for (const im of w.querySelectorAll('img')) {
      const c2 = getComputedStyle(im);
      out.imgs.push({ src: (im.currentSrc || im.src || '').slice(-60), nw: im.naturalWidth, nh: im.naturalHeight, disp: c2.display, vis: c2.visibility, op: c2.opacity });
    }
  }
  try { out.pos = localStorage.getItem('dshw-pos'); out.innerW = innerWidth; out.innerH = innerHeight; } catch (e) {}\n  out.bodyBg = getComputedStyle(document.body).backgroundColor;
  out.htmlBg = getComputedStyle(document.documentElement).backgroundColor;
  return out;
})()`
/** 在页面里造一个跟着鲸鱼的小标签（类名带 dshwv，才不会被 HIDE_CSS 隐藏）。 */
const TIP_JS = `(() => {
  if (window.__whaleTip) return true;
  const el = document.createElement('div');
  el.className = 'dshwv-mediatip';
  el.style.cssText = [
    'position:fixed', 'z-index:2147483000', 'pointer-events:none',
    'max-width:320px', 'padding:0 2px', 'border-radius:0',
    'font:12.5px/1.4 "Microsoft YaHei",system-ui,sans-serif', 'font-weight:600', 'color:#fff',
    // 无框：不要底色、不要描边、不要投影方块，只靠文字的描边阴影保证任何壁纸上都看得清
    'background:transparent', 'border:0', 'box-shadow:none', 'backdrop-filter:none',
    'text-shadow:0 1px 2px rgba(0,0,0,.92),0 0 5px rgba(0,0,0,.75),0 0 1px rgba(0,0,0,.9)',
    'white-space:pre-line', 'overflow:hidden', 'text-overflow:ellipsis', 'opacity:0',
    'transition:opacity .12s ease', 'transform:translateX(-50%)', 'letter-spacing:.2px'
  ].join(';');
  document.body.appendChild(el);
// 花钱时的浮动气泡：跟挂件那个「-0.0x」一样，从鲸鱼上方飘起来再淡出
window.__whaleFloat = function (text, cx, top) {
  try {
    const d = document.createElement('div');
    d.className = 'dshwv-spendfloat';
    d.textContent = text;
    d.style.cssText = [
      'position:fixed', 'z-index:2147483000', 'pointer-events:none', 'padding:0 2px',
      'font:19px/1.2 "Microsoft YaHei",system-ui,sans-serif', 'font-weight:800', 'color:#b6ffcf',
      'text-shadow:0 2px 3px rgba(0,0,0,.95),0 0 8px rgba(0,0,0,.85)',
      'white-space:nowrap', 'opacity:0', 'letter-spacing:.4px',
      'transform:translateX(-50%) translateY(0)',
      'transition:opacity .3s ease, transform 1.7s cubic-bezier(.2,.7,.3,1)'
    ].join(';');
    const half = 46;
    d.style.setProperty('left', Math.round(Math.max(half, Math.min(cx, innerWidth - half))) + 'px', 'important');
    d.style.setProperty('top', Math.round(top) + 'px', 'important');
    document.body.appendChild(d);
    requestAnimationFrame(() => {
      d.style.setProperty('opacity', '1', 'important');
      d.style.setProperty('transform', 'translateX(-50%) translateY(-34px)', 'important');
    });
    setTimeout(() => { d.style.setProperty('opacity', '0', 'important') }, 1000);
    setTimeout(() => { try { d.remove() } catch (e) {} }, 1600);
  } catch (e) {}
};
  window.__whaleTip = function (show, text, cx, top) {
    if (typeof text === 'string' && text) { el.textContent = text }
    if (typeof cx === 'number') {
      // 鲸鱼可能贴屏幕边缘：按标签自身宽度夹住，别溢出屏幕
      const half = el.offsetWidth / 2 + 4
      const x = Math.max(half, Math.min(cx, innerWidth - half))
      el.style.setProperty('left', Math.round(x) + 'px', 'important')
    }
    if (typeof top === 'number') el.style.setProperty('top', Math.round(top) + 'px', 'important');
    // 页面上有别的规则在压 opacity，普通内联样式赢不了，必须 !important
    el.style.setProperty('opacity', show ? '1' : '0', 'important');
  };
  return true;
})()`

/** 点鲸鱼 → 让主进程切换播放/暂停（鲸鱼自己的小黄鸭音效不受影响）。
 *  用文档级捕获，避免鲸鱼重新渲染后监听器丢失。 */
const CLICK_JS = `(() => {
  if (window.__whaleClickBound) return true;
  window.__whaleClickBound = true;
  const desc = (t) => {
    if (!t) return 'null';
    const c = typeof t.className === 'string' ? t.className : '';
    return (t.tagName || '?') + (c ? '.' + c.split(/\\s+/).slice(0, 2).join('.') : '');
  };
  document.addEventListener('mousedown', (e) => {
    try {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      window.__whaleOverlay && window.__whaleOverlay.ping(
        'down ' + desc(e.target) + ' @' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' hit=' + desc(el))
    } catch (err) {}
  }, true)
  document.addEventListener('click', (e) => {
    try {
      // 点在挂件自己的菜单/面板上时不切歌，免得误触
      const ui = e.target && e.target.closest
        ? e.target.closest('.dshwv-menu,.dshwv-pop,.dshwv-usagepanel,.dshwv-rolelist,.dshwv-audiolist,.dshwv-custmenu,.dshwv-menu-btn')
        : null;
      if (ui) { window.__whaleOverlay && window.__whaleOverlay.ping('click-ui ' + desc(ui)); return }
      const root = document.querySelector('.dshwv-root');
      let inside = false;
      let box = 'none';
      if (root) {
        const r = root.getBoundingClientRect();
        box = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',');
        inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      }
      window.__whaleOverlay && window.__whaleOverlay.ping(
        'click @' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' inWhale=' + inside + ' box=' + box);
      if (inside) {
        const bo = window.__whaleOverlay;
        if (bo) {
          // 拖过进度条之后歌词会偏，用 Shift/Alt + 点鲸鱼手动校准
          if (e.shiftKey) bo.nudgeLyric(5);
          else if (e.altKey) bo.nudgeLyric(-5);
          else bo.togglePlayback();
        }
      }
    } catch (err) { try { window.__whaleOverlay.ping('err ' + err.message) } catch (e2) {} }
  }, true);
  return true;
})()`

let media = { title: '', artist: '', playing: false }
let helper = null

// ── 本地「账单接口」：邮百工网关没有余额 API，就把 token 按官方价折成钱再从额度里扣
//    真·token 来源是 DSH 自己的用量队列（邮百工版每发一次请求就落一行）：
//      %LOCALAPPDATA%\YouLabberLocal\harness\youlabber-usage-queue.jsonl
//      {"modelName":"ybg-youlaber-ds4f","inputTokens":60065,"outputTokens":393,
//       "cacheReadTokens":6144,"sessionId":"...","seq":"4360", ...}
//    按官方 DeepSeek 价（工作日峰时翻倍、周末全天谷价）折成人民币，从起始额度里扣。
const DSH_DIR = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const HARNESS_DIR = path.join(process.env.LOCALAPPDATA || '', 'YouLabberLocal', 'harness')
const USAGE_QUEUE = path.join(HARNESS_DIR, 'youlabber-usage-queue.jsonl')
const SPEND_STATE = path.join(DSH_DIR, '.dshw-spend.json')
const SPEND_INITIAL = 39.942878      // 起始额度（就是那个一直不动的 39.94）
const BALANCE_PORT = 47821
// 官方 DeepSeek 价：元 / 百万 token，[谷价, 峰价]
const PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }

// 峰时：北京时间周一至周五 9:00–12:00、14:00–18:00；周末/其余时段按谷价
function isPeak(ts) {
  const d = new Date(ts + 8 * 3600e3)
  const wd = d.getUTCDay()
  if (wd === 0 || wd === 6) return false
  const h = d.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

let spendState = { sessions: {}, spent: 0, tokens: { miss: 0, hit: 0, out: 0 } }
let spendLoaded = false

function loadSpendState() {
  if (spendLoaded) return
  spendLoaded = true
  try { Object.assign(spendState, JSON.parse(fs.readFileSync(SPEND_STATE, 'utf8'))) } catch {}
  if (!spendState.sessions || typeof spendState.sessions !== 'object') spendState.sessions = {}
  if (!spendState.tokens) spendState.tokens = { miss: 0, hit: 0, out: 0 }
}
function saveSpendState() {
  try {
    spendState.updatedAt = Date.now()
    fs.writeFileSync(SPEND_STATE, JSON.stringify(spendState, null, 2), 'utf8')
  } catch (e) { log('spend save failed', e.message) }
}

// 扫用量队列：只吃没见过的 seq（同会话内单调递增），队列本身被清空也不影响累计
function tickSpend() {
  loadSpendState()
  let text = ''
  try { text = fs.readFileSync(USAGE_QUEUE, 'utf8') } catch (e) { return spendSummary() }
  let changed = false
  let added = 0
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let e
    try { e = JSON.parse(s) } catch (err) { continue }
    const sid = String(e.sessionId || '')
    const seq = Number(e.seq) || 0
    if (!sid || !seq) continue
    if (seq <= (Number(spendState.sessions[sid]) || 0)) continue
    const off = isPeak(Date.now()) ? 1 : 0
    const miss = Number(e.inputTokens) || 0
    const hit = Number(e.cacheReadTokens) || 0
    const out = Number(e.outputTokens) || 0
    const cost = (miss / 1e6) * PRICE.miss[off] + (hit / 1e6) * PRICE.hit[off] + (out / 1e6) * PRICE.out[off]
    spendState.spent = (Number(spendState.spent) || 0) + cost
    spendState.tokens.miss = (Number(spendState.tokens.miss) || 0) + miss
    spendState.tokens.hit = (Number(spendState.tokens.hit) || 0) + hit
    spendState.tokens.out = (Number(spendState.tokens.out) || 0) + out
    spendState.sessions[sid] = seq
    added += cost
    changed = true
  }
  if (changed) {
    saveSpendState()
    log('spend +' + added.toFixed(6) + ' → 累计 ' + (Number(spendState.spent) || 0).toFixed(6))
  }
  return spendSummary()
}

function spendSummary() {
  const spent = Number(spendState.spent) || 0
  const t = spendState.tokens || { miss: 0, hit: 0, out: 0 }
  return {
    remaining: Math.round((SPEND_INITIAL - spent) * 1e6) / 1e6,
    used: Math.round(spent * 1e6) / 1e6,
    tokens: (t.miss || 0) + (t.hit || 0) + (t.out || 0),
    tokensIn: t.miss || 0,
    tokensCache: t.hit || 0,
    tokensOut: t.out || 0,
    peak: isPeak(Date.now()),
    updatedAt: Date.now(),
  }
}

function startBalanceServer() {
  tickSpend()                       // 启动就算一遍历史用量
  setInterval(() => { try { tickSpend() } catch (e) {} }, 1000)
  const srv = http.createServer((req, res) => {
    const p = String(req.url || '/').split('?')[0]
    if (p !== '/balance') { res.writeHead(404); res.end('not found'); return }
    let body
    try { body = tickSpend() } catch (e) { body = { error: e.message } }
    const json = JSON.stringify(body)
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Access-Control-Allow-Origin': '*',
    })
    res.end(json)
  })
  srv.on('error', (e) => log('balance server failed', e.message))
  srv.listen(BALANCE_PORT, '127.0.0.1', () => log('balance server on 127.0.0.1:' + BALANCE_PORT))
  return srv
}

// ── 网易云播放进度：客户端不暴露 SMTC，但本地 SQLite 里记着每首歌的起播时刻
//    Library\webdb.dat → historyTracks(playtime, id, jsonStr)
//    playtime = 这首歌开始播放的 Unix 毫秒；用 now - playtime 就是播放位置。
const NP_DB = path.join(process.env.LOCALAPPDATA || '', 'Netease', 'CloudMusic', 'Library', 'webdb.dat')
let npDb = null
let npLastRead = 0
let npLastPlaytime = 0
let npErrLogged = false
let npNow = null          // 最近一次读到的歌名/歌手（比窗口标题可靠）

// ── 网易云歌词：CDP 直连它的页面，读它自己算好、自己高亮的那句
//    这比"估进度"强的地方：拖进度条、暂停、跳播都不用管，它高亮哪句我们就显示哪句。
//    前提：客户端带 --remote-debugging-port 启动（restart-netease-debug.ps1）。
const CDP_PORT = 9222
const LYRIC_EXPR = `(function(){var l=document.querySelectorAll('#mod_pc_lyric_record li.line');for(var i=0;i<l.length;i++){var p=l[i].querySelector('p');if(!p)continue;var c=getComputedStyle(p);if(c.color==='rgb(255, 255, 255)'||parseFloat(c.fontSize)>=21){return JSON.stringify({t:l[i].getAttribute('data-time')||'',line:(p.innerText||'').trim()})}}return ''})()`
let cdpSock = null
let cdpPending = new Map()
let cdpSeq = 0
let cdpRetryAt = 0
let cdpLyric = { line: '', t: 0, at: 0 }
let cdpLogged = ''      // 只在状态切换时打日志，免得刷屏

function cdpLogOnce(msg) {
  if (cdpLogged === msg) return
  cdpLogged = msg
  log('cdp:', msg)
}

async function cdpTargetWs() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { signal: AbortSignal.timeout(2000) })
  const list = await res.json()
  const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  return page ? page.webSocketDebuggerUrl : ''
}

function cdpEval(expression) {
  return new Promise((resolve, reject) => {
    if (!cdpSock) return reject(new Error('no socket'))
    const id = ++cdpSeq
    cdpPending.set(id, { resolve, reject })
    try {
      cdpSock.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    } catch (e) { cdpPending.delete(id); reject(e) }
  })
}

function dropCdp(why) {
  cdpLogOnce(why)
  try { cdpSock && cdpSock.close() } catch {}
  cdpSock = null
  cdpPending.forEach((p) => { try { p.reject(new Error(why)) } catch {} })
  cdpPending.clear()
  cdpRetryAt = Date.now() + 5000
}

async function cdpLoop() {
  try {
    if (!cdpSock) {
      if (Date.now() < cdpRetryAt) throw new Error('等重连')
      const url = await cdpTargetWs()
      if (!url) throw new Error('没有可调试页面（网易云不是带 --remote-debugging-port 启动的）')
      const ws = new WebSocket(url)
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('连接超时')), 3000)
        ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
        ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('连接失败')) }, { once: true })
      })
      cdpSock = ws
      ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(ev.data) } catch { return }
        if (!msg.id || !cdpPending.has(msg.id)) return
        const { resolve, reject } = cdpPending.get(msg.id)
        cdpPending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message || 'cdp error'))
        else resolve(msg.result)
      })
      ws.addEventListener('close', () => { if (cdpSock === ws) { cdpSock = null; cdpRetryAt = Date.now() + 5000 } })
      cdpLogOnce('已连上网易云页面')
    }
    const r = await cdpEval(LYRIC_EXPR)
    const raw = r && r.result ? r.result.value : ''
    let info = null
    if (typeof raw === 'string' && raw) { try { info = JSON.parse(raw) } catch {} }
    if (info && info.line) {
      if (info.line !== cdpLyric.line) {
        cdpLyric = { line: info.line, t: Number(info.t) || 0, at: Date.now() }
      } else {
        cdpLyric.at = Date.now()
      }
    } else if (cdpLyric.at && Date.now() - cdpLyric.at > 4000) {
      cdpLyric = { line: '', t: 0, at: 0 }     // 高亮消失（暂停/切歌中）就不再显示旧句
    }
  } catch (e) {
    if (cdpSock) dropCdp('读歌词失败: ' + e.message)
    else cdpLogOnce(String(e.message || e))
  }
  setTimeout(cdpLoop, 400)
}

function readNeteaseNow() {
  try {
    if (!fs.existsSync(NP_DB)) return null
    if (!npDb) {
      const { DatabaseSync } = require('node:sqlite')
      npDb = new DatabaseSync(NP_DB, { readOnly: true })
    }
    const row = npDb.prepare('select playtime, id, jsonStr from historyTracks order by rowid desc limit 1').get()
    if (!row) return null
    let info = {}
    try { info = JSON.parse(String(row.jsonStr || '{}')) } catch {}
    return {
      playtime: Number(row.playtime),
      id: String(row.id),
      name: info.name || '',
      artists: (info.artists || []).map((a) => a.name).join('/'),
      duration: Number(info.duration || 0),
    }
  } catch (e) {
    npDb = null            // 数据库被锁 / 结构变了：下次重建连接
    if (!npErrLogged) { npErrLogged = true; log('netease db read failed', e.message) }
    return null
  }
}

/** 读网易云本地库：歌名/歌手/这首歌的起播时刻（起播时刻用来给歌词进度兜底）。 */
function syncNeteaseAnchor() {
  const now = Date.now()
  if (now - npLastRead < 1000) return
  npLastRead = now
  const np = readNeteaseNow()
  if (!np) return
  npNow = np
  if (!np.playtime || np.playtime === npLastPlaytime) return
  npLastPlaytime = np.playtime
  log('netease anchor', JSON.stringify({ song: np.name, artist: np.artists, playtime: np.playtime, pos: Math.round((now - np.playtime) / 1000) }))
  sendMediaCmd(`anchor ${np.playtime}`)
}

// ── 媒体状态：Electron 这边的 stdout 管道实测收不到 helper 的数据，
//    所以 helper 每轮把状态盖一份到 %TEMP%\whale-media-state.json，这里读文件。
const MEDIA_STATE = path.join(os.tmpdir(), 'whale-media-state.json')
let mediaStateMtime = 0
// 这几个状态原本声明在下面的 else 块里，顶层函数取不到（会 ReferenceError 被 catch 吞掉），
// 所以提到顶层，块里只挂一个回调。
let lastNeteaseAlive = null
let aliveProbeLogged = false
let chunkLogged = false
let onNeteaseStarted = null
let lastPlaying = null

function applyMediaJson(j) {
  if (!j || typeof j !== 'object') return
  media = {
    title: j.title || '',
    artist: j.artist || '',
    playing: !!j.playing,
    line: j.line || '',
    pos: Number(j.pos || 0),
    posOk: !!j.posOk,
    alive: typeof j.alive === 'boolean' ? j.alive : undefined,
  }
  // 开始放歌（或暂停后恢复）→ 把鲸鱼叫出来；网易云刚启动也照样叫
  const startedPlaying = media.playing && lastPlaying === false
  lastPlaying = media.playing
  if (startedPlaying || (media.alive === true && lastNeteaseAlive === false)) {
    log(startedPlaying ? '播放开始 → 叫出鲸鱼' : 'netease started → auto show whale')
    try { if (typeof onNeteaseStarted === 'function') onNeteaseStarted() } catch (e) {}
  }
  if (typeof media.alive === 'boolean') {
    lastNeteaseAlive = media.alive
    if (!aliveProbeLogged) { aliveProbeLogged = true; log('netease alive probe: ' + String(media.alive)) }
  }
}

function syncMediaFromFile() {
  try {
    const st = fs.statSync(MEDIA_STATE)
    if (st.mtimeMs === mediaStateMtime) return
    mediaStateMtime = st.mtimeMs
    applyMediaJson(JSON.parse(fs.readFileSync(MEDIA_STATE, 'utf8')))
  } catch {}
}

function startMediaHelper() {
  if (helper) return
  if (!fs.existsSync(MEDIA_HELPER)) { log('media helper missing', MEDIA_HELPER); return }
  try {
    helper = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', MEDIA_HELPER,
    ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let buf = ''
    helper.stdout.setEncoding('utf8')
    helper.stdout.on('data', (chunk) => {
      if (!chunkLogged) { chunkLogged = true; log('helper chunk probe: len=' + chunk.length + ' head=' + JSON.stringify(String(chunk).slice(0, 40))) }
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try {
          applyMediaJson(JSON.parse(line))
        } catch {}
      }
    })
    helper.on('error', (e) => log('media helper error', e.message))
    helper.on('exit', (code) => {
      helper = null
      log('media helper exited', String(code), '- restart in 5s')
      setTimeout(startMediaHelper, 5000)
    })
    log('media helper started pid=' + helper.pid)
    npLastPlaytime = 0   // helper restarted: resync the progress anchor
  } catch (e) {
    log('media helper spawn failed', e.message)
    helper = null
    setTimeout(startMediaHelper, 5000)
  }
}

function sendMediaCmd(cmd) {
  try { fs.writeFileSync(MEDIA_CMD_FILE, `${cmd} ${Date.now()}\n`) } catch (e) { log('media cmd write failed', e.message) }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return null }
}

function pidAlive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let win = null
  let tray = null
  let ignoring = true
  let currentUrl = ''
  let whaleSeen = false
  let busy = false
  let visible = true
  let hoverWhale = false
let lastDragAt = 0
  let tipStyleChecked = false
let mouthEnabled = true
  // 播放器模式：auto 自动 / netease 网易云 / kugou 酷狗（写进文件，media-helper 每轮读取）
  const MODE_FILE = path.join(HOME, 'whale-overlay-mode.txt')
  const MODE_LABELS = { auto: '自动识别', netease: '网易云音乐', kugou: '酷狗音乐' }
  function readPlayerMode() {
    try {
      const m = String(fs.readFileSync(MODE_FILE, 'utf8')).replace(/^\uFEFF/, '').trim().toLowerCase()
      return MODE_LABELS[m] ? m : 'auto'
    } catch { return 'auto' }
  }
  function writePlayerMode(mode) {
    try { fs.writeFileSync(MODE_FILE, mode, 'utf8'); log('player mode = ' + mode) } catch (e) { log('write mode failed: ' + e.message) }
  }
  let playerMode = readPlayerMode()
  let tipShown = false
  let lastTipKey = ''
  let lastTipCx = 0
  let lastTipTop = 0
  // 浮动气泡的基准：累计花费涨了就飘一个 -0.0xx（-1 表示还没初始化）
  let bubbleBase = -1
  let lastLoggedTip = ''
  let hotkey = ''

  function floatIn(ms, delay) {
    if (!win || win.isDestroyed()) return
    try {
      win.webContents.executeJavaScript('window.__whaleFloatIn ? window.__whaleFloatIn(' + (ms || 2800) + ',' + (delay === undefined ? 1000 : delay) + ') : 0', true)
        .then((from) => log('浮现: 落在屏幕下方 ' + from + 'px，停 1 秒后升起'))
        .catch(() => {})
    } catch {}
  }

  // 双击鲸鱼 → 隐藏
  setInterval(async () => {
    if (!win || win.isDestroyed()) return
    try {
      const t = await win.webContents.executeJavaScript('window.__whaleTakeDbl ? window.__whaleTakeDbl() : 0', true)
      if (t) { log('双击 → 隐藏鲸鱼'); setVisible(false) }
    } catch {}
  }, 150)

  // 测试钩子：%TEMP%\whale-test-float 存在就播一次浮现
  setInterval(async () => {
    try {
      const pd = path.join(os.tmpdir(), 'whale-test-dbl')
      if (fs.existsSync(pd)) {
        fs.unlinkSync(pd)
        const got = await win.webContents.executeJavaScript('window.__whaleSimulateDbl ? window.__whaleSimulateDbl() : 0', true)
        log('测试: 模拟双击 → 时间戳 ' + got)
      }
      const ph = path.join(os.tmpdir(), 'whale-test-hide')
      if (fs.existsSync(ph)) { fs.unlinkSync(ph); setVisible(false); log('测试: 已隐藏') }
      const p = path.join(os.tmpdir(), 'whale-test-float')
      if (!fs.existsSync(p)) return
      fs.unlinkSync(p)
      floatIn(2800, 1000)
      for (const at of [500, 2200, 4200]) {
        setTimeout(async () => {
          try {
            const st = await win.webContents.executeJavaScript('window.__whaleMouthStats ? JSON.stringify(window.__whaleMouthStats()) : ""', true)
            const o = JSON.parse(st || '{}')
            log('浮现 ' + at + 'ms: floatY=' + o.floatY + ' 显示=' + o.hostOp)
          } catch {}
        }, at)
      }
    } catch {}
  }, 400)
  async function setVisible(v) {
    const wasHidden = !visible
    visible = !!v
    overlayHidden = !visible
    if (!win || win.isDestroyed()) return
    if (visible) {
      // 先把画面藏好、沉到屏幕下沿外，等 DOM 生效了再让窗口出现 —— 这样不会闪
      if (wasHidden) {
        try {
          const parked = await win.webContents.executeJavaScript('window.__whalePrepareShow ? window.__whalePrepareShow() : 0', true)
          log('显示前已藏好，沉底 ' + parked + 'px')
        } catch {}
      }
      try { win.showInactive() } catch (e) { log('show failed', e.message) }
      // 从隐藏状态重新出现 → 停 1 秒再从屏幕底部升上来
      if (wasHidden) floatIn(2800, 1000)
      try { win.setAlwaysOnTop(true, 'screen-saver') } catch {}
    } else {
      // 隐藏前先把鼠标穿透设回去：否则窗口虽然不见了，点击还可能被它吃掉
      ignoring = true
      try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}
      try { win.hide() } catch (e) { log('hide failed', e.message) }
    }
    try {
      if (tray) {
        tray.setToolTip(visible ? '小鲸鱼：显示中' : '小鲸鱼：已隐藏')
        tray.setContextMenu(buildTrayMenu())
      }
    } catch {}
    log('visible ->', visible)
  }
  function toggleVisible() { setVisible(!visible) }
  // 网易云一起来就把鲸鱼叫出来（顶层 applyMediaJson 通过这个回调触发）
  onNeteaseStarted = () => setVisible(true)

  function stateFileUrl() {
    const s = readState()
    return s && typeof s.url === 'string' ? s.url : ''
  }

  function applyClickThrough(hit) {
    if (!win || win.isDestroyed()) return
    if (hit === !ignoring) return
    ignoring = !hit
    log('mouse', hit ? 'interactive (指针在鲸鱼上)' : 'click-through')
    try { win.setIgnoreMouseEvents(ignoring, { forward: true }) } catch (e) { log('setIgnoreMouseEvents failed', e.message) }
  }

  async function poll() {
    if (busy || !win || win.isDestroyed()) return
    // 隐藏了就别探：窗口不可见，不该再抢鼠标
    if (!visible) { applyClickThrough(false); return }
    // 页面正在导航/重载：这期间必须保持穿透，否则整块屏幕的点击都会被吞掉
    // （这就是"明明那地方没鲸鱼，鼠标却点不动"的根因）
    try {
      if (win.webContents.isLoading()) { applyClickThrough(false); return }
    } catch { applyClickThrough(false); return }
    try { syncMediaFromFile() } catch {}
    busy = true
    try {
      syncNeteaseAnchor()
      const info = await win.webContents.executeJavaScript(RECTS_JS, true)
      if (info && info.whale && !whaleSeen) {
        whaleSeen = true
        log('whale rendered at', JSON.stringify(info.whale))
        try {
          const img = await win.webContents.capturePage()
          fs.writeFileSync(SHOT_FILE, img.toPNG())
          log('screenshot saved', SHOT_FILE)
        } catch (e) { log('screenshot failed', e.message) }
      }
      if (!info) { busy = false; return }
      const p = screen.getCursorScreenPoint()
      const b = win.getBounds()
      const x = p.x - b.x
      const y = p.y - b.y
      if (info.dragging) lastDragAt = Date.now()
      const dragHold = Date.now() - lastDragAt < 800
      const inside = info.dragging || dragHold || (info.rects || []).some(
        (r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3],
      )
      applyClickThrough(!!inside)

      // 常态：显示当前这句歌词；鼠标移到鲸鱼上：改显示歌名 + 歌手
      const wr = info.whale
      let overWhale = !!wr && !info.dragging && x >= wr[0] && x <= wr[0] + wr[2] && y >= wr[1] && y <= wr[1] + wr[3]
      // 调试开关：%TEMP%\whale-tip-force.txt 存在时强制常显（便于无人值守截图验证）
      if (!overWhale && wr && fs.existsSync(path.join(os.tmpdir(), 'whale-tip-force.txt'))) overWhale = true
      hoverWhale = overWhale

      const pausedTag = media.playing ? '' : '（已暂停）'
      // 歌名/歌手优先用网易云本地库（窗口标题在开了"桌面歌词"时会变成"桌面歌词"）
      const songName = (npNow && npNow.name) || (media.title && media.title !== '桌面歌词' ? media.title : '')
      const songArtist = (npNow && npNow.artists) || media.artist
      const titleText = songName
        ? '♪ ' + songName + (songArtist ? ' · ' + songArtist : '') + pausedTag
        : ''
      // 歌词优先用 CDP 读到的"网易云自己高亮的那句"，读不到才退回按进度估算
      const lineCandidate = cdpLyric.line || (media.posOk ? media.line : '')
      const lyricText = lineCandidate ? lineCandidate + pausedTag : ''
      // 花钱了就飘一个 -0.0xx 上去（跟挂件那个气泡同一个意思）
      try {
        const s = spendSummary()
        if (wr) {
          if (bubbleBase < 0) bubbleBase = s.used
          else if (s.used > bubbleBase + 1e-7) {
            const delta = s.used - bubbleBase
            bubbleBase = s.used
            const vw0 = info.vw || 1600
            const cx0 = Math.round(Math.min(Math.max(wr[0] + wr[2] / 2, 90), vw0 - 90))
            // 从鲸鱼头顶里冒出来：起点压在鲸鱼上沿内侧，再往上飘
            const top0 = Math.round(wr[1] + 8)
            try {
              await win.webContents.executeJavaScript(
                `window.__whaleFloat && window.__whaleFloat(${JSON.stringify('-' + delta.toFixed(4))}, ${cx0}, ${top0})`, true)
            } catch {}
            log('spend bubble -' + delta.toFixed(4))
          }
        }
      } catch (e) {}
      const head = overWhale ? titleText : (lyricText || titleText)
      const text = head
      if (!wr || !text) {
        if (tipShown) {
          tipShown = false
          lastTipKey = ''
          lastLoggedTip = ''
          try { await win.webContents.executeJavaScript('window.__whaleTip && window.__whaleTip(false)', true) } catch {}
        }
      } else {
        const vw = info.vw || 1600
        const vh = info.vh || 900
        const cx = Math.min(Math.max(wr[0] + wr[2] / 2, 90), vw - 90)
        let top = wr[1] + wr[3] + 6
        if (top > vh - 30) top = Math.max(4, wr[1] - 32)   // 贴着屏幕底边时改放鲸鱼上方
        const moved = Math.abs(cx - lastTipCx) > 2 || Math.abs(top - lastTipTop) > 2
        if (text !== lastTipKey || !tipShown || moved) {
          lastTipKey = text
          lastTipCx = cx
          lastTipTop = top
          tipShown = true
          if (head !== lastLoggedTip) { lastLoggedTip = head; log('tip:', head) }
          try {
            await win.webContents.executeJavaScript(
              `window.__whaleTip && window.__whaleTip(true, ${JSON.stringify(text)}, ${Math.round(cx)}, ${Math.round(top)})`, true)
            if (!tipStyleChecked) {
              tipStyleChecked = true
              const st = await win.webContents.executeJavaScript(`(() => {
                const e = document.querySelector('.dshwv-mediatip');
                if (!e) return 'missing';
                const cs = getComputedStyle(e);
                return 'bg=' + cs.backgroundColor + ' border=' + cs.borderTopWidth + ' shadow=' + cs.boxShadow.slice(0, 40) +
                       ' op=' + cs.opacity + ' size=' + Math.round(e.offsetWidth) + 'x' + Math.round(e.offsetHeight) +
                       ' color=' + cs.color + ' textShadow=' + (cs.textShadow ? 'yes' : 'none')
              })()`, true)
              log('tip style:', st)
              const fx = await win.webContents.executeJavaScript(
                'typeof window.__whaleTip + "/" + typeof window.__whaleFloat', true)
              log('tip inject: __whaleTip/__whaleFloat =', fx)
            }
          } catch (e) { log('tip call failed', e.message) }
        }
      }
    } catch (e) {
      // 页面还在导航 / 上下文销毁：忽略
    }
    busy = false
  }

  function createWindow(url) {
    const display = screen.getPrimaryDisplay()
    const b = display.bounds
    const area = display.workArea
    log('display', JSON.stringify({ bounds: b, workArea: area, scale: display.scaleFactor }))
    win = new BrowserWindow({
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: true,
      show: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    try { win.setAlwaysOnTop(true, 'screen-saver') } catch {}
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }) } catch {}
    try { win.setIgnoreMouseEvents(true, { forward: true }) } catch {}
    ignoring = true
    currentUrl = url
    whaleSeen = false

    win.webContents.on('did-start-loading', () => {
      // 重载期间整块窗口都会吃点击，先强制穿透
      applyClickThrough(false)
      hoverWhale = false
      try { win.webContents.executeJavaScript('window.__whaleTip && window.__whaleTip(false)', true).catch(() => {}) } catch {}
    })
    win.webContents.on('did-finish-load', async () => {
      try { await win.webContents.insertCSS(HIDE_CSS, { cssOrigin: 'user' }) } catch (e) { log('insertCSS failed', e.message) }
      log('loaded', url.replace(/token=[^&]+/, 'token=***'))
      try { await win.webContents.executeJavaScript(TIP_JS, true) } catch (e) { log('tip inject failed', e.message) }
      try { await mouth.injectMouth(win, log) } catch (e) { log('mouth failed', e.message) }
  setTimeout(() => { try { startPauseSync() } catch (e) { log('pause sync failed ' + e.message) } }, 3000)
      try { await win.webContents.executeJavaScript(CLICK_JS, true) } catch (e) { log('click inject failed', e.message) }
      try {
        const bridge = await win.webContents.executeJavaScript('typeof window.__whaleOverlay', true)
        log('preload bridge: ' + bridge)
      } catch (e) { log('bridge probe failed', e.message) }
      setTimeout(async () => {
        try {
          const d = await win.webContents.executeJavaScript(DIAG_JS, true)
          log('DIAG ' + JSON.stringify(d))
          const img = await win.webContents.capturePage()
          fs.writeFileSync(SHOT_FILE, img.toPNG())
          log('screenshot saved (delayed)', SHOT_FILE)
        } catch (e) { log('DIAG failed ' + e.message) }
      }, 5000)
    })
    win.webContents.on('console-message', (_e, level, message) => {
      if (/whaleOverlay|preload|Unable to load/i.test(String(message))) log('renderer console[' + level + ']', String(message).slice(0, 300))
    })
    win.webContents.on('did-fail-load', (_e, code, desc) => {
      log('load failed', code, desc)
      setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(currentUrl) }, 3000)
    })
    win.once('ready-to-show', () => {
      if (visible) { try { win.showInactive() } catch {} }
    })
    win.loadURL(url).catch((e) => log('loadURL rejected', e.message))
  }

  function buildTrayMenu() {
    return Menu.buildFromTemplate([
      { label: visible ? '隐藏小鲸鱼（' + (hotkey || '托盘') + '）' : '显示小鲸鱼（' + (hotkey || '托盘') + '）', click: toggleVisible },
      {
        label: '嘴随音量（跟着电脑声音张合）',
        type: 'checkbox',
        checked: mouthEnabled,
        click: (item) => {
          mouthEnabled = !!item.checked
          try {
            if (win && !win.isDestroyed()) {
              win.webContents.executeJavaScript('window.__whaleMouthSetEnabled && window.__whaleMouthSetEnabled(' + mouthEnabled + ')', true)
            }
          } catch {}
          log('mouth enabled = ' + mouthEnabled)
          try { tray.setContextMenu(buildTrayMenu()) } catch {}
        },
      },
      {
        label: '播放器：' + (MODE_LABELS[playerMode] || '自动识别'),
        submenu: ['auto', 'netease', 'kugou'].map((mode) => ({
          label: MODE_LABELS[mode],
          type: 'radio',
          checked: playerMode === mode,
          click: () => {
            playerMode = mode
            writePlayerMode(mode)
            try { tray.setContextMenu(buildTrayMenu()) } catch {}
          },
        })),
      },
      { label: '重新载入', click: () => { const u = stateFileUrl(); if (u && win) { whaleSeen = false; win.loadURL(u) } } },
      { label: '打开日志', click: () => { require('electron').shell.openPath(LOG_FILE) } },
      { type: 'separator' },
      { label: '退出', click: () => { app.quit() } },
    ])
  }

  function makeTray() {
    const iconCandidates = [
      path.join(__dirname, 'icon.png'),
      path.join(HOME, 'plugin-sources', 'dsh-whale-widget', 'icon.png'),
    ]
    let img = nativeImage.createEmpty()
    for (const p of iconCandidates) {
      try { if (fs.existsSync(p)) { img = nativeImage.createFromPath(p).resize({ width: 16, height: 16 }); break } } catch {}
    }
    try { tray = new Tray(img) } catch (e) { log('tray failed', e.message); return }
    tray.setToolTip('小鲸鱼：显示中')
    tray.setContextMenu(buildTrayMenu())
    try {
      tray.on('click', toggleVisible)
    } catch {}
  }

  app.on('second-instance', () => {
    const u = stateFileUrl()
    if (u && win && u !== currentUrl) { whaleSeen = false; win.loadURL(u) }
  })

  ipcMain.on('media:toggle', () => {
    log('media toggle requested; current=' + JSON.stringify(media))
    sendMediaCmd('toggle')
  })
  ipcMain.on('media:nudge', (_e, seconds) => {
    const v = Math.max(-120, Math.min(120, Math.round(Number(seconds) || 0)))
    if (!v) return
    log('lyric nudge ' + (v > 0 ? '+' : '') + v + 's; current=' + JSON.stringify(media))
    sendMediaCmd('nudge ' + v)
  })
  ipcMain.on('media:ping', (_e, msg) => log('page: ' + String(msg).slice(0, 200)))

  app.whenReady().then(() => {
    app.commandLine.appendSwitch('enable-transparent-visuals')
    log('=== helper start ===')
    cdpLoop()
    startBalanceServer()
    startMediaHelper()
    const url = stateFileUrl()
    if (!url) {
      log('no state url; quitting')
      app.quit()
      return
    }
    createWindow(url)
    makeTray()
    try {
      // Ctrl+Alt+W 已被别的软件占了，依次退让，用第一个能注册上的
      const HOTKEY_TRIES = ['Control+Alt+W', 'Control+Alt+Shift+W', 'Alt+Shift+W', 'Control+Alt+F9']
      for (const k of HOTKEY_TRIES) {
        let ok = false
        try { ok = globalShortcut.register(k, toggleVisible) } catch {}
        if (ok) { hotkey = k; break }
      }
      log('hotkey', hotkey ? (hotkey + ' registered') : 'FAILED (all taken)')
    } catch (e) { log('hotkey failed', e.message) }
    let audioSendCount = 0
  mouth.startAudioMeter(log, (v) => {
    audioSendCount++
    if (audioSendCount <= 3 || audioSendCount % 200 === 0) log('audio send #' + audioSendCount + ' = ' + v)
    try { if (win && !win.isDestroyed()) win.webContents.send('whale:audio', v) } catch {}
  })
    setInterval(poll, 120)
    // 兜底看门狗：只要指针不在鲸鱼上，就强制保持穿透。
    // 防止某次 poll 卡住/页面重载把"可交互"状态留在那儿，导致整屏点击被吞。
    setInterval(() => {
      try {
        if (!win || win.isDestroyed() || !visible) return
        // 拖动中/刚拖完不能强制穿透，否则拖动会被每 400ms 打断一次
        if (Date.now() - lastDragAt < 900) return
        if (!hoverWhale && !ignoring) applyClickThrough(false)
      } catch {}
    }, 400)
    // URL 变化（宿主重启换了端口/令牌）→ 重载
    setInterval(() => {
      const s = readState()
      if (!s) return
      if (s.url && s.url !== currentUrl) {
        log('state url changed; reloading')
        currentUrl = s.url
        whaleSeen = false
        if (win && !win.isDestroyed()) win.loadURL(s.url).catch(() => {})
      }
    }, 2000)
    // 宿主进程消失 → 退出
    setInterval(() => {
      const s = readState()
      if (!s || !s.pid) return
      if (!pidAlive(s.pid)) { log('host pid gone; quitting'); app.quit() }
    }, 5000)
  })

  app.on('window-all-closed', () => app.quit())

  app.on('will-quit', () => { try { globalShortcut.unregisterAll() } catch {} })

  app.on('before-quit', () => {
    try { if (helper) { helper.kill(); helper = null } } catch {}
    try { mouth.stopAudioMeter() } catch {}
  })
}

// ── 隐藏状态标记（的 setVisible 里写，下面的循环读）
var overlayHidden = false
let lastPauseCmdAt = 0
let hiddenFired = false      // 隐藏期间是否已经压制过一次
let hiddenPlaySince = 0
let lastPos = null

var pauseBusy = false
function pauseNeteaseNow(reason) {
  if (pauseBusy) return 'busy'
  try {
    const { spawn } = require('child_process')
    const ps = path.join(__dirname, 'pause-netease.ps1')
    if (!fs.existsSync(ps)) return
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps], { windowsHide: true, stdio: 'ignore', detached: true })
    pauseBusy = true
    p.on('exit', () => { pauseBusy = false })
    p.on('error', () => { pauseBusy = false })
    p.unref()
    log('隐藏中 → 已让网易云暂停（' + reason + '）')
  } catch (e) { log('pauseNetease 失败: ' + (e && e.message)) }
}

// ── 朝向 + 暂停帧（都由鼠标相对鲸鱼的位置驱动）
let pauseSyncTimer = null
function startPauseSync() {
  if (pauseSyncTimer) return 'already'
  const { screen, BrowserWindow } = require('electron')
  const pauseDir = path.join(__dirname, 'pause-frames')
  let PN = 0
  try { PN = fs.readdirSync(pauseDir).filter((x) => x.endsWith('.webp')).length } catch {}

  let lastTarget = -2
  let lastMirror = null
  let lastWhy = ''
  let boxCache = null
  let boxAt = 0

  pauseSyncTimer = setInterval(async () => {
    try {
      const w = BrowserWindow.getAllWindows()[0]
      if (!w || w.isDestroyed()) return
      syncMediaFromFile()

      const now = Date.now()
      if (!boxCache || now - boxAt > 1500) {
        const st = await w.webContents.executeJavaScript('window.__whaleMouthStats ? JSON.stringify(window.__whaleMouthStats()) : ""', true)
        try {
          const g = JSON.parse(st || '{}')
          if (g.box && g.box !== 'none') {
            const p = g.box.split(',').map(Number)
            if (p.length === 3 && p[2] > 8) boxCache = { x: p[0], y: p[1], w: p[2], win: g.win || 0 }
          }
        } catch {}
        boxAt = now
      }
      if (!boxCache) return

      const b = w.getBounds()
      const cur = screen.getCursorScreenPoint()
      const pageX = cur.x - b.x
      const pageY = cur.y - b.y
      const whaleCx = boxCache.x + boxCache.w / 2
      const whaleCy = boxCache.y + boxCache.w / 2
      const d = Math.hypot(pageX - whaleCx, pageY - whaleCy)
      const R = Math.max(120, boxCache.w * 1.35)

      // 隐藏期间让网易云停下来：
      //   状态文件的 playing 字段有 5~10 秒延迟，所以只看它会把暂停又点回播放。
      //   这里用 peak>0 或 pos 在前进 来确认真的在放，且一次隐藏只发一次。
      const playingNow = !!(media && media.playing)
      const posAdvanced = !!(media && lastPos !== null && media.pos > lastPos + 0.05)
      const loudNow = !!(media && media.peak > 0.004)
      if (media) lastPos = media.pos
      if (overlayHidden) {
        const reallyPlaying = playingNow && (loudNow || posAdvanced)
        if (!reallyPlaying) {
          if (!playingNow) { hiddenFired = false; hiddenPlaySince = 0 }
        } else {
          if (!hiddenPlaySince) hiddenPlaySince = Date.now()
          const firstTime = !hiddenFired
          const stuckLong = hiddenFired && Date.now() - hiddenPlaySince > 15000
          if (firstTime || stuckLong) {
            hiddenFired = true
            hiddenPlaySince = Date.now()
            pauseNeteaseNow('隐藏期间在播放')
          }
        }
      } else { hiddenFired = false; hiddenPlaySince = 0 }

      const hasSong = !!(media && (media.title || media.line))
      const forced = fs.existsSync(path.join(os.tmpdir(), 'whale-force-pause'))
      const paused = forced || (hasSong && media.playing === false)
      if (paused !== startPauseSync._last) { startPauseSync._last = paused; log('pause 状态: ' + paused) }

      // 朝向：暂停中且鼠标在作用距离内 → 跟随鼠标；否则按屏幕左右半
      // 中间留死区（H），把鼠标放在鲸鱼正中附近不会来回翻
      const nearAndPaused = paused && d < R
      const why = nearAndPaused ? '鼠标' : '屏幕'
      const H = Math.max(28, boxCache.w * 0.30)      // 死区半宽 ≈ 鲸鱼宽的 30%
      let wantMirror
      if (lastMirror === null || why !== lastWhy) {
        wantMirror = nearAndPaused ? (pageX > whaleCx) : (whaleCx < b.width / 2)
      } else {
        wantMirror = lastMirror
        if (nearAndPaused) {
          if (pageX > whaleCx + H) wantMirror = true
          else if (pageX < whaleCx - H) wantMirror = false
        } else {
          if (whaleCx < b.width / 2 - H) wantMirror = true
          else if (whaleCx > b.width / 2 + H) wantMirror = false
        }
      }
      if (wantMirror !== lastMirror || why !== lastWhy) {
        lastMirror = wantMirror
        lastWhy = why
        await w.webContents.executeJavaScript('window.__whaleSetLook ? window.__whaleSetLook(' + wantMirror + ') : null', true)
        log('look: ' + (wantMirror ? '镜像' : '正常') + ' 依据=' + why + ' 鼠标x=' + Math.round(pageX) + ' 鲸鱼x=' + Math.round(whaleCx) + ' 距离=' + Math.round(d))
      }

      if (!paused || !PN) {
        if (lastTarget !== -1) {
          await w.webContents.executeJavaScript('window.__whaleSetPauseTarget ? window.__whaleSetPauseTarget(-1) : -1', true)
          lastTarget = -1
          log('pause: 恢复播放帧')
        }
        return
      }

      const t = Math.max(0, Math.min(1, 1 - d / R))
      const target = t * (PN - 1)
      if (Math.abs(target - lastTarget) > 0.4) {
        await w.webContents.executeJavaScript('window.__whaleSetPauseTarget ? window.__whaleSetPauseTarget(' + target.toFixed(2) + ') : -1', true)
        lastTarget = target
        if (!startPauseSync._lastLog || Date.now() - startPauseSync._lastLog > 1500) {
          startPauseSync._lastLog = Date.now()
          let posTxt = '-'
          try {
            const pj = await w.webContents.executeJavaScript('window.__whalePausePos ? JSON.stringify(window.__whalePausePos()) : ""', true)
            const o = JSON.parse(pj || '{}')
            if (typeof o.pos === 'number') posTxt = o.pos.toFixed(1)
          } catch {}
          log('pause 目标=' + target.toFixed(1) + '/' + (PN - 1) + ' 实际=' + posTxt + ' 距离=' + Math.round(d) + 'px')
        }
      }
    } catch (e) {
      if (!startPauseSync._e || Date.now() - startPauseSync._e > 5000) { startPauseSync._e = Date.now(); log('pause sync err: ' + (e && e.message)) }
    }
  }, 120)
  log('朝向 + 暂停同步已启动（暂停帧 ' + PN + '）')
  return 'started'
}
