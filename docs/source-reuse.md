# 源码复用记录

## 诊断与测试工具

- `src/desktop/diagnostics.ts`、`diagnostic-runtime.ts`、`diagnostic-renderer.ts` 和 `native/StudyFlowWatchdog.cs` 为 StudyFlow 自有实现，没有新增复制 Super Productivity / ActivityWatch 源码。
- 诊断 ZIP 使用现有固定依赖 `fflate@0.8.3` 的 `zipSync` / `strToU8`，经 esbuild 捆绑到主进程。来源为现有 npm lockfile 对应包，未升级或新增依赖。
- 许可证实际检查：`node_modules/fflate/LICENSE` 为 MIT；构建时复制到随包 `resources/app/third-party/fflate-MIT-LICENSE.txt`。诊断模块本身不向网络发送数据。
- Windows 监测器使用 Windows .NET Framework 的 `System.Diagnostics`、文件操作与 `JavaScriptSerializer`；随包编译，不要求目标机安装开发 SDK。
- 验证入口：`tests/desktop-diagnostics.test.ts`、`tests/diagnostic-renderer.test.ts`、`scripts/verify-diagnostics.mjs` 和 `scripts/verify-watchdog.mjs`。测试包使用方法见[开发指南](features/09-development-and-verification.md#专属测试版)。

## Super Productivity

- 来源：https://github.com/super-productivity/super-productivity
- 本地源码版本：package.json 为 18.21.2（本地 master 目录，不假定等同于发行 tag）。
- 原路径：`src/app/util/get-time-left-for-task.ts`。
- 原文件 SHA-256：`9bb9aa9c4458fa7002075bcc0ba18c5188b3d993f652428e7a1003a54ba0a61f`。
- 本地路径：`src/desktop/vendor/task-time.ts`。
- 用途：UI 显示任务剩余预计时间，不小于零。
- 修改：只保留无子任务分支；使用 StudyFlow 的 estimateMinutes/spentMs，解除原 Task 模型依赖。
- 依赖：无第三方运行依赖。验证：desktop-store.test.ts 的已用时超过预计时间场景。
- MIT 声明：`third-party/super-productivity-LICENSE.txt`。
- 不复制 TaskService、NgRx、Angular、归档或云同步；独立任务持久化由 StudyFlow 实现。

## ActivityWatch window watcher

- 来源：https://github.com/ActivityWatch/aw-watcher-window
- 固定 commit：`abd69a6b6a56a80df3d9971ca152f84fc23e7340`。
- 原文件：https://github.com/ActivityWatch/aw-watcher-window/blob/abd69a6b6a56a80df3d9971ca152f84fc23e7340/aw_watcher_window/windows.py
- 本地原文：`third-party/activitywatch-windows.py.reference`；仅供来源审查，不执行。
- 改造源码：`native/WindowSampler.cs`，保留 MPL-2.0 文件头。
- 复用部分：前台窗口句柄 → PID → 进程路径 → 文件名的采集流程。
- 修改：Python/pywin32 移植为 C# P/Invoke；使用有限查询权限和 QueryFullProcessImageName；
  删除窗口标题读取、WMI fallback、调试输出；用固定 stdin/stdout 协议替代服务器和 heartbeat。
- 运行依赖：Windows user32/kernel32、Windows .NET Framework 4.x（本机已有）；不需要 Python 或开发 SDK。
- 协议（M3 扩展）：父进程写 `sample\n`，子进程返回 `{"app":"Code.exe","idleMs":0,"status":"ok"}` 或 `{"app":null,"idleMs":null,"status":"unknown"}`；EOF 退出。原 getCurrentApp 兼容接口仍仅返回 app。
- 客户端：`src/desktop/activity.ts`；4 秒超时、串行请求、输出长度与类型校验、关闭时清理。
- 验证：协议单测、实际 C# 编译、Windows 用户会话真实读出 `Code.exe`。
- 许可证：`third-party/activitywatch-LICENSE.txt`；commit 另存文本文件。
- 打包包含 MPL 许可、原参考文件、完整改造 C# 源码；构建方式为 Framework csc.exe，
  参见 scripts/build-desktop.mjs。未迁入 aw-client/aw-server/aw-qt，不调用 5600 端口。
- M3 新增的 AFK 读取由 StudyFlow 根据 Windows 官方 [GetLastInputInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo)、[LASTINPUTINFO](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-lastinputinfo) 和 [GetTickCount](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-gettickcount) 文档实现，未复制 aw-watcher-afk 源码。使用 GetTickCount64 的低 32 位与 dwTime 做无符号差值，处理 32 位回绕；超过 Int32.MaxValue 的歧义跨度作为 unknown。
- API 仅反映调用者的 Windows 会话，最后输入计数也不保证递增；不读取输入内容。轮询只能识别被采样观察到的 AFK 阈值，不能从最新一次输入推断两次采样间的所有输入事件。

## StudyFlow 自有复用

- 长专注与微休息（2026-09-10）：扩展自有 `src/timer/`、桌面生命周期/历史汇总及 `native/StudyFlowSound.cs`。没有复制第三方声音或上游源码，没有新增依赖、联网调用或许可条目；声音仍为自有 PCM 合成。验证入口为 `tests/long-focus.test.ts` 与 `scripts/verify-long-focus.mjs`。

- M4 XLSX：`src/import/xlsx-plan.ts` 复用已锁定的 `fflate@0.8.3`（MIT）解压 API 与 Chromium XML API，映射到现有 JSON 校验、预览和事务链路。未新增上游文件或应用依赖；已有构建步骤保留 fflate 许可。文件边界见[导入格式指南](m4-file-import-plan.md)，验证入口为 `tests/import-xlsx.test.ts` 与 `tests/desktop-import.test.ts`。

- `src/focus/focus-guard.ts`、`normalize-app.ts`：复用纯规则及既有测试。
- `src/desktop/focus.ts`：重新实现主进程 Session 管理，使用单调时钟，
  专门处理停止/重启迟到结果、长间隙、锁屏与注销；不修改原插件 FocusController。
- `src/desktop/contracts.ts`：独立端口和模型，不从旧宿主适配器导入领域接口。
- M3 主进程改用 `src/desktop/study.ts` + `src/timer/` + `src/activity/`；旧 DesktopFocus 保留为 M2 参考与回归测试，不再在主进程实例化。新模块自主实现，提醒复用 decideFocus 的精确白名单与 60 秒冷却规则。

## 构建平台依赖

Electron 44.3.0、@electron/packager 20.3.0 精确锁定；下载 ZIP 对照 Electron npm
包携带的 SHA-256 清单验证。最终包保留 Electron LICENSE 和 LICENSES.chromium.html。
SQLite 来自 Electron 内置 Node 24.20.0，实际 require/CRUD/重启均验证，无另装 native npm 模块。
依赖通过 npm 锁文件固定，更新前评估兼容性、许可证及回归结果。
