// Test-only driver. Never imported or bundled by the production app.
import { createApp } from '../../.runtime/runtime/bridge.js';
import * as main from '../../src/main.js';
const root = decodeURIComponent(new URL('../../', import.meta.url).pathname).replace(/\/$/, '');
const read = async (path) => new TextDecoder().decode(await tjs.readFile(path));
const config = JSON.parse(await read(root + '/tinyjs.json'));
const emit = (type, data) => console.log('E2E:' + JSON.stringify({ type, data }));
config.api.origins = {
  'https://do1.musaraj.com': [...config.api.origins['https://*'], 'e2eReport'],
  'file://*': [...config.api.origins['file://*'], 'e2eReport'],
};
let homePending = false;
const app = await createApp({
  htmlPath: root + '/src/frontend/index.html', launcherPath: root + '/.e2e/launcher',
  id: 'org.discourse.chat.e2e', title: 'Discourse Chat App — isolated E2E', size: config.size,
  inject: await read(root + '/src/inject.js'), chrome: config.chrome,
  apiAccess: config.api, popups: 'external',
  api: { ...main.api, e2eReport(data, _app, caller) {
    if (caller.window !== 'main' || !(caller.origin === 'https://do1.musaraj.com' || caller.origin.startsWith('file:'))) throw new Error('Invalid test caller');
    emit('report', data); return true;
  } },
  onNavigate(event, app) {
    if (event.kind === 'finish' && event.url.startsWith('file:')) {
      emit('loaded', true);
      if (homePending) { homePending = false; emit('home', true); }
    }
    return main.onNavigate(event, app);
  }, onMenu: main.onMenu, onWindowOpen: main.onWindowOpen,
});
const store = new Map([['desktopNotifications', false]]);
app.store = { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); return true; }, delete: async (k) => store.delete(k) };
app.shell.open = async (url) => { emit('browser', url); return true; };
await main.init(app);
emit('ready', true);
let last = 0, busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    const command = JSON.parse(await read(root + '/.e2e/command.json'));
    if (command.id <= last) return;
    last = command.id;
    if (command.op === 'eval') app.eval(command.code);
    if (command.op === 'pdf') { await app.printToPDF(command.path); emit('pdf', command.path); }
    if (command.op === 'home') { homePending = true; await main.onMenu('home', app); }
    if (command.op === 'quit') app.quit();
  } catch { /* atomic command file may not exist yet */ }
  finally { busy = false; }
}, 100);
await app.done;
clearInterval(timer);
tjs.exit(0);
