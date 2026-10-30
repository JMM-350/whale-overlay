# audio-meter.ps1 —— 高频采样「电脑当前音量」（默认输出设备的峰值）
# 输出：每行一个 0..1 的浮点数，约 33ms 一行，供小鲸鱼张嘴用
param([int]$Interval = 33, [int]$ParentPid = 0)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class WhalePeak {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class EnumComObj { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int f, int s, out IntPtr d);
        int GetDefaultAudioEndpoint(int f, int r, out IMMDevice d);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
        int OpenPropertyStore(int a, out IntPtr p);
        int GetId(out IntPtr s);
        int GetState(out int st);
    }

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioMeterInformation { int GetPeakValue(out float p); }

    public static float Peak() {
        try {
            var en = (IMMDeviceEnumerator)(new EnumComObj());
            IMMDevice dev;
            // 0 = eRender, 0 = eConsole
            if (en.GetDefaultAudioEndpoint(0, 0, out dev) != 0) return 0f;
            Guid iid = typeof(IAudioMeterInformation).GUID;
            object o;
            dev.Activate(ref iid, 1, IntPtr.Zero, out o);
            float p;
            ((IAudioMeterInformation)o).GetPeakValue(out p);
            Marshal.ReleaseComObject(o); Marshal.ReleaseComObject(dev); Marshal.ReleaseComObject(en);
            return p;
        } catch { return 0f; }
    }
}
'@ -ErrorAction SilentlyContinue

$stdout = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))
$stdout.AutoFlush = $true

while ($true) {
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
    $p = [WhalePeak]::Peak()
    if ($p -lt 0) { $p = 0 }
    if ($p -gt 1) { $p = 1 }
    $stdout.WriteLine($p.ToString('F4', [System.Globalization.CultureInfo]::InvariantCulture))
    Start-Sleep -Milliseconds $Interval
}