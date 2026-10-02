import { contextBridge, ipcRenderer } from 'electron';
import { FOCUS_MINI_CHANNEL, type FocusMiniAPI, type FocusMiniReply } from './focus-mini-contracts';

const api: FocusMiniAPI = {
  snapshot: (): Promise<FocusMiniReply> => ipcRenderer.invoke(FOCUS_MINI_CHANNEL, 'snapshot') as Promise<FocusMiniReply>,
  act: action => {
    if (action !== 'open-main' && action !== 'close') return Promise.resolve({ ok: false, error: '不支持的小窗操作' });
    return ipcRenderer.invoke(FOCUS_MINI_CHANNEL, action) as Promise<FocusMiniReply>;
  },
};

contextBridge.exposeInMainWorld('studyflowFocusMini', api);
