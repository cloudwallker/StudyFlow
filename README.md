# StudyFlow

### A local study planner and focus timer for Windows

**Organize daily plans, focus on one task, and compare planned time with effective study time. Your tasks, reviews, and activity records stay on your computer; no account is required.**

English | [中文](README_ZH.md)

[Features](#features) · [Quick start](#quick-start) · [Usage](#usage) · [Documentation](#documentation) · [Development](#development)

![StudyFlow workspace with a daily task calendar and focus timer](docs/images/workspace.png)

*The current Windows application, shown with fictional demonstration data. The interface is in Chinese.*

## Features

- **Projects and daily plans:** create tasks with estimates, tags, and dependencies; search, reorder, archive, and restore them. Browse a daily calendar, schedule repeated practice, and check in independently for each date.
- **Focus sessions:** countdown, stopwatch, and Pomodoro timers with pause/resume, optional long focus with micro-breaks, and an always-on-top window showing today's accumulated focus time. Closing the main window to the tray keeps the session running.
- **Local plan import:** import JSON or XLSX files, or paste JSON. Review tasks, dates, durations, and changes before saving; reuse projects, merge plans, explicitly replace a day, and skip duplicate imports.
- **Activity and gentle reminders:** identify the foreground Windows application, exclude AFK and unknown periods from effective study time, and show reminders for applications outside your whitelist. Optional daily plan reminders and local background audio are available.
- **Daily review:** view study and application timelines, classify applications, compare planned and actual minutes, and write what you accomplished, what got in the way, and what to adjust tomorrow.

The desktop application runs independently of Super Productivity and ActivityWatch. Core use is offline; dependency installation and the initial Electron download need network access.

## Quick start

### Run from source

Use **Windows x64**, **Node.js 24 with npm**, and the Windows **.NET Framework 4.x C# compiler**. The build uses `Microsoft.NET/Framework64/v4.0.30319/csc.exe` beneath the Windows system directory. Dependencies are pinned in `package-lock.json`.

```powershell
git clone https://github.com/cloudwallker/StudyFlow.git
cd StudyFlow
npm ci
npm run install:electron
npm run start:desktop
```

`start:desktop` builds and starts the independent desktop app. The initial Electron download is cached in `.cache/electron/`. No sibling upstream checkout, Python installation, `.env`, API key, or application account is needed.

The repository contains source code, tests, and templates. Cloning it does not include a ready-to-run Windows bundle.

### Build a Windows bundle

After installing the dependencies and Electron:

```powershell
npm run package:desktop
npm run verify:package
```

The bundle is generated under `release/<build-time>/StudyFlow-win32-x64/`; its current location is written to `dist/desktop-package-path.txt`. Run **StudyFlow.exe** from that complete directory, or use its `install-studyflow.cmd`. Keep the entire bundle together. A packaged app does not require Node, Python, Super Productivity, or ActivityWatch to be installed separately.

## Usage

1. Create a project and task, or choose **导入计划** (Import plan) to load a [JSON template](examples/studyflow-plan.json), [Excel template](examples/studyflow-plan.xlsx), or pasted JSON. Inspect the preview before confirming.
2. In **按日学习** (Daily view), choose a date and start a planned task. **全部任务** (All tasks) also lists tasks without dates. Date check-ins and overall task completion are independent.
3. Select a timer mode and task, then start focus. Use **更多** (More) for editing or reordering. You can also choose free focus without assigning a task.
4. Open **设置** (Settings) to save timer defaults, sounds, application whitelist, activity-recording choices, and daily plan reminders. A whitelist entry is a complete executable name such as `Code.exe`; matching ignores case and surrounding whitespace.
5. In **活动与复盘** (Activity and review), select a date and click **读取日期 / 刷新** (Load date / Refresh). Save the daily plan or review against the loaded date.

The workspace keeps the task calendar and focus controls together. Navigation preserves form drafts and the running session. Secondary actions support keyboard and touch; **Escape** closes an open task menu. See the [interface guide](docs/features/12-frontend-layout.md).

JSON plans should contain explicit `YYYY-MM-DD` dates. If dates are missing, the import preview can infer dates from a day-number title and a chosen first date. StudyFlow validates and imports the file locally; it does not call an AI service to generate or reschedule plans.

The mini window shows elapsed **work-phase focus time**, including free focus. Daily effective study time also excludes AFK and unknown samples, so the two totals can differ. Free focus is listed separately in daily review and does not increase a task's accumulated time.

## Privacy and data

- The normal database is `%APPDATA%\StudyFlow\studyflow.sqlite` (schema v7). The dedicated test build uses `%APPDATA%\StudyFlow-Test`.
- Session application recording and all-day activity recording are **off by default** and can be enabled separately. Only executable names and activity/AFK/unknown states are saved; window titles, URLs, keystrokes, and browser history are not recorded.
- The app uses local HTML, CSS, scripts, and SQLite. Normal operation does not send task or activity data to cloud services, LLMs, or telemetry endpoints.
- Locking or suspending Windows pauses focus; resume it manually after returning. Checkpoints are saved at session transitions and approximately every 30 seconds. Restart restores confirmed history, marks unfinished sessions as interrupted, and does not count downtime.
- Database upgrades create a checked backup before migration. A crash can lose work after the last successful checkpoint. Deleting a date's history preserves task totals and its plan snapshot; disable and save all-day recording first. Review backup copies separately when removing sensitive data.

See [data, backup, and recovery](docs/features/07-data-backup-and-recovery.md) and [lifecycle, privacy, and security](docs/features/08-lifecycle-privacy-and-security.md) for full behavior and recovery steps.

## Documentation

The detailed user documentation is currently in Chinese.

| Guide | Topic |
| --- | --- |
| [Interface guide](docs/features/12-frontend-layout.md) | Workspace, task actions, import, settings, and review |
| [Projects and tasks](docs/features/02-projects-and-tasks.md) | Estimates, scheduling, tags, dependencies, and task management |
| [Timers and Pomodoro](docs/features/03-timers-and-pomodoro.md) | Timer modes, micro-breaks, sounds, and the mini window |
| [Activity and reminders](docs/features/04-activity-afk-reminders.md) | Foreground applications, AFK, whitelist, and daily reminders |
| [History and review](docs/features/05-history-timeline-and-review.md) | Timelines, application categories, and review notes |
| [Daily plans and comparison](docs/features/06-daily-plan-and-comparison.md) | Plan snapshots and effective study time |
| [Backup and recovery](docs/features/07-data-backup-and-recovery.md) | Database migration, checkpoints, and manual recovery |

## Development

The independent app uses TypeScript, Electron, local HTML/CSS, SQLite, and a bundled C# Windows sampler. Keep domain behavior separate from the UI and use fictional task and activity data for tests.

```powershell
npm test
npm run lint
npm run build:desktop
npm run verify:frontend
```

`npm test` runs the full regression suite; `test:desktop` covers only a subset. `lint` includes strict TypeScript and unused-code checks. `verify:frontend` uses isolated fictional data and simulated activity/audio to check interaction and layout; it does not read the normal user database.

As of **2026-10-02**, the current source passed **464 automated tests** and **591 frontend checks across 91 states**. Human acceptance testing was skipped for this frontend update. Automated results do not establish real lock/sleep behavior, prolonged operation, or compatibility with a clean Windows machine.

Additional Windows checks include `verify:desktop`, `verify:reminder`, `verify:plan`, and `verify:focus-mini`. `verify:ambient` needs FFmpeg in `PATH` or `FFMPEG_PATH` to generate fictional test audio; FFmpeg is not an application runtime dependency.

`src/desktop/` contains the app and persistence services, `src/timer/` and `src/activity/` contain timing and activity rules, `desktop/` contains the UI, and `native/` contains bundled Windows helpers. Older plugin prototype code remains for reference; `npm run build` and `verify:plugin` apply to that prototype, not the independent desktop app.

## Licensing and attribution

Third-party code retains its original attribution and licenses: the adapted task-time utility is covered by [Super Productivity's MIT license](third-party/super-productivity-LICENSE.txt), and the adapted Windows sampler retains [ActivityWatch's MPL-2.0 license](third-party/activitywatch-LICENSE.txt). See [third-party notices](third-party/README.txt); bundled dependencies keep their applicable licenses.

This repository does not currently declare a root license for StudyFlow's own code. The third-party licenses do not grant a blanket license to the whole project.
