import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MODULE_NAME, normalizeSettings, createSession, getStore, participantFromCard,
    buildRequest, requestInterview, generateTurn, StaleInterviewError,
    collectSceneParticipants, mergeParticipants, parseDetectedParticipants, buildDetectionRequest,
} from '../interview-core.mjs';

function fixture() {
    const session = createSession([{ name: 'Тайлер', mes: 'Сцена' }], 0, normalizeSettings());
    session.participants = [
        { name: 'Тайлер', description: 'Ироничный', selected: true },
        { name: 'Ева', description: 'Весёлая', selected: true },
        { name: 'Другой', description: 'Не участвует', selected: false },
    ];
    return session;
}

test('scene suggestions include persona, mentioned cards and speakers without unrelated cards', () => {
    const session = fixture();
    session.scene = 'Тайлер посмотрел на Еву. Ева улыбнулась.';
    const context = {
        chat: [{ name: 'Тайлер', mes: session.scene }], name1: 'Ева',
        powerUserSettings: { persona_description: 'Персона пользователя' },
        characters: [{ name: 'Тайлер' }, { name: 'Ева' }, { name: 'Неизвестный' }],
    };
    const participants = collectSceneParticipants(context, session);
    assert.deepEqual(participants.map(p => p.name), ['Ева', 'Тайлер']);
    assert.equal(participants[0].kind, 'persona');
    assert.equal(participants[0].description, 'Персона пользователя');
});

test('detection JSON is validated, duplicates preserve manual selection and descriptions', () => {
    const session = fixture();
    session.participants[0].selected = false;
    const data = parseDetectedParticipants('```json\n[{"name":" тайлер ","description":"Другой"},{"name":"Официант"},null,{}]\n```');
    mergeParticipants(session, data);
    assert.equal(session.participants.length, 4);
    assert.equal(session.participants[0].selected, false);
    assert.equal(session.participants[0].description, 'Ироничный');
    assert.equal(session.participants.at(-1).name, 'Официант');
    assert.throws(() => parseDetectedParticipants('не JSON'));
    assert.throws(() => parseDetectedParticipants('{}'));
    session.includeContext = false;
    session.context = 'Скрытый контекст';
    assert.doesNotMatch(JSON.stringify(buildDetectionRequest(session)), /Скрытый контекст/);
});

test('defaults fill partial old settings and clamp response limit', () => {
    assert.equal(normalizeSettings({ enabled: false }).responseLength, 240);
    assert.equal(normalizeSettings({ enabled: false }).enabled, false);
    assert.equal(normalizeSettings({ responseLength: 9000 }).responseLength, 800);
    assert.equal(normalizeSettings({ responseLength: -20 }).responseLength, 80);
    assert.equal(normalizeSettings({ responseLength: 'invalid' }).responseLength, 240);
});

test('scene is a snapshot and original chat stays untouched', () => {
    const chat = [{ name: 'Ева', mes: 'До' }, { name: 'Тайлер', mes: 'Сцена' }, { name: 'Ева', mes: 'После' }];
    const original = structuredClone(chat);
    const session = createSession(chat, 1, normalizeSettings());
    assert.deepEqual(chat, original);
    assert.equal(session.scene, 'Сцена');
    assert.match(session.context, /До/);
    chat[1].mes = 'Изменено';
    assert.equal(session.scene, 'Сцена');
    assert.throws(() => createSession(chat, 100, normalizeSettings()), /не найдено/);
});

test('legacy interviews migrate once, preserve backup, isolate chats', () => {
    const history = [{ character: 'Тайлер', interview: 'Ответ', scene: 'Сцена', context: 'Контекст' }];
    const metadata = { [MODULE_NAME]: { history } };
    const store = getStore(metadata);
    assert.equal(store.sessions[0].messages[0].content, 'Ответ');
    assert.equal(store.history, history);
    const id = store.sessions[0].id;
    assert.equal(getStore(metadata).sessions[0].id, id);
    assert.deepEqual(getStore({}).sessions, []);
    const restored = JSON.parse(JSON.stringify(metadata));
    assert.equal(getStore(restored).sessions[0].messages[0].content, 'Ответ');
});

