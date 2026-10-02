import { detectCapabilities, hasMethod } from '../compat/capabilities';
import { PROBE_TITLE } from '../config/constants';

export interface TaskSummary { id: string; title: string }
export interface TaskHost {
  listTasks(): Promise<TaskSummary[]>;
  createProbeTask(): Promise<TaskSummary>;
  notify(title: string, body: string): Promise<void>;
}

export class CompatibilityError extends Error {}

function failure(method: string): CompatibilityError {
  return new CompatibilityError(`StudyFlow compatibility error: ${method} failed.`);
}

export class SuperProductivityAdapter implements TaskHost {
  constructor(private readonly api: unknown) {}

  get capabilities() { return detectCapabilities(this.api); }

  async listTasks(): Promise<TaskSummary[]> {
    try {
      if (!hasMethod(this.api, 'getTasks')) throw failure('getTasks');
      const tasks = await this.api.getTasks();
      if (!Array.isArray(tasks)) throw failure('getTasks');
      return tasks.map(task => {
        if (!task || typeof task.id !== 'string' || !task.id || typeof task.title !== 'string') throw failure('getTasks');
        return { id: task.id, title: task.title };
      });
    } catch { throw failure('getTasks'); }
  }

  async createProbeTask(): Promise<TaskSummary> {
    try {
      if (!hasMethod(this.api, 'addTask')) throw failure('addTask');
      const id = await this.api.addTask({ title: PROBE_TITLE });
      if (typeof id !== 'string' || !id.trim()) throw failure('addTask');
      return { id, title: PROBE_TITLE };
    } catch { throw failure('addTask'); }
  }

  async notify(title: string, body: string): Promise<void> {
    try {
      if (!hasMethod(this.api, 'notify')) throw failure('notify');
      await this.api.notify({ title, body });
    } catch { throw failure('notify'); }
  }

  async feedback(msg: string): Promise<void> {
    try {
      if (!hasMethod(this.api, 'showSnack')) throw failure('showSnack');
      await this.api.showSnack({ msg, type: 'INFO' });
    } catch { throw failure('showSnack'); }
  }
}
