// mouth.js —— 让小鲸鱼的嘴跟着电脑音量张合
//
// 结构：
//   1) 主进程 spawn audio-meter.ps1，每 ~33ms 拿一次系统峰值（0..1）；
//   2) 帧早就离线抠好、缩小、存成 mouth-frames/f00.webp …（build-mouth-frames.py 生成）；
//   3) 注入页面的是「两张 <img> 叠着放」，按音量换 src + 上一层调透明度做交叉淡化。
//
// 不用 <video> 也不碰时间轴，所以不存在“跳帧”；位置由单独的定时器维护，
// 不会因为某一帧取不到鲸鱼矩形就把自己藏起来。

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const HERE = __dirname
const METER = path.join(HERE, 'audio-meter.ps1')
const FRAME_DIR = path.join(HERE, 'mouth-frames')

let meter = null

function startAudioMeter(log, onValue) {
  const launch = () => {
    try {
      if (!fs.existsSync(METER)) { log('audio meter missing'); return }
      meter = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', METER, '-ParentPid', String(process.pid)],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      let buf = ''
      let lastSent = 0
      meter.stdout.setEncoding('utf8')
      meter.stdout.on('data', (chunk) => {
        buf += chunk
        let i
        let last = -1
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          const v = parseFloat(line)
          if (Number.isFinite(v)) last = v
        }
        if (last < 0) return
        const now = Date.now()
        if (now - lastSent < 50) return      // 最多 20 次/秒，别刷爆 IPC
        lastSent = now
        try { onValue(last) } catch {}
      })
      meter.on('exit', (code) => {
        meter = null
        log('audio meter exited', String(code), '- restart in 3s')
        setTimeout(launch, 3000)
      })
      meter.on('error', (e) => log('audio meter error', e.message))
      log('audio meter started pid=' + meter.pid)
    } catch (e) {
      log('audio meter launch failed', e.message)
    }
  }
  launch()
}

function stopAudioMeter() {
  try { if (meter) { meter.kill(); meter = null } } catch {}
}

