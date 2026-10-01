// Dependency-free integration harness: actual entry point, minimal DOM/ST doubles.
// Does not test browser layout, real network requests or SillyTavern's save internals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as core from '../interview-core.mjs';

const source = (await readFile(new URL('../index.js', import.meta.url), 'utf8'))
    .replace(/import[\s\S]*?from\s+'[^']+';/g, '')
    .replace('export { MODULE_NAME };', '');

class Node {
    constructor(tag = '') {
        this.tag = tag;
        this.children = [];
        this.listeners = {};
        this.attributes = {};
        this.className = '';
        this.value = '';
        this.textContent = '';
    }
    append(...children) {
        children.forEach(child => { child.parent = this; this.children.push(child); });
    }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    async fire(name, args = {}) { await this.listeners[name]?.({ stopPropagation() {}, preventDefault() {}, ...args }); }
    all() { return this.children.flatMap(child => [child, ...child.all()]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    querySelectorAll(selector) {
        return this.all().filter(node => selector.startsWith('.')
            ? node.className.split(' ').includes(selector.slice(1)) : node.tag === selector);
    }
    add(option) { this.append(option); }
    get options() { return this.children; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; }
}

async function flush() { await new Promise(resolve => setImmediate(resolve)); }

function setup(options = {}) {
    const body = new Node('body');
    const settings = new Node('div');
    settings.id = 'extensions_settings2';
    const message = new Node('div');
    message.className = 'mes';
    message.setAttribute('mesid', '0');
    const buttons = new Node('div');
    buttons.className = 'mes_buttons';
    message.append(buttons);
    body.append(settings, message);
    const events = {};
    const errors = [];
    const state = { calls: 0, saves: 0 };
    let context = {
        chatId: 'first', characterId: 0, groupId: null,
        chatMetadata: {}, extensionSettings: { [core.MODULE_NAME]: { autoDetect: false } },
        chat: [{ name: 'Тайлер', mes: '<img src=x onerror=alert(1)>Сцена', is_user: false }],
        characters: [{ name: 'Тайлер', avatar: 'tyler.png', data: { description: 'Ироничный' } }],
        saveMetadata: async () => { state.saves++; }, saveSettingsDebounced() {},
        generateRaw: async () => { state.calls++; return 'Тайлер: *фыркнул* «Интенсивно». <script>alert(1)</script>'; },
        eventTypes: Object.fromEntries(['CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED'].map(name => [name, name])),
        eventSource: { on(name, listener) { events[name] = listener; } },
    };
    const document = {
        body, createElement: tag => {
            const node = new Node(tag);
            if (tag === 'dialog' && options.noDialog) node.showModal = undefined;
            if (tag === 'dialog' && options.brokenDialog) node.showModal = () => { throw new Error('Unsupported'); };
            return node;
        },
        addEventListener() {}, removeEventListener() {},
        createTextNode: text => Object.assign(new Node('#text'), { textContent: text }),
        getElementById: id => body.all().find(node => node.id === id),
        querySelectorAll: selector => body.querySelectorAll(selector),
    };
    vm.runInNewContext(source, {
        ...core, document, getContext: () => context,
        jQuery: callback => callback(), $: () => ({ on() {} }),
        Option: class extends Node { constructor(text, value) { super('option'); this.textContent = text; this.value = value; } },
        AbortController, console: { log() {}, info() {}, debug() {}, warn() {}, error: error => errors.push(error) },
        toastr: { error: text => errors.push(text), warning() {}, info() {} }, confirm: () => true,
    });
    return {
        body, state, events, errors, document,
        context: () => context,
        switchChat() { context = { ...context, chatId: 'second', chatMetadata: {} }; events.CHAT_CHANGED(); },
        async open() { await buttons.children[0].fire('click'); await flush(); return body.querySelector('dialog'); },
        byText(text) { return body.all().find(node => node.tag === 'button' && node.textContent === text); },
    };
}

test('entry point opens mini-chat without generating, restores persisted history, escapes HTML', async () => {
    const app = setup();
    assert.equal(app.errors.length, 0);
    const original = structuredClone(app.context().chat);
    const dialog = await app.open();
    assert.ok(dialog.open);
    assert.equal(app.state.calls, 0);
    const input = dialog.querySelector('.bts-question');
    input.value = 'Как вам эта сцена?';
    await app.byText('Спросить').fire('click');
    await flush();
    assert.equal(app.state.calls, 1);
    assert.equal(core.getStore(app.context().chatMetadata).sessions[0].messages.length, 2);
    assert.deepEqual(app.context().chat, original);
    assert.equal(dialog.querySelectorAll('script').length, 0);
    assert.equal(dialog.querySelectorAll('img').length, 0);
    assert.equal(dialog.querySelectorAll('em').length, 1);
    await app.byText('Закрыть').fire('click');
    await app.byText('Открыть').fire('click');
    assert.equal(app.body.querySelectorAll('.bts-bubble').length, 2);
    assert.ok(app.state.saves >= 2);
});

test('dryRun does not block interview; real generation blocks until stopped', async () => {
    const app = setup();
    const dialog = await app.open();
    app.events.GENERATION_STARTED('normal', {}, true);
    dialog.querySelector('.bts-question').value = 'После dryRun';
    await app.byText('Спросить').fire('click');
    await flush();
    assert.equal(app.state.calls, 1);
    app.events.GENERATION_STARTED('normal', {}, false);
    app.events.GENERATION_STARTED('normal', {}, true);
    dialog.querySelector('.bts-question').value = 'Во время генерации';
    await app.byText('Спросить').fire('click');
    await flush();
    assert.equal(app.state.calls, 1);
    app.events.GENERATION_STOPPED();
    await app.byText('Спросить').fire('click');
    await flush();
    assert.equal(app.state.calls, 2);
});

test('mobile fallback opens and closes without native showModal or when it throws', async () => {
    for (const options of [{ noDialog: true }, { brokenDialog: true }]) {
        const app = setup(options);
        const dialog = await app.open();
        assert.equal(dialog.getAttribute('open'), '');
        assert.equal(dialog.getAttribute('aria-modal'), 'true');
        assert.ok(app.body.querySelector('.bts-backdrop'));
        await app.byText('Закрыть').fire('click');
        assert.equal(app.body.querySelector('dialog'), null);
        assert.equal(app.body.querySelector('.bts-backdrop'), null);
        assert.deepEqual(app.errors, []);
    }
});

test('window opens immediately even if character loading never resolves', async () => {
    const app = setup();
    app.context().unshallowCharacter = () => new Promise(() => {});
    const dialog = await app.open();
    assert.ok(dialog.open);
});

test('automatic NPC detection merges participants and never posts to story or interview log', async () => {
    const app = setup();
    const toggle = app.document.getElementById('bts-panel').querySelectorAll('input')[1];
    toggle.checked = true;
    await toggle.fire('change');
    app.context().name1 = 'Ева';
    app.context().powerUserSettings = { persona_description: 'Актриса' };
    app.context().generateRaw = async () => '[{"name":"Бармен","description":"Наливал напиток"},{"name":"Ева"}]';
    await app.open();
    await flush();
    const session = core.getStore(app.context().chatMetadata).sessions[0];
    assert.deepEqual(Array.from(session.participants, p => p.name), ['Ева', 'Тайлер', 'Бармен']);
    assert.equal(session.participants[0].description, 'Актриса');
    assert.equal(session.messages.length, 0);
    assert.equal(app.context().chat.length, 1);
});

test('NPC detection failures leave interview usable and manual participants intact', async () => {
    const app = setup();
    const dialog = await app.open();
    app.context().generateRaw = async () => 'not JSON';
    await app.byText('Найти NPC в сцене').fire('click');
    await flush();
    assert.equal(app.byText('Спросить').disabled, false);
    assert.equal(core.getStore(app.context().chatMetadata).sessions[0].participants.length, 1);
    app.context().generateRaw = async () => 'Ответ';
    dialog.querySelector('.bts-question').value = 'Вопрос';
    await app.byText('Спросить').fire('click');
    await flush();
    assert.equal(core.getStore(app.context().chatMetadata).sessions[0].messages.length, 2);
});

test('late NPC detection after changing chats is discarded', async () => {
    const app = setup();
    await app.open();
    const oldSession = core.getStore(app.context().chatMetadata).sessions[0];
    let finish;
    app.context().generateRaw = () => new Promise(resolve => { finish = resolve; });
    await app.byText('Найти NPC в сцене').fire('click');
    await flush();
    app.switchChat();
    finish('[{"name":"Поздний NPC"}]');
    await flush();
    assert.equal(oldSession.participants.length, 1);
    assert.equal(core.getStore(app.context().chatMetadata).sessions.length, 0);
    assert.deepEqual(app.errors, []);
});

test('quick questions fill draft without sending; NPC and selection reach the prompt', async () => {
    const app = setup();
    let prompt;
    app.context().generateRaw = async args => { prompt = args; return 'Ответ'; };
    const dialog = await app.open();
    await app.byText('Как вам эта сцена?').fire('click');
    assert.equal(dialog.querySelector('.bts-question').value, 'Как вам эта сцена?');
    assert.equal(app.state.calls, 0);
    const npcName = dialog.querySelectorAll('input').find(node => node.maxLength === 100);
    npcName.value = 'Ева';
    await app.byText('Добавить NPC').fire('click');
    await app.byText('Спросить').fire('click');
    await flush();
    assert.match(prompt.systemPrompt, /Тайлер, Ева/);
});

test('API failure preserves question and enables retry without duplicate turns', async () => {
    const app = setup();
    app.context().generateRaw = async () => { throw new Error('Offline'); };
    const dialog = await app.open();
    const input = dialog.querySelector('.bts-question');
    input.value = 'Вопрос';
    await app.byText('Спросить').fire('click');
    await flush();
    assert.equal(input.value, 'Вопрос');
    assert.equal(input.disabled, false);
    assert.equal(core.getStore(app.context().chatMetadata).sessions[0].messages.length, 0);
    app.context().generateRaw = async () => 'Повторный ответ';
    await app.byText('Спросить').fire('click');
    await flush();
    assert.equal(core.getStore(app.context().chatMetadata).sessions[0].messages.length, 2);
});

test('chat switch closes window and late response never leaks into either chat', async () => {
    const app = setup();
    let finish;
    app.context().generateRaw = () => new Promise(resolve => { finish = resolve; });
    const dialog = await app.open();
    const oldStore = core.getStore(app.context().chatMetadata);
    dialog.querySelector('.bts-question').value = 'Вопрос';
    await app.byText('Спросить').fire('click');
    await flush();
    app.switchChat();
    assert.equal(app.body.querySelector('dialog'), null);
    finish('Поздний ответ');
    await flush();
    assert.equal(oldStore.sessions[0].messages.length, 0);
    assert.equal(core.getStore(app.context().chatMetadata).sessions.length, 0);
    assert.equal(app.errors.length, 0);
});

test('disable removes message buttons; enable reinstates them', async () => {
    const app = setup();
    const checkbox = app.document.getElementById('bts-panel').querySelector('input');
    checkbox.checked = false;
    await checkbox.fire('change');
    assert.equal(app.body.querySelectorAll('.bts-interview-btn').length, 0);
    checkbox.checked = true;
    await checkbox.fire('change');
    assert.equal(app.body.querySelectorAll('.bts-interview-btn').length, 1);
});

test('opens when context provides getCurrentChatId but no chatId property', async () => {
    const app = setup();
    delete app.context().chatId;
    app.context().getCurrentChatId = () => 'legacy-chat';
    const dialog = await app.open();
    assert.ok(dialog?.open);
    assert.equal(app.errors.length, 0);
    assert.equal(app.state.calls, 0);
});

test('opens with selected character and messages even without either chat ID API', async () => {
    const app = setup();
    delete app.context().chatId;
    const dialog = await app.open();
    assert.ok(dialog?.open);
    assert.equal(app.errors.length, 0);
});