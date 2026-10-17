const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Only these channels are reachable from the page.
const INVOKE = new Set(['store:get', 'library:get', 'library:addFolder', 'library:removeFolder', 'library:rescan', 'track:info',
  'playlist:import', 'playlist:export', 'playlist:readFile', 'import:phone', 'waveform', 'lyrics:get', 'dialog:openFiles', 'app:args',
  'tags:write', 'file:trash', 'art:pick', 'art:fetch', 'art:cleanup', 'art:artists', 'autoeq:index', 'autoeq:get', 'backup:export', 'backup:import',
  'scrobble:listenbrainz']);
const SEND = new Set(['store:set', 'dec:start', 'dec:ack', 'dec:stop', 'dec:reset', 'win:progress', 'win:fullscreen', 'win:thumbar',
  'win:mini', 'win:theme', 'win:fitzoom', 'shell:show', 'shell:open', 'notify', 'power:keepAwake', 'xo:msg', 'hwvol:dev', 'hwvol:set']);
const ON = new Set(['dec:data', 'dec:end', 'dec:error', 'dec:meta', 'library:progress', 'library:changed', 'open-files', 'cmd', 'xo:msg', 'hwvol']);
const check = (set, ch) => { if (!set.has(ch)) throw new Error('blocked IPC channel: ' + ch); };

contextBridge.exposeInMainWorld('api', {
  invoke: (ch, ...a) => { check(INVOKE, ch); return ipcRenderer.invoke(ch, ...a); },
  send: (ch, ...a) => { check(SEND, ch); ipcRenderer.send(ch, ...a); },
  on: (ch, fn) => {
    check(ON, ch);
    const h = (e, ...a) => fn(...a);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.off(ch, h);
  },
  pathForFile: f => webUtils.getPathForFile(f),
});
