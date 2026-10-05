// الجسر بين صفحات البرنامج (الشريط/التسجيل/المشاكل) والبرنامج نفسه. صفحات السيستم مابتستخدمش أي حاجة منه.
const { contextBridge, ipcRenderer } = require('electron');

const listen = channel => (callback) => {
  const handler = (event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('desktop', {
  onStatus: listen('status'),
  onUpdate: listen('update'),
  onNavState: listen('nav-state'),
  onLoadingMessage: listen('loading-message'),
  getStatus: () => ipcRenderer.invoke('status:get'),
  pull: () => ipcRenderer.invoke('sync:pull'),
  push: () => ipcRenderer.invoke('sync:push'),
  nav: action => ipcRenderer.invoke('nav', action),
  updateAction: () => ipcRenderer.invoke('update:action'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  problems: {
    open: () => ipcRenderer.invoke('problems:open'),
    list: () => ipcRenderer.invoke('problems:list'),
    dismiss: seq => ipcRenderer.invoke('problems:dismiss', seq),
    retry: seq => ipcRenderer.invoke('problems:retry', seq),
  },
  setup: {
    defaults: () => ipcRenderer.invoke('setup:defaults'),
    register: data => ipcRenderer.invoke('setup:register', data),
  },
});
