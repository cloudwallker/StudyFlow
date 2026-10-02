# 旧插件 Windows 验证指南

本指南适用于仓库保留的 Super Productivity / ActivityWatch 插件原型，不验证独立桌面版。使用虚构任务，单独记录目标机器的软件版本和各步骤结果；构建成功不代表系统通知实际可见。

## 操作步骤

1. 在 Windows 构建插件，取得完整的 `dist/studyflow-phase0.zip`；运行 `npm run verify:plugin` 检查插件包。
2. 启动 ActivityWatch，打开 `http://127.0.0.1:5600` 确认可用及 window watcher 正在采集，不导出真实历史。
3. Super Productivity → Settings → Plugins → Choose Plugin File / Upload Plugin，选择 ZIP，开启插件并打开 StudyFlow Phase 0 菜单。
4. 点击 **Check API**，检查 API 能力与任务数量。使用虚构任务库，点击 **Create Probe Task** 一次，确认只新增一个 `[StudyFlow PoC] Plugin API probe`；测试结束后可在宿主中删除。
5. 点击 **Check ActivityWatch**，检查最近应用和状态。存在多机器候选时，在 Hostname 中输入目标 Windows 机器的 hostname。
6. 根据实测 app 字段填写白名单，每行一个完整应用名；切换到允许的程序再返回插件检查。
7. 点击 **Start 10-min Focus Test**。保持 StudyFlow 视图打开，白名单程序不应提醒；白名单外的记事本或计算器应收到应用名与剩余时间通知。
8. 在同一非白名单应用停留，60 秒内不应重复提醒，60 秒后可再次提醒。回到白名单再离开不重置全局冷却。
9. 点击 **Stop**，随后不应产生新通知；已交给 Windows 的通知无法撤回。重新开始创建新会话，自然运行 10 分钟后停止。
10. 运行中关闭 ActivityWatch，应显示不可用且不崩溃、不刷日志；重启 ActivityWatch 后可恢复采样。
11. 运行中禁用插件并等待超过 60 秒，不应继续轮询或通知。在开发者工具中只检查请求方法和频率，不导出含窗口标题的响应。
12. 离开 StudyFlow 视图会销毁 iframe 并结束会话，重新打开时应保持停止。旧插件不支持跨宿主页面持续后台监测。

## 失败时记录必要证据

记录失败步骤、宿主版本、HTTP 状态、CORS/CSP 错误类别，以及通知权限或勿扰模式。不要复制真实任务、窗口标题、URL、文件路径或完整 ActivityWatch 响应。

Direct HTTP 失败时保留错误类别与复现步骤，不能为了验证临时开放凭据或执行权限。当前插件不申请 nodeExecution。未实际通过的步骤标为未验证或失败；旧插件限制见[插件用途说明](features/10-legacy-plugin.md)。
