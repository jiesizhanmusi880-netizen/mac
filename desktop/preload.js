'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ktv', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  pickFiles: (options) => ipcRenderer.invoke('dialog:openFile', options),
  pickSavePath: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  showItem: (filePath) => ipcRenderer.invoke('shell:showItem', filePath),
  readLocalFile: (filePath) => ipcRenderer.invoke('media:readLocal', filePath),
  ensureDir: (dir) => ipcRenderer.invoke('fs:ensureDir', dir),

  /** 逐帧渲染（主进程隐藏窗口 + capturePage + JPEG 序列） */
  renderFrames: (options) => ipcRenderer.invoke('render:frames', options),
  cancelRender: () => ipcRenderer.invoke('render:cancel'),

  /** 渲染进度订阅 */
  onRenderProgress: (callback) => {
    ipcRenderer.removeAllListeners('render:progress');
    ipcRenderer.on('render:progress', (_event, info) => callback(info));
  },

  /** 菜单「撤销上一步」(Ctrl+Z) → 渲染进程执行时间轴撤销 */
  onUndo: (callback) => {
    ipcRenderer.removeAllListeners('app:undo');
    ipcRenderer.on('app:undo', () => callback());
  },
});
