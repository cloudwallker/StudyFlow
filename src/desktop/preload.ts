import { contextBridge, ipcRenderer } from 'electron';
import type { Command, DesktopAPI, Reply } from './contracts';
import { buildInfo } from './build-info';
import type { DiagnosticReply } from './diagnostic-renderer';
import { managementCommands } from './management-commands';
import type { AmbientAudioReply } from './ambient-audio';

const commands: readonly Command[] = ['snapshot', 'createProject', 'createTask', 'setTaskDone', 'settings', 'start', 'stop', 'pause', 'resume', 'deleteHistory', 'daily', 'savePlan', 'saveReview', 'classifyApp', 'previewImport', 'confirmImport', 'cancelImport', 'previewSound', 'planReminderSettings'];
const api: DesktopAPI = {
  focusMini: { open: () => ipcRenderer.invoke('studyflow:focus-mini-open') },
  ambient: { request: (command, payload): Promise<AmbientAudioReply> => ipcRenderer.invoke('studyflow:ambient-audio', command, payload) as Promise<AmbientAudioReply> },
  request: (command, payload): Promise<Reply> => {
    if (!commands.includes(command) && !managementCommands.some(name => name === command)) return Promise.resolve({ ok: false, error: '不支持的操作' });
    return ipcRenderer.invoke('studyflow:command', command, payload) as Promise<Reply>;
  },
};
if (buildInfo.test) {
  api.diagnostics = {
    request: (command, payload): Promise<DiagnosticReply> => ipcRenderer.invoke('studyflow:diagnostic', command, payload) as Promise<DiagnosticReply>,
    reportError: (kind, frames) => { ipcRenderer.send('studyflow:renderer-error', kind, { frames }); },
  };
}
contextBridge.exposeInMainWorld('studyflow', api);
