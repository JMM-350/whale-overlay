# 小鲸鱼张嘴挂件 · Whale Overlay

给 [DSH / YouLabberLocal](https://github.com/) 桌面端加一只**透明置顶的小鲸鱼**：跟着电脑声音张合嘴，暂停时换成一段「大肥鱼」特写，鼠标越靠近特写越往后推进。

> 它是叠在 DSH 窗口上的一层独立透明窗口，不挡点击、不进任务栏、不抢焦点。
>
> 形象与素材来自网上开源资源，**欢迎二创**。

---

## 功能

| 功能 | 说明 |
|---|---|
| 🎵 音量驱动张嘴 | 48 张 WebP 帧，真实 WASAPI 峰值驱动，帧间交叉淡化 |
| ⏸️ 暂停特写 | 曲子暂停 → 换成暂停视频的 48 帧 |
| 🖱️ 鼠标距离选帧 | 鼠标离鲸鱼越近 → 暂停帧越靠后（目标帧 ∝ 距离，再限速缓动靠近，不会跳帧） |
| 🧭 朝向跟随 | 播放时看鲸鱼在屏幕左右半；暂停且鼠标靠近时看鼠标，中线留死区防抖 |
| 🫧 底部浮现 | 隐藏后重新显示（或隐藏时开始放歌）→ 沉到屏幕下沿外，停 1 秒，2.8 秒缓缓升起 |
| 👆 双击隐藏 | 双击鲸鱼本体即隐藏 |
| 🔇 隐藏即静音网易云 | 隐藏期间网易云被强制暂停（手动再播放也会在 15 秒内被按停） |
| 🎤 实时歌词 | 贴边显示当前歌词行 |
| ⌨️ 隐藏/显示 | `Ctrl+Alt+Shift+W`，或右键托盘图标 |

---

## 环境要求

- **Windows 10/11**
- **DSH（YouLabberLocal 桌面端）**：挂件加载的就是 DSH 的 Web GUI 页面
- **[dsh-whale-widget](https://github.com/) 插件**：鲸鱼本体（本仓库不含）。装法：在 DSH 里对 AI 说「帮我安装 dsh-whale-widget 插件」
- **Electron**：DSH 自带（`~/.dsh/electron/electron.exe`），首次启动 DSH 会自动下载
- **网易云音乐 PC 版**（当前版本只适配网易云）

---

## 安装

```powershell
git clone <本仓库地址>
cd whale-overlay
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本做三件事：

1. `src/` → `%USERPROFILE%\.dsh\whale-overlay\`（原目录存在会先备份）
2. `host/` → `%USERPROFILE%\.dsh\plugin-sources\whale-overlay-host\`
3. 把宿主插件注册进 profile 的 `cordis.patch.yml`（自动备份为 `.bak`），然后启动挂件

可选参数：

```powershell
.\install.ps1 -DshHome "D:\xxx\.dsh"   # 指定 DSH 数据目录
.\install.ps1 -NoStart                 # 装完不自动启动
.\install.ps1 -Force                   # 不备份，直接覆盖
```

**卸载**：删掉 `.dsh\whale-overlay` 和 `.dsh\plugin-sources\whale-overlay-host`，再从 `cordis.patch.yml` 里移除 `whale-overlay-host` 那三行，结束 `electron.exe` 即可。

---

## 使用

- **播放音乐**：鲸鱼跟着音量张嘴
- **暂停音乐 + 鼠标靠近鲸鱼**：换成大肥鱼特写，越贴近帧越靠后
- **双击鲸鱼**：隐藏（网易云同时被暂停）
- **`Ctrl+Alt+Shift+W` / 托盘**：隐藏 ↔ 显示；重新出现时从屏幕底部浮上来

日志：`%USERPROFILE%\.dsh\logs\whale-overlay.log`

---

## 目录结构

```
.
├─ install.ps1              安装脚本
├─ pack.ps1                 打包成单文件安装器（可选）
├─ src/                     运行时（整体复制到 ~/.dsh/whale-overlay）
│  ├─ main.js               主进程：窗口、注入、媒体同步、朝向、浮现、隐藏压制
│  ├─ mouth.js              注入页面的脚本：图层、张嘴、暂停帧、朝向、双击
│  ├─ media-helper.ps1      媒体状态采集（标题/播放/峰值/进度/歌词）→ JSON
│  ├─ audio-meter.ps1       WASAPI 峰值采样
│  ├─ preload.js            注入 window.__whaleAudio
│  ├─ pause-netease.ps1     让网易云暂停（WM_APPCOMMAND 投递）
│  ├─ restart-overlay.ps1   重启挂件
│  ├─ mouth-frames/         48 张张嘴帧（320×320 WebP，带透明通道）
│  └─ pause-frames/         48 张暂停特写帧
├─ host/                    宿主插件 whale-overlay-host（往 ~/.dsh 写带令牌的 URL）
└─ tools/                   自制素材脚本
   ├─ pause-frames-build.py     绿幕视频 → 48 帧暂停图
   ├─ fill-mouth-holes.py       给嘴巴帧补内部空洞（邻域取样/指定灰）
   ├─ fill-mouth-from-pause.py  用暂停帧同位置颜色补洞
   ├─ build-mouth-frames.py     早期抠帧脚本（保留参考）
   └─ rebuild-mouth.ps1         重新生成嘴巴帧
```

---

## 调参

都在 `src/` 里，改完重启挂件（`restart-overlay.ps1`）生效。

**朝向死区** — `main.js`

```js
const H = Math.max(28, boxCache.w * 0.30)   // 半宽，越大越不容易来回翻
```

**浮现节奏** — `main.js`

```js
if (wasHidden) floatIn(2800, 1000)   // floatIn(上升时长ms, 停顿时长ms)
```

**暂停帧缓动** — `mouth.js`

```js
const kp = 1 - Math.exp(-dt / 0.07)   // 越小越跟手
const maxStepP = 80 * dt              // 每秒最多走 80 帧
```

**隐藏压制的补偿窗口** — `main.js`

```js
const stuckLong = hiddenFired && Date.now() - hiddenPlaySince > 15000
```

---

## 自制素材

暂停帧来自一段绿幕视频，流程（需要 Python + `pip install av pillow numpy`）：

```powershell
python tools\pause-frames-build.py D:\fish.mp4 src\pause-frames
python tools\fill-mouth-from-pause.py          # 给嘴巴帧补洞（用暂停帧颜色）
python tools\fill-mouth-holes.py --gray 235    # 或用固定灰补洞
```

`fill-mouth-holes.py` 用「四边泛洪 + 连通块」区分背景与内部空洞，只填被包围的透明区，张嘴的开口不会误填。

---

## 已知限制

- **只适配网易云音乐**：它没有 SMTC 会话、自绘界面（UIA 看不到任何按钮），歌词只能按时间估算，暂停靠 `WM_APPCOMMAND` 投递
- **播放状态有 5–10 秒延迟**：媒体状态 JSON 的 `playing` 字段刷新慢，所以「隐藏压制」用 `peak>0 或进度在前进` 判断真实播放，且一次隐藏只发一次暂停指令（避免把暂停又点回播放）
- 网易云的播放/暂停是**切换**语义，没有确定的「暂停」指令
- 动画用 `setInterval` 而非 `requestAnimationFrame`：Chromium 会暂停被遮挡窗口的 rAF

---

## 许可

MIT，见 [LICENSE](LICENSE)。

本项目使用的小鲸鱼形象与帧素材（嘴巴帧、暂停帧）来自**网上的开源资源**，**欢迎二创** —— 随便改、随便用、随便再发布，本项目不对这些美术素材主张版权。如果其中有你的作品而你没打算公开，告诉我，我立刻加上署名或直接删掉。
