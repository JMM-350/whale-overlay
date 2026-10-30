<#
  restart-overlay.ps1 —— 本地调试用：干净重启置顶鲸鱼窗口

  为什么需要它：main.js 用 app.requestSingleInstanceLock()，强杀会留下锁，
  下一次启动会「静默退出」（exit 0、不写日志），很容易误判成代码坏了。
  宿主（DSH NEXT）自己启动时是干净的 userData，不受影响；这个脚本只是给手工调试用。
#>
param(
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [int]$WaitSeconds = 20
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $DshHome 'electron\electron.exe'
$log = Join-Path $DshHome 'logs\whale-overlay.log'

function Get-OverlayProcs {
    @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'main\.js' })
}

# 1) 收掉旧进程（等它们真的消失）
$old = Get-OverlayProcs
if ($old) {
    "  关闭旧实例: $(($old | ForEach-Object { $_.ProcessId }) -join ', ')"
    $old | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'media-helper\.ps1' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 400
    if (-not (Get-OverlayProcs)) { break }
}

# 2) 清锁
Get-ChildItem (Join-Path $env:APPDATA 'whale-overlay') -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^Singleton|lockfile$' } |
    ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }

# 3) 启动（必须剔除 ELECTRON_RUN_AS_NODE，否则 electron 会退化成 node）
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $exe
$psi.Arguments = 'main.js'
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE') | Out-Null
$psi.EnvironmentVariables['DSH_HOME'] = $DshHome
$psi.EnvironmentVariables['DSH_OVERLAY_STATE'] = (Join-Path $DshHome 'whale-overlay.json')
$proc = [System.Diagnostics.Process]::Start($psi)
"  新实例 pid $($proc.Id)"

# 4) 等日志里出现启动标记
$ok = $false
for ($i = 0; $i -lt $WaitSeconds * 2; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) { break }
    if (Test-Path $log) {
        $tail = Get-Content $log -Tail 15 -Encoding UTF8
        if ($tail -match 'helper start') { $ok = $true; break }
    }
}
if ($ok) { "  启动成功（日志已出现 helper start）" } else { "  !! 启动可能失败，检查 $log" }
Get-Content $log -Tail 6 -Encoding UTF8 | ForEach-Object { "    $_" }
