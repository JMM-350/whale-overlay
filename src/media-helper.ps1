<#
  media-helper.ps1 —— 给置顶窗口用的「正在播放 + 歌词」小助手

  为什么不用 SMTC：网易云客户端（你机器上这版）没注册系统媒体会话，
  GlobalSystemMediaTransportControlsSessionManager 返回 0 个会话。
  所以：
    · 歌名/歌手 → 读网易云主窗口标题（格式固定为 “歌名 - 歌手”）
    · 播放/暂停 → 发送全局媒体键 VK_MEDIA_PLAY_PAUSE
    · 是否在播 → 默认输出设备的音量峰值
    · 歌词     → 歌名+歌手查网易云公开接口（搜索 → LRC）
    · 播放进度 → 由 Node 侧读网易云本地 SQLite（historyTracks.playtime）后
                 通过命令文件发 anchor 过来；这里算 now - playtime - 暂停时长

  与 Node 侧的协议：
    stdout 每 400ms 一行 JSON：
      {"title":"","artist":"","playing":true,"peak":0.08,"line":"当前这句","pos":42.3,"posOk":true,"lyrN":38}
    命令文件（$CmdFile，内容一变就执行）：
      toggle            切换播放/暂停
      anchor <unix_ms>  这首歌的起播时刻，用来把进度对准
#>
param(
    [string]$CmdFile = (Join-Path $env:TEMP 'whale-media-cmd.txt'),
    [string]$ProcName = 'cloudmusic',
    [string]$StateFile = (Join-Path $env:TEMP 'whale-media-state.json')
)

$ErrorActionPreference = 'SilentlyContinue'

# stdout 必须强制 UTF-8：默认走控制台代码页（简体中文 = 936/GBK），
# Node 那边按 UTF-8 解码，中文就会变成乱码。绝不能省。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)), 4096)
$stdout.AutoFlush = $true

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class WhaleMediaKey {
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    public static void PlayPause() {
        keybd_event(0xB3, 0, 0x0001, UIntPtr.Zero);
        System.Threading.Thread.Sleep(40);
        keybd_event(0xB3, 0, 0x0003, UIntPtr.Zero);
    }
}

public class WhaleMeter {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class EnumComObj { }
    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator { int EnumAudioEndpoints(int f, int s, out IntPtr d); int GetDefaultAudioEndpoint(int f, int r, out IMMDevice d); }
    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); int OpenPropertyStore(int a, out IntPtr p); int GetId(out IntPtr s); int GetState(out int st); }
    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation { int GetPeakValue(out float p); }

    public static float Peak() {
        try {
            var en = (IMMDeviceEnumerator)(new EnumComObj());
            IMMDevice dev; en.GetDefaultAudioEndpoint(0, 0, out dev);
            Guid iid = typeof(IAudioMeterInformation).GUID;
            object o; dev.Activate(ref iid, 1, IntPtr.Zero, out o);
            float p; ((IAudioMeterInformation)o).GetPeakValue(out p);
            Marshal.ReleaseComObject(o); Marshal.ReleaseComObject(dev); Marshal.ReleaseComObject(en);
            return p;
        } catch { return 0f; }
    }
}
'@ -Language CSharp | Out-Null

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$HttpHeaders = @{
    'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
    'Referer'    = 'https://music.163.com/'
    'Cookie'     = 'NMTID=0; appver=8.9.70; os=pc'
}

function Get-Json([string]$url) {
    try {
        $r = Invoke-WebRequest $url -UseBasicParsing -Headers $HttpHeaders -TimeoutSec 8
        $text = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
        return ($text | ConvertFrom-Json)
    } catch { return $null }
}