// 页面侧脚本：按音量切换两张叠放的图片
const MOUTH_JS = `(() => {
  window.__whaleMouthInit = async (urls, pauseUrls) => {
    try {
      if (window.__whaleMouthReady) return 'ready'
      const N = urls.length
      const PN = (pauseUrls || []).length
      if (!N) return 'no-frames'

      // 全部预加载，之后切换只改 src，不重新解码
      await Promise.all(urls.map((u) => new Promise((res) => {
        const im = new Image()
        im.onload = res
        im.onerror = res
        im.src = u
      })))

      if (PN) {
        await Promise.all(pauseUrls.map((u) => new Promise((res) => {
          const im = new Image()
          im.onload = res
          im.onerror = res
          im.src = u
        })))
      }

      const host = document.createElement('div')
      host.id = 'dshwv-mouth'
      // 必须带 dshwv 类名，否则会被挂件的 HIDE_CSS（body > *:not([class*="dshwv"])）透明掉
      host.className = 'dshwv-mouth'
      host.style.cssText = 'position:fixed;left:0;top:0;width:190px;height:190px;' +
        'pointer-events:none;z-index:2147483000;opacity:1;transform:translate(-9999px,0);'
      const mk = (z) => {
        const im = document.createElement('img')
        im.src = urls[0]
        im.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;' +
          'z-index:' + z + ';pointer-events:none;'
        return im
      }
      const imgA = mk(1)      // 当前帧
      const imgB = mk(2)      // 下一帧，靠透明度交叉淡化
      imgB.style.opacity = '0'
      host.appendChild(imgA)
      host.appendChild(imgB)
      document.body.appendChild(host)

      // ── 位置维护：逐帧跟随（拖动时才跟得上），300ms 定时器只做兜底
      let lastBox = null
      let wroteX = null
      let wroteY = null
      let wroteW = null
      let floatY = 0          // 浮现动画的纵向偏移
      let floatHide = false   // true 时整层不显示（浮现前先藏起来，避免闪一下）
      let lookLeft = false    // 鼠标在鲸鱼左边 → 朝左（镜像）
      let mirrorOn = false
      let hidStage = false
      const place = () => {
        let root = null
        let big = 0
        for (const el of document.querySelectorAll('.dshwv-root')) {
          const r = el.getBoundingClientRect()
          if (r.width > big) { big = r.width; root = el }
        }
        if (root) {
          // 只藏鲸鱼本体那一个 <img class="dshwv-img">。
          // 菜单 .dshwv-menu（里面有大小滑块）必须留着，否则点了像没反应、也调不了大小。
          const stage = root.querySelector('.dshwv-img')
          const target = stage || root
          const r = target.getBoundingClientRect()
          if (r.width > 4) lastBox = { x: r.left, y: r.top, w: r.width, h: r.height }
          if (stage && !hidStage) { stage.style.opacity = '0'; hidStage = true }
          else if (stage && stage.style.opacity !== '0') stage.style.opacity = '0'
        }
        if (lastBox) {
          // 到了屏幕另一半就镜像翻转
          const wantMirror = lookLeft   // 朝向由鼠标位置决定，主进程下发
          if (wantMirror !== mirrorOn) { mirrorOn = wantMirror; wroteX = null }
          // 只在真的变了才写样式，避免每帧都碰 DOM（首次必须写，null 表示还没写过）
          if (wroteX === null || Math.abs(lastBox.x - wroteX) > 0.4 || Math.abs(lastBox.y + floatY - wroteY) > 0.4) {
            host.style.transform = 'translate(' + lastBox.x + 'px,' + (lastBox.y + floatY) + 'px)' + (mirrorOn ? ' scaleX(-1)' : '')
            wroteX = lastBox.x
            wroteY = lastBox.y + floatY
          }
          if (wroteW === null || Math.abs(lastBox.w - wroteW) > 0.4) {
            host.style.width = lastBox.w + 'px'
            host.style.height = lastBox.h + 'px'
            wroteW = lastBox.w
          }
          if (floatHide) { if (host.style.opacity !== '0') host.style.opacity = '0' }
          else if (host.style.opacity !== '1') host.style.opacity = '1'
        }
      }
      place()
      setInterval(place, 300)

      // ── 嘴：音量 → 帧序号（指数缓动 + 速度上限，永不跳变）
      let raw = 0
      let subOk = 'no-api'
      try {
        if (window.__whaleAudio && window.__whaleAudio.subscribe) {
          window.__whaleAudio.subscribe((v) => { raw = v })
          subOk = 'subscribed'
        }
      } catch (e) { subOk = 'ERR ' + (e && e.message) }

      let pos = 0
      let peakRef = 0.02
      let last = performance.now()
      let pauseTarget = -1   // 目标帧（浮点），由鼠标距离决定
      let pausePos = -1      // 实际帧（浮点），限速逼近
      let pA = -1, pB = -1
      let shownA = -1
      let shownB = -1

      const tick = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000)
        last = now
        place()   // 逐帧跟随鲸鱼位置，拖动时才不卡

        if (pauseTarget >= 0 && PN) {
          if (pausePos < 0) pausePos = pauseTarget
          const kp = 1 - Math.exp(-dt / 0.07)
          let np = pausePos + (pauseTarget - pausePos) * kp
          const maxStepP = 80 * dt
          if (np - pausePos > maxStepP) np = pausePos + maxStepP
          if (pausePos - np > maxStepP) np = pausePos - maxStepP
          pausePos = Math.max(0, Math.min(PN - 1, np))
          const pi0 = Math.floor(pausePos)
          const pi1 = Math.min(PN - 1, pi0 + 1)
          const pf = Math.max(0, Math.min(1, pausePos - pi0))
          if (pi0 !== pA) { imgA.src = pauseUrls[pi0]; pA = pi0 }
          if (pi1 !== pB) { imgB.src = pauseUrls[pi1]; pB = pi1 }
          imgB.style.opacity = String(pf)
          requestAnimationFrame(tick)
          return
        }
        peakRef = Math.max(raw, peakRef * Math.pow(0.5, dt / 1.5), 0.02)
        const norm = Math.min(1, raw / (peakRef * 0.8))
        let amp = Math.min(1, Math.max(0, (norm - 0.3) / 0.7))
        amp = Math.pow(amp, 0.8)
        const target = amp * (N - 1)

        const k = 1 - Math.exp(-dt / 0.085)
        let next = pos + (target - pos) * k
        const maxStep = 28 * dt
        if (next - pos > maxStep) next = pos + maxStep
        if (pos - next > maxStep) next = pos - maxStep
        pos = Math.max(0, Math.min(N - 1, next))

        const i0 = Math.floor(pos)
        const i1 = Math.min(N - 1, i0 + 1)
        const frac = Math.max(0, Math.min(1, pos - i0))
        if (i0 !== shownA) { imgA.src = urls[i0]; shownA = i0 }
        if (i1 !== shownB) { imgB.src = urls[i1]; shownB = i1 }
        imgB.style.opacity = String(frac)
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)

      // 从屏幕底外浮上来
      // 显示窗口之前调用：把鲸鱼藏起来并沉到屏幕下沿外（此时窗口还不可见，所以不会闪）
      window.__whalePrepareShow = () => {
        const startY = lastBox ? lastBox.y : 0
        const wh = lastBox ? (lastBox.h || lastBox.w) : 0
        floatHide = true
        floatY = Math.max(240, window.innerHeight - startY + wh + 8)
        wroteX = null
        for (const el of document.querySelectorAll('.dshwv-img')) el.style.opacity = '0'
        const h = document.querySelector('.dshwv-mouth-host')
        if (h) h.style.opacity = '0'
        return Math.round(floatY)
      }

      window.__whaleFloatIn = (ms, delay) => {
        const dur = Math.max(400, Number(ms) || 2800)
        const wait = Math.max(0, Number(delay) || 0)
        const startY = lastBox ? lastBox.y : 0
        const wh = lastBox ? (lastBox.h || lastBox.w) : 0
        const from = Math.max(240, window.innerHeight - startY + wh + 8)   // 整条鱼沉到屏幕下沿外
        // 立刻藏起来 + 沉到屏幕外：这两个动作在同一帧完成，所以看不到中间态
        floatHide = true
        floatY = from
        wroteX = null
        for (const el of document.querySelectorAll('.dshwv-img')) el.style.opacity = '0'
        const hostEl = document.querySelector('.dshwv-mouth-host')
        if (hostEl) hostEl.style.opacity = '0'
        const t0 = performance.now() + wait
        const step = () => {
          if (performance.now() < t0) { requestAnimationFrame(step); return }
          if (floatHide) floatHide = false    // 停顿结束才开始显示（同时开始上升）
          const t = Math.min(1, (performance.now() - t0) / dur)
          const e = 1 - Math.pow(1 - t, 3)       // easeOutCubic：起步快、落位慢
          floatY = from * (1 - e)
          wroteX = null
          if (t < 1) requestAnimationFrame(step)
          else { floatY = 0; wroteX = null }
        }
        requestAnimationFrame(step)
        return Math.round(from)
      }
      // 双击鲸鱼 → 记一个时间戳，主进程轮询取走（页面里拿不到 electron 模块）
      let dblAt = 0
      window.addEventListener('dblclick', (e) => {
        if (!lastBox) return
        const x0 = lastBox.x, y0 = lastBox.y + floatY
        const x1 = x0 + lastBox.w, y1 = y0 + (lastBox.h || lastBox.w)
        if (e.clientX >= x0 - 4 && e.clientX <= x1 + 4 && e.clientY >= y0 - 4 && e.clientY <= y1 + 4) {
          dblAt = Date.now()
        }
      }, true)
      window.__whaleTakeDbl = () => { const t = dblAt; dblAt = 0; return t }
      window.__whaleSimulateDbl = () => {
        if (!lastBox) return 0
        const el = document.querySelector('.dshwv-mouth-host') || document.body
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: lastBox.x + lastBox.w / 2, clientY: lastBox.y + (lastBox.h || lastBox.w) / 2 }))
        return dblAt
      }
      window.__whaleSetLook = (left) => {
        const v = !!left
        if (v !== lookLeft) { lookLeft = v; wroteX = null }
        return lookLeft
      }
      window.__whaleSetPauseTarget = (v) => {
        if (!PN) return -1
        const n = Number(v)
        if (!(n >= 0)) {
          pauseTarget = -1
          pausePos = -1
          pA = -1; pB = -1
          shownA = -1; shownB = -1
          return -1
        }
        pauseTarget = Math.max(0, Math.min(PN - 1, n))
        if (pausePos < 0) pausePos = pauseTarget
        return pauseTarget
      }
      window.__whaleSetPause = (n) => window.__whaleSetPauseTarget(n)
      window.__whalePausePos = () => ({ target: pauseTarget, pos: pausePos, A: pA, B: pB, frames: PN })

      window.__whaleMouthSetEnabled = (on) => {
        if (on) { host.style.visibility = 'visible'; return 'on' }
        host.style.visibility = 'hidden'
        return 'off'
      }
      window.__whaleMouthStats = () => ({
        pos: Number(pos.toFixed(2)),
        raw: Number(raw.toFixed(4)),
        peak: Number(peakRef.toFixed(4)),
        frames: N,
        sub: subOk,
        box: lastBox ? Math.round(lastBox.x) + ',' + Math.round(lastBox.y) + ',' + Math.round(lastBox.w) : 'none',
        shown: shownA + '->' + shownB,
        hostOp: getComputedStyle(host).opacity,
        srcLen: imgA.src.length,
        mirror: mirrorOn,
        floatY: Math.round(floatY),
        lookLeft: lookLeft,
      })
      window.__whaleMouthReady = true
      return 'ready:' + N + 'f'
    } catch (e) {
      return 'ERR ' + (e && e.message)
    }
  }
  return 'mouth-script-installed'
})()`

