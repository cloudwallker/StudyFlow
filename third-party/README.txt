StudyFlow 0.1.0 source reuse notices

Super Productivity: MIT, Copyright (c) 2018 Johannes Millan.
See super-productivity-LICENSE.txt and the adapted task-time.ts in the package.

ActivityWatch aw-watcher-window: MPL-2.0.
Pinned source commit: abd69a6b6a56a80df3d9971ca152f84fc23e7340.
See activitywatch-LICENSE.txt and activitywatch-windows.py.reference.
The full modified covered source is WindowSampler.cs, included in the portable
package alongside this file. Compile using Windows .NET Framework csc.exe:
  csc /target:exe /reference:System.Web.Extensions.dll /out:StudyFlowSampler.exe WindowSampler.cs
No other StudyFlow files are required to rebuild the collector.

StudyFlow uses only app names. The reference Python source is not run or bundled
as a Python application. No ActivityWatch server or client is required.
