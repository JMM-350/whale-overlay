# 打包成单文件安装器（把 src/、host/、install.ps1 塞进一个 .ps1）
#
#   用法: powershell -NoProfile -ExecutionPolicy Bypass -File .\pack.ps1
#   输出: 小鲸鱼挂件-一键安装.ps1（同目录）
#
#   原理: 压缩 → base64 → 内嵌到引导脚本里，运行时解到临时目录再执行 install.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out  = Join-Path $here '小鲸鱼挂件-一键安装.ps1'

$tmp = Join-Path $env:TEMP ('whale-pack-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Copy-Item (Join-Path $here 'src')         (Join-Path $tmp 'src')  -Recurse -Force
Copy-Item (Join-Path $here 'host')        (Join-Path $tmp 'host') -Recurse -Force
Copy-Item (Join-Path $here 'install.ps1') (Join-Path $tmp 'install.ps1') -Force
Copy-Item (Join-Path $here 'README.md')   (Join-Path $tmp 'README.md')   -Force

$zip = Join-Path $tmp 'payload.zip'
Compress-Archive -Path (Join-Path $tmp 'src'), (Join-Path $tmp 'host'), (Join-Path $tmp 'install.ps1'), (Join-Path $tmp 'README.md') `
                 -DestinationPath $zip -CompressionLevel Optimal
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($zip))
Remove-Item $tmp -Recurse -Force

$boot = @"
<#
  小鲸鱼张嘴挂件 · 一键安装（自解压单文件）
  ---------------------------------------------------------------
  前置：DSH（YouLabberLocal）桌面端 + 鲸鱼本体插件 dsh-whale-widget
  用法（任选一种）：
    1) 右键本文件 → 「使用 PowerShell 运行」
    2) powershell -NoProfile -ExecutionPolicy Bypass -File "本文件路径"

  参数：
    -DshHome "D:\xxx\.dsh"   指定 DSH 数据目录（默认 %USERPROFILE%\.dsh）
    -NoStart                 装完不自动启动
    -Force                   已存在也直接覆盖
#>
param(
    [string]`$DshHome = (Join-Path `$env:USERPROFILE '.dsh'),
    [switch]`$NoStart,
    [switch]`$Force
)

`$ErrorActionPreference = 'Stop'
`$work = Join-Path `$env:TEMP ('whale-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path `$work | Out-Null
Write-Host '解包中 ...'
`$zip = Join-Path `$work 'payload.zip'
[IO.File]::WriteAllBytes(`$zip, [Convert]::FromBase64String('$b64'))
Expand-Archive -Path `$zip -DestinationPath `$work -Force

`$extra = @()
if (`$NoStart) { `$extra += '-NoStart' }
if (`$Force)   { `$extra += '-Force' }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path `$work 'install.ps1') -DshHome `$DshHome @extra
`$code = `$LASTEXITCODE

Remove-Item `$work -Recurse -Force -ErrorAction SilentlyContinue
exit `$code
"@

[IO.File]::WriteAllText($out, $boot, (New-Object Text.UTF8Encoding($true)))
Write-Host "已生成: $out（$([math]::Round((Get-Item $out).Length/1KB,0)) KB）"
