# StudyFlow Windows 本地安装、升级与回退

适用于 `0.5.0-local` 的 Windows x64 交付包。制作包的方法见[开发与验证指南](features/09-development-and-verification.md)。

## 交付形态

StudyFlow 以完整 Windows x64 便携目录为应用载荷。交付脚本在便携目录中加入以下入口，并生成 `studyflow-delivery.json` SHA-256 清单：

- `install-studyflow.cmd`：在当前用户目录安装，或从一个新的完整本地包升级；
- `rollback-studyflow.cmd`：交换当前版本与保留的上一版本应用文件；
- `uninstall-studyflow.cmd`：移除应用文件和 StudyFlow 快捷方式；
- 对应的 PowerShell 脚本：完成文件校验、复制、移动和删除，不要求管理员权限；
- `studyflow-delivery.json`：记录产品、版本、可执行文件、签名状态，以及包内每个文件的相对路径、大小和 SHA-256。

最终用户不需要安装 Node、Python、Super Productivity 或 ActivityWatch。Node 脚本只在制作交付包时运行。

## 构建接线

`package:desktop` 生成 `StudyFlow-win32-x64` 目录并完成所有内容写入后，最后执行：

```powershell
node scripts/local-delivery.mjs prepare --package "<StudyFlow-win32-x64>" --version 0.5.0-local --build-id "<build-id>"
node scripts/local-delivery.mjs verify --package "<StudyFlow-win32-x64>"
```

`prepare` 会复制安装、卸载和回退入口，然后生成包含这些入口的清单。生成清单后不得再向便携目录增加、删除或改写文件；否则 `verify` 和安装器会拒绝该包。ZIP 应在这一步之后从已校验目录生成。

打包使用构建产物的实际 `info.version` 和 `info.id`；交付准备或校验失败会令打包失败。每次交付都应对当次完整目录重新校验。

## 安装和本地升级

1. 完整解压交付包，不要只复制 `StudyFlow.exe`。
2. 明确退出托盘中的 StudyFlow。
3. 双击新包内的 `install-studyflow.cmd`。

默认目标是 `%LOCALAPPDATA%\Programs\StudyFlow`。安装器先验证源包清单、全部文件大小和 SHA-256；签名包还会核对 Authenticode 状态与证书指纹。随后将文件复制到同一父目录的临时目录并再次验证。升级时，当前安装会移动到 `%LOCALAPPDATA%\Programs\StudyFlow.previous`，新版本才会成为当前版本。校验失败发生在现有版本移动之前；激活阶段失败时会恢复已移动的当前版本。

安装器只接受 `%LOCALAPPDATA%\Programs` 下的单层应用目录，并拒绝目标、`Programs` 或其已存在祖先中的目录联接和符号链接。它不会写入 Program Files、注册系统服务或请求管理员权限。快捷方式创建失败只显示警告，不撤销已经校验并激活的应用文件。

程序不会联网检查或自动下载更新。升级时取得一个新的完整交付包，核对其外部来源或发布者提供的摘要，再执行上述本地升级流程。

## 应用回退与数据库边界

关闭 StudyFlow 后双击 `rollback-studyflow.cmd`。脚本会校验当前版本和 `.previous`，再交换两套应用文件；再次执行可切回另一套应用文件。

**回退只回退应用二进制和随包资源，不会降级、替换或删除 `%APPDATA%\StudyFlow\studyflow.sqlite`。** 这条边界用于避免脚本静默丢弃升级后的任务、打卡或历史。

当前数据库版本为 schema v7。旧程序遇到其不支持的新版数据库时应拒绝打开。需要连数据库一起退回时，用户必须明确选择升级前自动生成且 SHA-256 已校验的备份，例如 v6 升至 v7 前的 `studyflow.sqlite.<UUID>.v6.sqlite`：先退出 StudyFlow，另行保存当前数据库，再手工用所选旧版备份替换 `studyflow.sqlite`。这样做会丢弃该备份之后写入的新数据，不能由安装器自动决定或静默执行。备份和恢复方法见[数据、备份与恢复](features/07-data-backup-and-recovery.md)。

## 卸载与数据保留

先从托盘明确退出 StudyFlow，再双击已安装目录中的 `uninstall-studyflow.cmd`。卸载前检查当前及回退版文件占用；已有占用会在删除前拒绝，不结束用户进程。此预检不保证其他进程随后新打开文件时的原子卸载。卸载器先核对当前安装及上一版本的产品身份、完整清单和 SHA-256，并拒绝目录联接，再删除这两套应用文件和指向它们的 StudyFlow 快捷方式。

卸载器不读取、移动或删除 `%APPDATA%\StudyFlow`。任务、每日打卡、设置、历史和数据库升级备份均保留。若用户以后确实要清除数据，应在退出应用并自行备份后，单独明确处理数据目录；本地卸载入口不提供静默清库选项。

## 可选离线代码签名

未配置签名参数时，清单记录 `unsigned`。SHA-256 清单能发现相对于随包清单的损坏或改写，但未签名的清单本身不是发布者证明。

使用当前用户证书存储中的代码签名证书和本机 `signtool.exe`，可离线制作签名包：

```powershell
node scripts/local-delivery.mjs prepare `
  --package "<StudyFlow-win32-x64>" `
  --version 0.5.0-local `
  --build-id "<build-id>" `
  --sign-tool "<Windows SDK>\signtool.exe" `
  --certificate-thumbprint "<40 位 SHA-1 证书指纹>"
```

两个签名参数必须同时提供。脚本以 SHA-256 对包内 `.exe` 签名并立即用 `signtool verify /pa /all` 验证，然后才计算文件清单。该流程不访问时间戳服务，签名元数据会标记 `none-offline`；证书过期后的长期有效性与带可信时间戳的公开发布签名不同。源码支持该流程，不代表任意下载包已经签名；应检查所取得包的实际签名和清单。

## 自动化验证与人工验收边界

```powershell
npx vitest run tests/local-delivery.test.ts --exclude release/**
```

该测试使用临时虚构便携包和临时 `LOCALAPPDATA` / `APPDATA`，覆盖：

- 清单生成、完整校验、文件篡改和目录穿越拒绝；
- 当前用户安装、完整本地包升级、上一版本交换回退与卸载；
- 升级包被篡改时保留当前安装和用户数据；
- 安装目标越界、`Programs` 目录联接和恶意 `.previous` 目录联接拒绝；
- 安装、升级、回退和卸载过程中 APPDATA 哨兵数据保持不变。

自动化虚构包测试不等于在真实用户目录安装或验证真实快捷方式，也不能证明真实代码签名证书、干净机器上的首次启动和跨版本数据库恢复成功。发布包应单独执行清单校验；这些真实环境操作与长时间使用的验收边界见[开发与验证指南](features/09-development-and-verification.md#发布与人工验收边界)和[长时间测试清单](eight-hour-test-checklist.md)。
