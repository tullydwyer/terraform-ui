const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Workspace
  getWorkspace: () => ipcRenderer.invoke('workspace:get'),
  setWorkspace: (path) => ipcRenderer.invoke('workspace:set', path),
  selectWorkspace: () => ipcRenderer.invoke('workspace:select'),

  // Terraform operations
  init: (cwd) => ipcRenderer.invoke('terraform:init', cwd),
  plan: (cwd, options) => ipcRenderer.invoke('terraform:plan', cwd, options),
  planJson: (cwd, options) => ipcRenderer.invoke('terraform:plan:json', cwd, options),
  apply: (cwd, options) => ipcRenderer.invoke('terraform:apply', cwd, options),
  destroy: (cwd, options) => ipcRenderer.invoke('terraform:destroy', cwd, options),
  refresh: (cwd, options) => ipcRenderer.invoke('terraform:refresh', cwd, options),
  stateList: (cwd) => ipcRenderer.invoke('terraform:state:list', cwd),
  stateShow: (cwd, address) => ipcRenderer.invoke('terraform:state:show', cwd, address),
  showJson: (cwd) => ipcRenderer.invoke('terraform:show:json', cwd),
  stateMove: (cwd, sourceAddress, destAddress) => ipcRenderer.invoke('terraform:state:mv', cwd, sourceAddress, destAddress),
  stateRemove: (cwd, address) => ipcRenderer.invoke('terraform:state:rm', cwd, address),
  importResource: (cwd, address, id) => ipcRenderer.invoke('terraform:import', cwd, address, id),

  // Workspaces and tfvars
  listWorkspaces: (cwd) => ipcRenderer.invoke('terraform:workspaces:list', cwd),
  selectWorkspaceName: (cwd, name) => ipcRenderer.invoke('terraform:workspace:select', cwd, name),
  listTfvars: (cwd) => ipcRenderer.invoke('terraform:tfvars:list', cwd),

  onLog: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('terraform:log', listener);
    return () => ipcRenderer.removeListener('terraform:log', listener);
  },

  onCommand: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('terraform:command', listener);
    return () => ipcRenderer.removeListener('terraform:command', listener);
  },
});



