# 小鲸鱼张嘴挂件 · 安装
#
#   用法:
#     powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#
#   参数:
#     -DshHome "D:\xxx\.dsh"   指定 DSH 数据目录（默认 %USERPROFILE%\.dsh）
#     -NoStart                 安装完不自动启动
#     -Force                   已存在也直接覆盖（默认会先备份）
#
param(
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [switch]$NoStart,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
function Say($m) { Write-Host $m }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcDir  = Join-Path $here 'src'
$hostDir = Join-Path $here 'host'

Say ""
Say "======================================"
Say " 小鲸鱼张嘴挂件 · 安装"
Say "======================================"
Say "DSH 目录: $DshHome"

if (-not (Test-Path $DshHome)) {
    Say "[X] 找不到 DSH 数据目录：$DshHome"
    Say "    请先打开一次 DSH（YouLabberLocal），或用 -DshHome 指定正确路径。"
    exit 1
}
if (-not (Test-Path $srcDir)) {
    Say "[X] 缺 src 目录，请在仓库根目录运行本脚本。"
    exit 1
}

# ---------- 1. 复制挂件程序 ----------
$overlayDst = Join-Path $DshHome 'whale-overlay'
if ((Test-Path $overlayDst) -and -not $Force) {
    $bak = "$overlayDst-backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    Move-Item $overlayDst $bak
    Say "      已备份原目录 → $bak"
}
New-Item -ItemType Directory -Force -Path $overlayDst | Out-Null
Copy-Item (Join-Path $srcDir '*') $overlayDst -Recurse -Force
$mf = @(Get-ChildItem (Join-Path $overlayDst 'mouth-frames') -Filter *.webp -ErrorAction SilentlyContinue).Count
$pf = @(Get-ChildItem (Join-Path $overlayDst 'pause-frames') -Filter *.webp -ErrorAction SilentlyContinue).Count
Say "[1/4] 挂件程序 → $overlayDst（嘴巴帧 $mf 张 / 暂停帧 $pf 张）"

# ---------- 2. 复制宿主插件 ----------
$plugDst = Join-Path $DshHome 'plugin-sources\whale-overlay-host'
New-Item -ItemType Directory -Force -Path $plugDst | Out-Null
if (Test-Path $hostDir) {
    Copy-Item (Join-Path $hostDir '*') $plugDst -Recurse -Force
    Say "[2/4] 宿主插件 → $plugDst"
} else {
    Say "[!] 没有 host 目录，跳过宿主插件（挂件可能加载不出 DSH 页面）"
}

# ---------- 3. 注册到 profile ----------
$ymls = @()
$profiles = Join-Path $DshHome 'profiles'
if (Test-Path $profiles) {
    $ymls = @(Get-ChildItem $profiles -Directory | ForEach-Object { Join-Path $_.FullName 'cordis.patch.yml' } | Where-Object { Test-Path $_ })
}
if (-not $ymls.Count) {
    Say "[!] 没找到 cordis.patch.yml，跳过自动注册。请手动把下面这段加进 profile 的 patch 文件："
    Say "    - insert:"
    Say "        - id: whale-overlay-host"
    Say "          name: whale-overlay-host"
} else {
    foreach ($y in $ymls) {
        $txt = [IO.File]::ReadAllText($y, [Text.Encoding]::UTF8)
        if ($txt -match 'whale-overlay-host') { Say "      已注册过: $y"; continue }
        Copy-Item $y "$y.bak" -Force
        $block = "`r`n# 小鲸鱼置顶窗口（宿主侧辅助）`r`n- insert:`r`n    - id: whale-overlay-host`r`n      name: whale-overlay-host`r`n"
        [IO.File]::WriteAllText($y, $txt.TrimEnd() + "`r`n" + $block, (New-Object Text.UTF8Encoding($false)))
        Say "      已注册: $y（原文件备份为 .bak）"
    }
}
Say "[3/4] 注册完成"

# ---------- 4. 依赖检查 ----------
$ok = $true
$electron = Join-Path $DshHome 'electron\electron.exe'
if (-not (Test-Path $electron)) {
    Say "[!] 没找到 Electron：$electron"
    Say "    DSH 首次启动后会自动下载；如果一直没下载，请先正常打开一次 DSH。"
    $ok = $false
}
$widget = Join-Path $DshHome 'plugin-sources\dsh-whale-widget'
if (-not (Test-Path $widget)) {
    Say "[!] 没有鲸鱼本体插件 dsh-whale-widget（本仓库不含）。"
    Say "    装法: 在 DSH 里对 AI 说「帮我安装 dsh-whale-widget 插件」"
    $ok = $false
}
Say "[4/4] 依赖检查完毕"

if (-not $ok) {
    Say ""
    Say "以上 [ ! ] 项补齐后再启动即可（其它部分已经装好了）。"
}

if (-not $NoStart -and $ok) {
    Say ""
    Say "启动挂件 ..."
    $restart = Join-Path $overlayDst 'restart-overlay.ps1'
    Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$restart`"", '-DshHome', "`"$DshHome`"" -WindowStyle Hidden
    Start-Sleep -Seconds 10
    Say "已启动。日志：$(Join-Path $DshHome 'logs\whale-overlay.log')"
}

Say ""
Say "完成。"
Say "隐藏/显示：Ctrl+Alt+Shift+W，或右键托盘图标；双击鲸鱼也能隐藏。"
Say ""
