// StudyFlow diagnostic helper. Original implementation; no upstream source reuse.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

internal static class StudyFlowWatchdog {
    const long MaximumLogBytes = 1024 * 1024;
    static string logPath;
    static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();

    static bool HasCleanMarker(string donePath) {
        try {
            using (var marker = File.OpenRead(donePath)) {
                // Read a bounded, exact ASCII marker, never arbitrary file contents.
                foreach (char character in "clean") {
                    if (marker.ReadByte() != (int)character) return false;
                }
                return marker.ReadByte() == -1;
            }
        } catch {
            return false;
        }
    }

    static void Log(string name, string code, int? exitCode, bool? clean) {
        if (logPath == null) return;
        try {
            var record = new Dictionary<string, object>();
            record["timestamp"] = DateTime.UtcNow.ToString("o");
            record["event"] = name;
            if (code != null) record["code"] = code;
            if (name == "parent_exit") record["exitCode"] = exitCode;
            if (clean.HasValue) record["clean"] = clean.Value;
            string line = Serializer.Serialize(record) + "\n";
            if (File.Exists(logPath) && new FileInfo(logPath).Length + Encoding.UTF8.GetByteCount(line) > MaximumLogBytes) {
                string rotated = logPath + ".1";
                if (File.Exists(rotated)) File.Delete(rotated);
                File.Move(logPath, rotated);
            }
            File.AppendAllText(logPath, line, new UTF8Encoding(false));
        } catch {
            // Logging failures never reveal paths or exception messages and must
            // not prevent observing parent termination.
        }
    }

    static int Main(string[] args) {
        int parentId;
        Guid runId;
        if (args.Length != 3 || !Int32.TryParse(args[0], out parentId) || parentId <= 0 ||
            !Guid.TryParseExact(args[2], "D", out runId)) return 2;
        try {
            string directory = Path.GetFullPath(args[1]);
            Directory.CreateDirectory(directory);
            string prefix = Path.Combine(directory, runId.ToString("D"));
            logPath = prefix + ".watchdog.jsonl";
            string heartbeatPath = prefix + ".heartbeat";
            string donePath = prefix + ".done";
            using (Process parent = Process.GetProcessById(parentId)) {
                // Open and retain the process handle before querying start time.
                // All later exit checks use this process instance, never a reused PID.
                IntPtr retainedHandle = parent.Handle;
                parent.StartTime.ToUniversalTime();
                if (retainedHandle == IntPtr.Zero || parentId == Process.GetCurrentProcess().Id) return 2;
                Log("watchdog_start", null, null, null);
                var clock = Stopwatch.StartNew();
                long previousTick = clock.ElapsedMilliseconds;
                long lastHeartbeatObserved = previousTick;
                DateTime previousWall = DateTime.UtcNow;
                DateTime lastHeartbeat = File.GetLastWriteTimeUtc(heartbeatPath);
                bool stale = false;
                while (true) {
                    if (parent.WaitForExit(5000)) {
                        int? exitCode = null;
                        try { exitCode = parent.ExitCode; } catch { }
                        // A fresh UUID is assigned for each run. Its exact marker
                        // proves graceful shutdown independently of wall-clock changes.
                        bool clean = HasCleanMarker(donePath);
                        Log("parent_exit", null, exitCode, clean);
                        return 0;
                    }
                    long now = clock.ElapsedMilliseconds;
                    DateTime wall = DateTime.UtcNow;
                    double wallGap = (wall - previousWall).TotalMilliseconds;
                    bool gap = now - previousTick > 20000 || wallGap > 20000 || wallGap < 0;
                    previousTick = now;
                    previousWall = wall;
                    if (gap) {
                        Log("observation_gap", null, null, null);
                        // Sleep, scheduling stalls and clock jumps cannot prove a
                        // main-process hang. Require a fresh full observation window.
                        lastHeartbeatObserved = now;
                    }
                    DateTime heartbeat = File.GetLastWriteTimeUtc(heartbeatPath);
                    if (File.Exists(heartbeatPath) && heartbeat != lastHeartbeat) {
                        lastHeartbeat = heartbeat;
                        lastHeartbeatObserved = now;
                        if (stale) Log("heartbeat_recovered", null, null, null);
                        stale = false;
                    } else if (!gap && !stale && now - lastHeartbeatObserved > 30000) {
                        stale = true;
                        Log("heartbeat_stale", null, null, null);
                    }
                }
            }
        } catch (ArgumentException) {
            Log("watchdog_error", "parent_unavailable_or_invalid_input", null, null);
        } catch (System.ComponentModel.Win32Exception) {
            Log("watchdog_error", "process_access_failed", null, null);
        } catch (IOException) {
            Log("watchdog_error", "io_failed", null, null);
        } catch (UnauthorizedAccessException) {
            Log("watchdog_error", "access_denied", null, null);
        } catch {
            Log("watchdog_error", "monitor_failed", null, null);
        }
        // A monitor that cannot retain reliable parent state exits immediately.
        return 1;
    }
}
