// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { mountDesktop } from '../src/desktop/renderer';
import { DesktopService } from '../src/desktop/service';
import { DesktopStudy } from '../src/desktop/study';
import { StudyStore } from '../src/desktop/store';

it('keeps a running session and unsaved fields when navigating and removes navigation listeners on disposal', async () => {
  document.documentElement.innerHTML = readFileSync('desktop/index.html', 'utf8');
  const store = new StudyStore(':memory:');
  const study = new DesktopStudy({ clock: { read: () => ({ wallMs: 0, monotonicMs: 0, utcOffsetMinutes: 0 }) },
    makeId: () => 'shell-session', sampler: { sample: async () => ({ status: 'unknown', app: null, idleMs: null }) },
    notify: async () => {}, dismiss: () => {}, credit: () => {} });
  const service = new DesktopService(store, study);
  const cleanup = mountDesktop(document, { request: async (command, payload) => ({ ok: true, value: service.execute(command, payload) }) });
  const flush = () => new Promise(r => setTimeout(r, 0));
  let cleaned = false;
  const node = (id: string) => { const item = document.getElementById(id); expect(item, id).not.toBeNull(); return item!; };
  try {
    await flush();
    node('nav-settings').click();
    node('settings-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    expect(Array.from(document.querySelectorAll('.main-nav .selected'), item => item.id)).toEqual(['nav-settings']);
    expect(node('settings-page').hidden).toBe(false);
    expect(node('workspace-page').hidden).toBe(true);
    const whitelist = node('whitelist') as HTMLTextAreaElement;
    whitelist.value = 'Unsaved.exe';
    node('nav-review').click();
    const review = node('review-accomplished') as HTMLTextAreaElement;
    review.value = '未保存的复盘';
    node('all-projects').click();
    node('focus-toggle').click(); await flush();
    expect(study.state().running).toBe(true);
    node('nav-settings').click();
    expect(whitelist.value).toBe('Unsaved.exe');
    expect(node('active-session').hidden).toBe(false);
    node('active-session').click();
    expect(node('workspace-page').hidden).toBe(false);
    expect(study.state().running).toBe(true);
    node('nav-review').click(); expect(review.value).toBe('未保存的复盘');
    node('quick-add').click();
    expect(node('workspace-page').hidden).toBe(false);
    expect((node('task-entry') as HTMLDetailsElement).open).toBe(true);
    expect(document.activeElement?.id).toBe('task-title');
    node('quick-import').click();
    expect((node('import-panel') as HTMLDetailsElement).open).toBe(true);
    expect(document.activeElement?.id).toBe('import-file');
    cleanup(); cleaned = true; node('nav-settings').click();
    expect(node('settings-page').hidden).toBe(true);
  } finally { if (!cleaned) cleanup(); store.close(); }
});
