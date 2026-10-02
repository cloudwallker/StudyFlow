# 旧 Phase 0 插件原型

## 身份与用途

仓库保留一套运行在 Super Productivity 中的旧插件原型。它用于早期验证宿主 Plugin API、ActivityWatch REST 读取和 Focus Guard 链路，已经被独立桌面路线取代。

旧插件不是当前 StudyFlow 产品，也不参与独立桌面版的任务、SQLite、计时、历史或每日计划。运行旧插件需要 Super Productivity，并且前台应用读取需要 ActivityWatch 服务。

## 功能

- 检测宿主的 `getTasks`、`addTask`、`notify` 和 `showSnack` 能力。
- 读取任务数量，但界面不显示或记录任务标题。
- 用户点击后创建一个标题为 `[StudyFlow PoC] Plugin API probe` 的测试任务。
- 检查 ActivityWatch 是否可用，自动发现 Windows 窗口 bucket，并读取最新活动应用。
- 支持指定 ActivityWatch hostname，避免混用另一台机器的 bucket。
- 启动固定时长 Focus Guard，按白名单判断当前应用并通过宿主通知接口提醒。
- 显示采样次数、判断原因、通知调用次数和返回/失败状态等诊断信息。
- 页面卸载时取消请求、停止轮询并忽略迟到结果。

## ActivityWatch 读取规则

插件只访问本机 `http://localhost:5600` 的只读 bucket/event API。请求不携带凭据、不跟随重定向、不使用缓存，并设置超时和取消信号。它校验 JSON、bucket 类型、hostname、时间和事件新鲜度；没有可靠最新窗口时返回空或报兼容错误。

## 限制

- 依赖 Super Productivity 页面生命周期，离开插件页面会停止。
- 依赖 ActivityWatch localhost 服务，不是独立采集。
- 不持久化 hostname、白名单、会话或活动历史。
- `createProbeTask()` 只是验证写入，不是正式任务功能。
- 通知 API 返回成功不等于用户一定看见 Windows 通知。
- 不提供正计时、番茄钟、AFK 修正、SQLite、托盘、每日复盘或计划对比。

## 构建和历史资料

```powershell
npm run build
npm run verify:plugin
```

产物是 `dist/studyflow-phase0.zip`。Windows 操作验证见[旧插件验证指南](../windows-verification.md)。旧插件的构建或测试结果不能作为独立桌面版的验收结果。
