// Real Chromium DOM/CSS smoke test, no npm dependencies. ST/network APIs are mocked.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const browser = process.env.BTS_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const root = new URL('../', import.meta.url);
const fixture = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body>
<div id="extensions_settings2"></div><div id="chat"><div class="mes" mesid="0"><div class="mes_buttons"></div></div></div>
<script type="module">
const errors = [];
window.onerror = message => errors.push(message);
window.toastr = { error: m => errors.push(m), info() {}, warning() {} };
const events = {};
window.context = {
 chatId: 'test', characterId: 0, chatMetadata: {}, name1: 'Ева', powerUserSettings: { persona_description: 'Персона' },
 chat: [{ name: 'Тайлер', mes: 'Тайлер и Ева у бармена.' }],
 characters: [{ name: 'Тайлер', avatar: 't.png' }],
 extensionSettings: { 'behind-the-scene': { autoDetect: false, profileId: 'test' }, connectionManager: { profiles: [{ id: 'test' }] } },
 ConnectionManagerRequestService: { sendRequest: async () => async function* () {
  await new Promise(r => setTimeout(r, 100));
  yield { text: 'Тайлер: *улыбнулся*' };
  await new Promise(r => setTimeout(r, 500));
  yield { text: 'Тайлер: *улыбнулся* «Да».' };
 } },
 saveMetadata: async () => {}, saveSettingsDebounced() {},
 unshallowCharacter: () => new Promise(() => {}),
 generateRaw: async () => 'Тайлер: *улыбнулся* «Да».',
 eventTypes: { GENERATION_STARTED: 'start' }, eventSource: { on: (n, cb) => events[n] = cb }
};
window.jQuery = cb => cb();
window.$ = () => ({ on(names, selector, callback) {
 for (const name of names.split(' ')) document.addEventListener(name.split('.')[0], e => {
  const target = e.target.closest(selector); if (target) callback.call(target, e);
 });
} });
if (location.search.includes('fallback')) HTMLDialogElement.prototype.showModal = undefined;
const check = (value, message) => { if (!value) throw new Error(message); };
try {
 await import('/index.js');
 // Exercise cloned controls: native listener is lost, delegated click must still work.
 const original = document.querySelector('.bts-interview-btn');
 const clone = original.cloneNode(true); original.replaceWith(clone); clone.click();
 let dialog = document.querySelector('.bts-dialog');
 check(dialog?.open, 'Dialog failed to open immediately');
 await new Promise(r => setTimeout(r, 50));
 const rect = dialog.getBoundingClientRect();
 check(rect.width > 200 && rect.height > 200, 'Dialog has no usable size');
 check(rect.left >= -1 && rect.right <= innerWidth + 1, 'Dialog overflows viewport');
 check(rect.top >= -1 && rect.bottom <= innerHeight + 1, 'Dialog outside vertical viewport');
 check(dialog.textContent.includes('Ева (персона)'), 'Persona missing');
 events.start('normal', {}, true);
 dialog.querySelector('.bts-question').value = 'Вопрос';
 [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Спросить').click();
 check(dialog.querySelectorAll('.bts-bubble').length === 2, 'Question and waiting bubble must appear synchronously');
 const bubble = dialog.querySelector('.bts-assistant');
 await new Promise(r => setTimeout(r, 250));
 check(bubble.textContent.includes('улыбнулся'), 'Partial stream text missing');
 check(!bubble.textContent.includes('«Да»'), 'Stream finished too early for partial check');
 check(dialog.querySelector('.bts-assistant') === bubble, 'Streaming should update the existing bubble');
 await new Promise(r => setTimeout(r, 500));
 check(dialog.querySelector('.bts-assistant').textContent.includes('«Да»'), 'Final stream text missing');
 check(!dialog.querySelector('.bts-typing'), 'Typing indicator must clear');
 [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Закрыть').click();
 check(!document.querySelector('.bts-dialog'), 'Dialog failed to close');
 check(!document.querySelector('.bts-backdrop'), 'Fallback backdrop leaked');
 check(!errors.length, errors.join('; '));
 document.body.dataset.result = 'PASS';
} catch (error) { document.body.dataset.result = 'FAIL'; document.body.append(String(error.stack)); }
</script></body></html>`;

const server = createServer(async (req, res) => {
    try {
        const path = req.url.split('?')[0];
        if (path === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(fixture); }
        if (path === '/extensions.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end('export const getContext = () => window.context;'); }
 const files = { '/index.js': 'index.js', '/interview-core.mjs': 'interview-core.mjs', '/main-stream.mjs': 'main-stream.mjs', '/style.css': 'style.css' };
        if (!files[path]) { res.statusCode = 404; return res.end(); }
        let content = await readFile(new URL(files[path], root), 'utf8');
        if (path === '/index.js') content = content.replace('../../../extensions.js', './extensions.js');
        res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'text/javascript');
        res.end(content);
    } catch (error) { res.statusCode = 500; res.end(error.message); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
    for (const mode of ['native', 'fallback']) {
        const profile = await mkdtemp(fileURLToPath(new URL('.browser-', root)));
        try {
            const output = await new Promise((resolve, reject) => {
                const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
                    '--disable-extensions', '--window-size=390,844', '--virtual-time-budget=3000', '--dump-dom',
                    '--user-data-dir=' + profile, 'http://127.0.0.1:' + server.address().port + '/?' + mode]);
                let stdout = '';
                let stderr = '';
                const timer = setTimeout(() => { child.kill(); reject(new Error('Browser timed out')); }, 30000);
                child.stdout.on('data', data => stdout += data);
                child.stderr.on('data', data => stderr += data);
                child.on('error', error => { clearTimeout(timer); reject(error); });
                child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr)); });
            });
            assert.match(output, /data-result="PASS"/, output);
            console.log('PASS real Chromium mobile-width smoke: ' + mode);
        } finally { await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    }
} finally { server.close(); }