# 歌名 + 歌手 → 歌词数组（每项 t=秒, text=这一行）。查不到返回空数组。
function Get-Lyrics([string]$title, [string]$artist) {
    $q = [uri]::EscapeDataString("$title $artist")
    $s = Get-Json "https://music.163.com/api/search/get/web?csrf_token=&s=$q&type=1&offset=0&limit=5"
    if (-not $s -or -not $s.result -or -not $s.result.songs) { return @() }
    $song = $s.result.songs | Where-Object { $_.name -eq $title } | Select-Object -First 1
    if (-not $song) { $song = $s.result.songs[0] }
    $l = Get-Json "https://music.163.com/api/song/lyric?id=$($song.id)&lv=1&kv=1&tv=-1"
    if (-not $l -or -not $l.lrc -or -not $l.lrc.lyric) { return @() }

    $out = New-Object System.Collections.ArrayList
    foreach ($ln in ($l.lrc.lyric -split "`n")) {
        $stamps = [regex]::Matches($ln, '\[(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)\]')
        if ($stamps.Count -eq 0) { continue }
        $txt = ($ln -replace '\[\d{1,3}:\d{1,2}(?:\.\d{1,3})?\]', '').Trim()
        if (-not $txt) { continue }
        if ($txt -match '^(作词|作曲|编曲|制作人|监制|混音|母带|吉他|贝斯|鼓|键盘|和声|录音|出品|发行|统筹|Lyricist|Composer|Arranger|Producer|Mixed|Mastered)\s*[:：]') { continue }
        foreach ($st in $stamps) {
            $sec = [int]$st.Groups[1].Value * 60 + [double]$st.Groups[2].Value
            [void]$out.Add([pscustomobject]@{ t = $sec; text = $txt })
        }
    }
    return @($out | Sort-Object t)
}
$ModeFile = Join-Path (Join-Path $env:USERPROFILE '.dsh') 'whale-overlay-mode.txt'
$PlayerMode = 'netease'   # auto / netease / kugou

# ── 状态 ─────────────────────────────────────────────
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$prevT = 0.0
$curKey = ''
$lyrics = @()
$pos = 0.0
$lastLoudMs = 0
$cache = @{}
# 进度优先用 anchor（Node 读网易云 SQLite 得到的起播时刻）算；
# 没有 anchor 才退回自己累加，而且只在「看着它从头开始播」时才算可信。
$posKnown = $true
$firstTick = $true
$anchorMs = 0
$silentFor = 0.0
$pausedAcc = 0.0

$lastCmd = ''
if (Test-Path $CmdFile) {
    $lastCmd = [string](Get-Content $CmdFile -Raw)
    # 命令文件里残留的 anchor 立刻用上；残留的 toggle 不重放，免得凭空暂停一下
    if ($lastCmd -match 'anchor\s+(\d{10,16})') {
        $anchorMs = [long]$matches[1]
        $posKnown = $true
        $pausedAcc = 0.0
    }
}

