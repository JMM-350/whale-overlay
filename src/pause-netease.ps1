# pause-netease.ps1 —— 让网易云音乐停下来（隐藏鲸鱼时调用）
#   网易云是自绘界面，UIA 看不到按钮；WM_APPCOMMAND(APPCOMMAND_MEDIA_PLAY_PAUSE=14)
#   直接丢给它的窗口有效，但是"切换"语义，所以只发一次、由调用方决定要不要再发。
param([switch]$Force)

Add-Type -Namespace W -Name U -MemberDefinition @"
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
"@

$proc = Get-Process -Name cloudmusic -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { exit 0 }

[W.U]::SendMessage($proc.MainWindowHandle, 0x0319, [IntPtr]::Zero, [IntPtr](14 -shl 16)) | Out-Null
Start-Sleep -Milliseconds 400
exit 0