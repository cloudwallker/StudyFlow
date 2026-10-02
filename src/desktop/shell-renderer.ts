/** View navigation only. Services and form nodes remain mounted across pages. */
export function mountShell(doc: Document) {
  type Page = 'workspace' | 'review' | 'settings';
  let page: Page = 'workspace';
  let projectTitle = '学习工作台';
  const removers: Array<() => void> = [];
  const el = (id: string) => {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`Missing shell UI: ${id}`);
    return node;
  };
  const pages = { workspace: 'workspace-page', review: 'daily-panel', settings: 'settings-page' };
  const nav = { workspace: 'all-projects', review: 'nav-review', settings: 'nav-settings' };
  function show(next: Page) {
    page = next;
    if (next !== 'workspace' && doc.body.classList.contains('study-view')) el('focus-view').click();
    for (const key of Object.keys(pages) as Page[]) {
      el(pages[key]).hidden = key !== next;
      el(nav[key]).classList.toggle('selected', key === next);
      if (key === next) el(nav[key]).setAttribute('aria-current', 'page');
      else el(nav[key]).removeAttribute('aria-current');
    }
    el('view-title').textContent = next === 'workspace' ? projectTitle : next === 'review' ? '活动与复盘' : '设置';
    el('view-description').textContent = next === 'workspace' ? '安排今天，从一件重要的事开始。' : next === 'review' ? '看见时间的去向，找到适合自己的节奏。' : '让 StudyFlow 更适合你的学习习惯。';
    doc.body.dataset.page = next;
  }
  function on(id: string, action: () => void) {
    const node = el(id); node.addEventListener('click', action);
    removers.push(() => node.removeEventListener('click', action));
  }
  on('all-projects', () => show('workspace'));
  on('nav-review', () => show('review'));
  on('nav-settings', () => show('settings'));
  on('active-session', () => { show('workspace'); el('focus-toggle').focus(); });
  function openEntry(importing: boolean) {
    show('workspace');
    if (doc.body.classList.contains('study-view')) el('focus-view').click();
    (el('task-entry') as HTMLDetailsElement).open = true;
    if (importing) (el('import-panel') as HTMLDetailsElement).open = true;
    el(importing ? 'import-file' : 'task-title').focus();
  }
  on('quick-add', () => openEntry(false));
  on('quick-import', () => openEntry(true));
  show('workspace');
  return {
    project(title: string) { projectTitle = title; if (page === 'workspace') el('view-title').textContent = title; },
    workspace() { show('workspace'); },
    dispose() { removers.forEach(remove => remove()); },
  };
}