# ── 主循环 ───────────────────────────────────────────
while ($true) {
    # 模式由托盘切换：auto 自动 / netease 只认网易云 / kugou 只认酷狗
    try {
        if (Test-Path $ModeFile) {
            $m = ([string](Get-Content $ModeFile -Raw)).Trim().TrimStart([char]0xFEFF).ToLower()
            if ($m -in @('auto', 'netease', 'kugou')) { $PlayerMode = $m }
        }
    } catch { }

    $title = ''
    $artist = ''
    $allProcs = @(Get-Process -Name $ProcName -ErrorAction SilentlyContinue)
    $alive = $allProcs.Count -gt 0
    $proc = $allProcs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($PlayerMode -eq 'kugou') { $proc = $null }   # 酷狗模式不读网易云窗口标题
    if ($proc) {
        $raw = [string]$proc.MainWindowTitle
        if ($raw -and $raw -notmatch '^网易云音乐$') {
            if ($raw -match '^(?<s>.+)\s+-\s+(?<a>[^-]+)$') {
                $title = $matches['s'].Trim()
                $artist = $matches['a'].Trim()
            } else {
                $title = $raw.Trim()
            }
        }
    }

    # ── 酷狗（或任何报给 Windows 的播放器）：SMTC 直接给歌名和进度，比窗口标题准
    $smtc = $null
    $kugouActive = $false
    try {
        if ($PlayerMode -eq 'kugou') { $smtc = Get-SmtcState 'KuGou|kugou' }
        elseif ($PlayerMode -eq 'netease') { $smtc = $null }
        else { $smtc = Get-SmtcState }
    } catch { $smtc = $null }
    if ($smtc -and $smtc.title) {
        $isKugou = ($smtc.app -match 'KuGou|kugou')
        # 酷狗模式：只要系统报了酷狗就用它（暂停时也显示这首歌）
        # 自动模式：酷狗在放，或者网易云那边根本没歌
        if ($isKugou -and ($PlayerMode -eq 'kugou' -or $smtc.playing -or -not $title)) {
            $kugouActive = $true
            $title = $smtc.title
            $artist = $smtc.artist
        }
    }

    $key = "$title|$artist"
    $isFirstTick = $firstTick
    if ($firstTick) {
        $firstTick = $false
        if ($title -and $anchorMs -eq 0) { $posKnown = $false }   # 半截插入且没有锚点
    }
    if ($key -ne $curKey) {
        $curKey = $key
        $pos = 0.0
        $lastLoudMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $lyrics = @()
        if ($title -and -not $isFirstTick) { $posKnown = $true }
        if ($title) {
            if ($cache.ContainsKey($key)) {
                $lyrics = $cache[$key]
            } else {
                # 酷狗优先用酷狗自己的词（时间轴最准），取不到再退回网易云接口
                if ($kugouActive) { $lyrics = @(Get-LyricsKugou $title $artist) }
                if (-not $lyrics -or @($lyrics).Count -eq 0) { $lyrics = @(Get-Lyrics $title $artist) }
                if ($cache.Count -gt 30) { $cache.Clear() }
                $cache[$key] = $lyrics
            }
        }
    }

    $peak = [WhaleMeter]::Peak()
    if ($peak -gt 0.0008) { $lastLoudMs = $nowMs }
    # 安静段落（音量低于阈值）不要马上判成暂停，给 3 秒宽限，否则歌词下面会一直闪"已暂停"
    $loud = ($peak -gt 0.0008) -or (($nowMs - $lastLoudMs) -lt 3000)
    $playing = $loud -and [bool]$title

    $nowT = $sw.Elapsed.TotalSeconds
    $dt = $nowT - $prevT
    $prevT = $nowT

    # 短暂静音（前奏/间奏/淡出）不算暂停，连续安静超过 2 秒才累计“暂停时长”
    if ($playing) {
        $silentFor = 0
    } elseif ($dt -gt 0 -and $dt -lt 3) {
        $silentFor += $dt
    }
    if ($silentFor -gt 2) { $pausedAcc += $dt }

    if ($anchorMs -gt 0) {
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $pos = [Math]::Max(0.0, ($nowMs - $anchorMs) / 1000.0 - $pausedAcc)
    } elseif ($playing -and $dt -gt 0 -and $dt -lt 3) {
        $pos += $dt
    }

    # 酷狗：进度和播放状态直接用系统报的，不用自己累加，也不受拖进度条影响
    if ($kugouActive) {
        if ($smtc.playing) {
            $pos = [double]$smtc.pos
            $posKnown = $true
        }
        $playing = [bool]$smtc.playing -and [bool]$title
        $alive = $true
    }

    $line = ''
    if ($posKnown) {
        foreach ($e in $lyrics) {
            if ($e.t -le ($pos + 0.2)) { $line = $e.text } else { break }
        }
    }

    $obj = [ordered]@{
        title   = $title
        artist  = $artist
        playing = $playing
        peak    = [math]::Round([double]$peak, 4)
        line    = $line
        pos     = [math]::Round($pos, 1)
        posOk   = $posKnown
        lyrN    = @($lyrics).Count
        alive   = $alive
    }
    $json = ($obj | ConvertTo-Json -Compress)
    $stdout.WriteLine($json)
    $stdout.Flush()
    # 文件握手：Electron 这边的 stdout 管道实测收不到数据，所以每轮再落一份状态文件
    try {
        $tmp = $StateFile + '.tmp'
        [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination $StateFile -Force -ErrorAction SilentlyContinue
    } catch { }

    if (Test-Path $CmdFile) {
        $c = [string](Get-Content $CmdFile -Raw -ErrorAction SilentlyContinue)
        if ($c -and $c -ne $lastCmd) {
            $lastCmd = $c
            if ($c -match 'toggle') {
                # 酷狗走 SMTC 精确指令；其它保持原来的系统媒体键
                if ($kugouActive -or $PlayerMode -eq 'kugou') {
                    if (-not (Invoke-SmtcToggle 'KuGou|kugou')) { [WhaleMediaKey]::PlayPause() }
                } else {
                    [WhaleMediaKey]::PlayPause()
                }
            }
            if ($c -match 'anchor\s+(\d{10,16})') {
                $anchorMs = [long]$matches[1]
                $pausedAcc = 0.0
                $posKnown = $true
            }
            # 手动校正：拖动进度条后客户端不会更新 playtime，歌词就偏了。
            # 用户按 Shift+点（+5s）/ Alt+点（-5s），这里把锚点跟着挪。
            if ($c -match 'nudge\s+(-?\d+)') {
                $d = [long]$matches[1]
                if ($anchorMs -gt 0) { $anchorMs -= ($d * 1000) } else { $pos = [Math]::Max(0.0, $pos + $d) }
                $posKnown = $true
            }
        }
    }

    Start-Sleep -Milliseconds 400
}