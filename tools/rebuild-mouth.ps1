# rebuild-mouth.ps1 —— 换视频后一键重建嘴部帧
# 用法: powershell -File rebuild-mouth.ps1 [-Video "新的.mp4"]
#   1) 用 Electron 把视频抽成 48 张 PNG（mouth-raw）
#   2) 用 Python 抠掉棋盘格灰底、缩到 320、存 WebP（mouth-frames）
#   3) 重启挂件让它加载新帧
param(
    [string]$Video = 'C:\Users\35023\.dsh\whale-overlay\mouth\mouth.mp4',
    [int]$Frames = 48
)

$ErrorActionPreference = 'Stop'
$here = 'C:\Users\35023\.dsh\whale-overlay'
$electron = 'C:\Users\35023\.dsh\electron\electron.exe'
$python = 'C:\Users\35023\AppData\Local\YouLabberLocal\harness\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'

if (-not (Test-Path $Video)) { throw "找不到视频: $Video" }

Write-Host "[1/3] 抽帧 $Frames 张 ..."
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$raw = Join-Path $here 'mouth-raw'
Remove-Item $raw -Recurse -Force -ErrorAction SilentlyContinue
$log = [System.Collections.ArrayList]::new()
& $electron (Join-Path $here 'extract-frames.js') $Video $raw $Frames | ForEach-Object { [void]$log.Add($_) }
$n = @(Get-ChildItem $raw -Filter 'frame-*.png' -ErrorAction SilentlyContinue).Count
Write-Host "      抽出 $n 张"
if ($n -lt 2) { throw "抽帧失败（$n 张）" }

Write-Host "[2/3] 抠图 + 缩放 + 存 WebP ..."
& $python (Join-Path $here 'build-mouth-frames.py')

Write-Host "[3/3] 重启挂件 ..."
Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $here 'restart-overlay.ps1') -WindowStyle Hidden
Start-Sleep -Seconds 12
Write-Host "完成。日志: C:\Users\35023\.dsh\logs\whale-overlay.log"