test('prompt includes selected participants, conversation and final question', () => {
    const session = fixture();
    session.messages.push({ role: 'user', content: 'Первый вопрос' }, { role: 'assistant', content: 'Первый ответ' });
    const request = buildRequest(session, '  Как вам эта сцена?  ');
    assert.deepEqual(request.participants, ['Тайлер', 'Ева']);
    assert.match(request.messages[0].content, /1–2 коротких/);
    assert.doesNotMatch(JSON.stringify(request), /Не участвует/);
    assert.equal(request.messages.at(-1).content, 'Как вам эта сцена?');
    assert.equal(request.messages.at(-2).content, 'Первый ответ');
    assert.equal(request.maxTokens, 240);
    session.includeContext = false;
    session.context = 'Секретный соседний контекст';
    assert.doesNotMatch(JSON.stringify(buildRequest(session, 'Вопрос')), /Секретный/);
});

test('history sent to API is limited to last 20 messages, stored history remains', () => {
    const session = fixture();
    session.messages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `message-${i}` }));
    assert.equal(buildRequest(session, 'Вопрос').messages.length, 23);
    assert.equal(session.messages.length, 60);
});

test('empty question and empty selection are rejected before request', () => {
    const session = fixture();
    assert.throws(() => buildRequest(session, ' '), /Введите/);
    session.participants.forEach(p => p.selected = false);
    assert.throws(() => buildRequest(session, 'Вопрос'), /участника/);
});

test('card snapshot includes description/personality but not secret connection data', () => {
    const result = participantFromCard({ avatar: 'eva.png', name: 'Ева', data: { description: 'Актриса', personality: 'Весёлая' } });
    assert.equal(result.avatar, 'eva.png');
    assert.equal(result.description, 'Актриса\nВесёлая');
    assert.equal(result.selected, true);
});

test('main API uses raw generation, a length limit and no story mutations', async () => {
    const chat = [{ mes: 'Сюжет' }];
    let args;
    const context = { chat, generateRaw: async value => { args = value; return ' Ответ '; } };
    const request = buildRequest(fixture(), 'Вопрос');
    assert.equal(await requestInterview(context, '', request), 'Ответ');
    assert.equal(args.responseLength, 240);
    assert.equal(args.trimNames, false);
    assert.equal(args.systemPrompt, request.messages[0].content);
    assert.deepEqual(chat, [{ mes: 'Сюжет' }]);
});

test('separate profile uses service with profile ID, never switches selected profile', async () => {
    let args;
    const context = {
        extensionSettings: { connectionManager: { selectedProfile: 'main', profiles: [{ id: 'interview' }] } },
        ConnectionManagerRequestService: { sendRequest: async (...values) => { args = values; return { content: 'Профильный ответ' }; } },
        generateRaw: () => { throw new Error('Main connection must not be used'); },
    };
    const controller = new AbortController();
    const result = await requestInterview(context, 'interview', buildRequest(fixture(), 'Вопрос'), controller.signal);
    assert.equal(result, 'Профильный ответ');
    assert.equal(args[0], 'interview');
    assert.equal(args[2], 240);
    assert.equal(args[3].signal, controller.signal);
    assert.equal(args[3].includePreset, true);
    assert.equal(context.extensionSettings.connectionManager.selectedProfile, 'main');
    await assert.rejects(requestInterview(context, 'deleted', buildRequest(fixture(), 'Вопрос')), /удалён/);
    await assert.rejects(requestInterview({}, 'interview', buildRequest(fixture(), 'Вопрос')), /недоступен/);
});

test('empty responses, failures and aborted requests do not commit a turn', async () => {
    const session = fixture();
    const request = buildRequest(session, 'Вопрос');
    await assert.rejects(requestInterview({ generateRaw: async () => '' }, '', request), /пустой/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(requestInterview({ generateRaw: async () => 'Ответ' }, '', request, controller.signal), /отменена/);
    await assert.rejects(generateTurn(session, 'Вопрос', async () => { throw new Error('Offline'); }, () => true), /Offline/);
    assert.deepEqual(session.messages, []);
});

test('late response after chat switch or window close is discarded', async () => {
    const session = fixture();
    await assert.rejects(generateTurn(session, 'Вопрос', async () => 'Поздний ответ', () => false), StaleInterviewError);
    assert.deepEqual(session.messages, []);
});

test('one successful generation commits exactly one question and one multi-participant answer', async () => {
    const session = fixture();
    let calls = 0;
    await generateTurn(session, ' Вопрос ', async () => { calls++; return 'Тайлер: *фыркнул* «Да».\nЕва: *смеётся* «Точно». '; }, () => true);
    assert.equal(calls, 1);
    assert.equal(session.messages.length, 2);
    assert.equal(session.messages[0].content, 'Вопрос');
    assert.deepEqual(session.messages[1].participants, ['Тайлер', 'Ева']);
});