async function injectMouth(win, log) {
  try {
    if (!win || win.isDestroyed()) return
    if (!fs.existsSync(FRAME_DIR)) { log('mouth frames missing', FRAME_DIR); return }
    const files = fs.readdirSync(FRAME_DIR).filter((f) => f.endsWith('.webp')).sort()
    if (!files.length) { log('mouth frames empty'); return }
    const urls = files.map((f) => 'data:image/webp;base64,' + fs.readFileSync(path.join(FRAME_DIR, f)).toString('base64'))
    const PAUSE_DIR = path.join(HERE, 'pause-frames')
    let pauseUrls = []
    if (fs.existsSync(PAUSE_DIR)) {
      const pf = fs.readdirSync(PAUSE_DIR).filter((f) => f.endsWith('.webp')).sort()
      pauseUrls = pf.map((f) => 'data:image/webp;base64,' + fs.readFileSync(path.join(PAUSE_DIR, f)).toString('base64'))
    }

    await win.webContents.executeJavaScript(MOUTH_JS, true)
    const res = await win.webContents.executeJavaScript(`window.__whaleMouthInit(${JSON.stringify(urls)}, ${JSON.stringify(pauseUrls)})`, true)
    log('mouth init: ' + res + ' (' + files.length + ' 帧 + 暂停 ' + pauseUrls.length + ' 帧)')

    setTimeout(async () => {
      try {
        if (!win || win.isDestroyed()) return
        for (let i = 0; i < 3; i++) {
          const st = await win.webContents.executeJavaScript(
            'window.__whaleMouthStats ? JSON.stringify(window.__whaleMouthStats()) : "no-stats"', true)
          log('mouth stats ' + st)
          await new Promise((r) => setTimeout(r, 800))
        }
      } catch (e) {
        log('mouth stats failed ' + e.message)
      }
    }, 8000)
  } catch (e) {
    log('mouth inject failed', e.message)
  }
}

module.exports = { startAudioMeter, stopAudioMeter, injectMouth }
