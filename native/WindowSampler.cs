// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
// Port of the foreground-window -> process -> basename flow in ActivityWatch:
// aw-watcher-window/aw_watcher_window/windows.py
// commit abd69a6b6a56a80df3d9971ca152f84fc23e7340.
// StudyFlow changes: C# P/Invoke, limited query rights, no title/WMI/REST,
// request-response over stdio. See docs/source-reuse.md.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class WindowSampler {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct LastInputInfo { public uint cbSize; public uint dwTime; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInputInfo info);
    [DllImport("kernel32.dll")] static extern ulong GetTickCount64();

    static long? IdleMilliseconds() {
        var info = new LastInputInfo(); info.cbSize = (uint)Marshal.SizeOf(typeof(LastInputInfo));
        if (!GetLastInputInfo(ref info)) return null;
        // LASTINPUTINFO uses the low 32 bits of the tick count. Unsigned subtraction
        // handles its rollover; ambiguous/future timestamps become unknown.
        uint elapsed = unchecked((uint)GetTickCount64() - info.dwTime);
        return elapsed <= Int32.MaxValue ? (long?)elapsed : null;
    }

    static string CurrentApp() {
        var window = GetForegroundWindow();
        if (window == IntPtr.Zero) return null;
        uint pid; GetWindowThreadProcessId(window, out pid);
        var process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero) return null;
        try {
            var path = new StringBuilder(32768); uint size = (uint)path.Capacity;
            if (!QueryFullProcessImageName(process, 0, path, ref size)) return null;
            return Path.GetFileName(path.ToString());
        } finally { CloseHandle(process); }
    }
    static int Main() {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        var serializer = new JavaScriptSerializer();
        // Parent closes stdin on exit; no autonomous polling or orphan lifetime.
        string line;
        while ((line = Console.ReadLine()) != null) {
            if (line != "sample") return 2;
            string app = null; long? idleMs = null;
            try { app = CurrentApp(); idleMs = IdleMilliseconds(); } catch { /* Unreadable sessions stay unknown. */ }
            bool known = app != null && idleMs.HasValue;
            Console.WriteLine(serializer.Serialize(new { app = known ? app : null, idleMs = known ? idleMs : null, status = known ? "ok" : "unknown" }));
            Console.Out.Flush();
        }
        return 0;
    }
}
