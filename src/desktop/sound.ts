import { spawn, type ChildProcess } from 'node:child_process';
import { soundConfig, soundKinds, type SoundConfig, type SoundKind, type SoundPort } from '../timer/pomodoro-sound';

/** Short, application-owned Windows playback process. No shell or user file access. */
export class DesktopSound implements SoundPort {
  private active: { child: ChildProcess; cancel(): void } | null = null;
  constructor(private readonly executable: string) {}
  play(kind: SoundKind, value: SoundConfig): Promise<void> {
    const config = soundConfig(value);
    if (!soundKinds.includes(kind)) return Promise.reject(new Error('无效提示音类型'));
    this.stop();
    if (config.volume === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [kind, config.tone, String(config.volume)], { windowsHide: true, stdio: 'ignore', shell: false });
      let finished = false;
      const finish = (failed = false) => {
        if (finished) return;
        finished = true; clearTimeout(timeout);
        if (this.active?.child === child) this.active = null;
        if (failed) reject(new Error('提示音播放失败')); else resolve();
      };
      const timeout = setTimeout(() => { child.kill(); finish(true); }, 5000);
      this.active = { child, cancel: () => { child.kill(); finish(); } };
      child.once('error', () => finish(true));
      child.once('exit', code => finish(code !== 0));
    });
  }
  stop(): void { this.active?.cancel(); }
}
