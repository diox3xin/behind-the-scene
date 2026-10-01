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

function setup() {
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
        chatMetadata: {}, extensionSettings: {},
        chat: [{ name: 'Тайлер', mes: '<img src=x onerror=alert(1)>Сцена', is_user: false }],
        characters: [{ name: 'Тайлер', avatar: 'tyler.png', data: { description: 'Ироничный' } }],
        saveMetadata: async () => { state.saves++; }, saveSettingsDebounced() {},
        generateRaw: async () => { state.calls++; return 'Тайлер: *фыркнул* «Интенсивно». <script>alert(1)</script>'; },
        eventTypes: Object.fromEntries(['CHAT_CHANGED', 'GENERATION_STARTED', 'GENERATION_ENDED'].map(name => [name, name])),
        eventSource: { on(name, listener) { events[name] = listener; } },
    };
    const document = {
        body, createElement: tag => new Node(tag),
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