const { contextBridge, ipcRenderer } = require('electron')

// 页面 → 主进程。
//   togglePlayback：点鲸鱼切换播放/暂停
//   nudgeLyric    ：拖动进度条后手动校正歌词（Shift+点 = 往后 5 秒，Alt+点 = 往前 5 秒）
//   ping          ：诊断用回执
contextBridge.exposeInMainWorld('__whaleOverlay', {
  togglePlayback: () => ipcRenderer.send('media:toggle'),
  nudgeLyric: (seconds) => ipcRenderer.send('media:nudge', Number(seconds) || 0),
  ping: (msg) => ipcRenderer.send('media:ping', String(msg || '')),
})

// 主进程 → 页面：系统音量（0..1），用来驱动鲸鱼张嘴
// 只在有订阅者时才转，避免每帧无谓的跨进程开销
const audioHandlers = new Set()
ipcRenderer.on('whale:audio', (_e, value) => {
  for (const h of audioHandlers) {
    try { h(Number(value) || 0) } catch {}
  }
})

contextBridge.exposeInMainWorld('__whaleAudio', {
  subscribe: (cb) => {
    if (typeof cb !== 'function') return () => {}
    audioHandlers.add(cb)
    return () => audioHandlers.delete(cb)
  },
})
