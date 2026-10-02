import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { strFromU8, unzipSync } from 'fflate';

// Execute the actual ZIP's inline bundle using only fictional host/HTTP fixtures.
// This is an artifact smoke check, never evidence of Windows host compatibility.
const files = unzipSync(await readFile('dist/studyflow-phase0.zip'));
assert.deepEqual(Object.keys(files).sort(), ['index.html', 'manifest.json', 'plugin.js']);
const manifest = JSON.parse(strFromU8(files['manifest.json']));
assert.equal(manifest.iFrame, true);
assert.equal(manifest.manifestVersion, 1);
assert.deepEqual(manifest.permissions.sort(), ['addTask', 'getTasks', 'notify', 'showSnack']);
const html = strFromU8(files['index.html']);
assert.ok(Buffer.byteLength(html) < 100000);
const notifications = [];
const writes = [];
const requests = [];
let unload = () => {};
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  beforeParse(window) {
    window.PluginAPI = {
      getTasks: async () => [{ id: 'fictional-task', title: 'Fictional study task' }],
      addTask: async input => { writes.push(input); return 'fictional-probe'; },
      notify: async input => { notifications.push(input); },
      showSnack() {},
      onReady: ready => window.queueMicrotask(ready),
      onUnload: dispose => { unload = dispose; },
    };
    window.fetch = async (url, options) => {
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(new URL(url).origin, 'http://127.0.0.1:5600');
      requests.push(url);
      return new Response(JSON.stringify(url.includes('/events?')
        ? [{ id: 1, timestamp: new Date().toISOString(), duration: 0, data: { app: 'Fictional Notepad', title: 'Fictional private notes' } }]
        : { demo: { id: 'demo', type: 'currentwindow', client: 'aw-watcher-window', hostname: 'fictional-pc' } }));
    };
  },
});
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
try {
  await settle();
  const doc = dom.window.document;
  assert.equal(writes.length, 0);
  assert.equal(requests.length, 0);
  assert.equal(doc.querySelectorAll('script[src],link[href]').length, 0);
  doc.getElementById('check-api').click(); await settle();
  assert.match(doc.getElementById('tasks').textContent, /1 个任务/);
  doc.getElementById('create-probe').click(); await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ title: '[StudyFlow PoC] Plugin API probe' }]);
  doc.getElementById('start-focus').click(); await settle();
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].body, /Fictional Notepad/);
  assert.match(notifications[0].body, /10:00/);
  assert.equal(doc.getElementById('stop-focus').disabled, false);
  unload();
  assert.equal(doc.getElementById('start-focus').disabled, true);
  assert.equal(doc.getElementById('focus-status').textContent, 'Stopped');
  assert.ok(!doc.body.textContent.includes('Fictional private notes'));
  console.log('ZIP layout + bundled UI/API/Focus/unload smoke: PASS (mock environment only)');
} finally { unload(); dom.window.close(); }
