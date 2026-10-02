import { record, textValue, type DesktopSnapshot, type FocusPort } from './contracts';
import { historyDate } from './history';
import { StudyStore } from './store';
import { timerPreferences } from './preferences';
import { randomUUID } from 'node:crypto';
import { parseImport, importChoices, type ImportDocument, type ImportChoices } from '../import/json-plan';
import { resolveSchedule } from '../import/schedule';
import { managementCommands, type ManagementCommand } from './management-commands';

export class DesktopService {
  private pendingImport: { token: string; document: ImportDocument; choices: ImportChoices; revision: string; updateTaskIds: string[] } | null = null;
  constructor(private readonly store: StudyStore, private readonly focus: FocusPort) {}
  execute(command: unknown, payload?: unknown): DesktopSnapshot {
    if (typeof command === 'string' && managementCommands.includes(command as ManagementCommand)) {
      const input = record(payload);
      if (this.focus.state().running && (command === 'updateTask' || command === 'archiveTask') && this.focus.state().taskId === input.id) throw new Error('请先结束此任务的专注');
      this.store.manage(command as ManagementCommand, input);
      if (command === 'checkIn' && input.done === true && this.focus.state().taskId === input.id && this.focus.state().running) this.focus.stop('当日任务已打卡，本次专注已结束');
      return { ...this.store.snapshot(), focus: this.focus.state(), planReminder: this.store.planReminderStatus() };
    }
    let daily: DesktopSnapshot['daily'];
    let importPreview: DesktopSnapshot['importPreview'];
    let importResult: DesktopSnapshot['importResult'];
    switch (command) {
      case 'previewImport': {
        this.pendingImport = null;
        const input = record(payload); const resolved = resolveSchedule(parseImport(input.content), input.startDate);
        const document = resolved.document; const choices = importChoices(input.choices, document);
        const result = this.store.previewImport(document, choices); const token = randomUUID();
        importPreview = { ...result.preview, token, errors: [...result.preview.errors, ...resolved.errors], inferredPlans: resolved.inferred };
        const focus = this.focus.state();
        if (focus.running && result.preview.taskUpdates.some(update => update.taskId === focus.taskId)) importPreview.errors.push('请先结束此任务的专注，再重新预览导入更新');
        if (!resolved.errors.length) this.pendingImport = { token, document, choices, revision: result.revision, updateTaskIds: result.preview.taskUpdates.filter(update => update.selected).map(update => update.taskId) }; break;
      }
      case 'cancelImport': this.pendingImport = null; break;
      case 'confirmImport': {
        const token = textValue(record(payload).token, 80); const pending = this.pendingImport;
        if (!pending || token !== pending.token) throw new Error('导入预览已失效，请重新选择文件或预览');
        this.pendingImport = null;
        const focus = this.focus.state();
        if (focus.running && focus.taskId !== null && pending.updateTaskIds.includes(focus.taskId)) throw new Error('请先结束此任务的专注，再重新预览导入更新');
        importResult = this.store.commitImport(pending.document, pending.choices, pending.revision) ? 'imported' : 'duplicate'; break;
      }
      case 'snapshot': break;
      case 'planReminderSettings': this.store.updatePlanReminderSettings(payload); break;
      case 'daily': daily = this.store.daily(record(payload).date); break;
      case 'savePlan': {
        const input = record(payload); this.store.savePlan(input.date, input.entries); daily = this.store.daily(input.date); break;
      }
      case 'saveReview': {
        const input = record(payload); this.store.saveDailyReview(input.date, input.review); daily = this.store.daily(input.date); break;
      }
      case 'classifyApp': {
        const input = record(payload); historyDate(input.date); this.store.classifyApp(input.app, input.category); daily = this.store.daily(input.date); break;
      }
      case 'createProject': this.store.createProject(record(payload).name); break;
      case 'createTask': this.store.createTask(payload); break;
      case 'setTaskDone': {
        const input = record(payload);
        this.store.setTaskDone(input.id, input.done);
        if (input.done && this.focus.state().taskId === input.id) this.focus.stop('任务已完成，本次专注已结束');
        break;
      }
      case 'deleteHistory':
        if (this.focus.state().running) throw new Error('请结束计时后再删除历史');
        if (this.store.snapshot().settings.allDayActivity) throw new Error('请先关闭并保存全天活动记录设置，再删除历史');
        this.store.deleteHistory(record(payload).date); break;
      case 'settings':
        if (this.focus.state().running) throw new Error('请结束专注后再修改设置');
        if (this.focus.flushActivity && !this.focus.flushActivity()) throw new Error('全天活动保存失败，请重试');
        this.store.updateSettings(payload); this.focus.configure?.(this.store.snapshot().settings); break;
      case 'start': {
        const input = record(payload);
        const taskId = input.taskId === null ? null : textValue(input.taskId, 80);
        const data = this.store.snapshot();
        if (taskId && !data.tasks.some(task => task.id === taskId && !task.done)) throw new Error('请选择未完成的任务');
        if (taskId) this.store.assertTaskReady(taskId);
        const preferences = timerPreferences({ ...data.settings, ...input });
        if (this.focus.state().running) throw new Error('请先结束当前计时');
        if (this.focus.flushActivity && !this.focus.flushActivity()) throw new Error('全天活动保存失败，请重试');
        this.store.updateSettings(preferences);
        this.focus.configure?.(this.store.snapshot().settings);
        this.focus.start(taskId, data.settings.durationMinutes, data.settings.whitelist, preferences);
        break;
      }
      case 'previewSound':
        if (!this.focus.previewSound) throw new Error('声音组件不可用');
        this.focus.previewSound(payload); break;
      case 'stop': this.focus.stop(); break;
      case 'pause':
        if (!this.focus.pause) throw new Error('当前计时不支持暂停');
        this.focus.pause(); break;
      case 'resume':
        if (!this.focus.resume) throw new Error('当前计时不支持继续');
        this.focus.resume(payload); break;
      default: throw new Error('不支持的操作');
    }
    return { ...this.store.snapshot(), focus: this.focus.state(), planReminder: this.store.planReminderStatus(), ...(daily ? { daily } : {}), ...(importPreview ? { importPreview } : {}), ...(importResult ? { importResult } : {}) };
  }
}
