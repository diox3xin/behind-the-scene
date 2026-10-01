import { getContext } from '../../../extensions.js';
import { requestMainStream } from './main-stream.mjs';
import {
    MODULE_NAME, QUICK_QUESTIONS, createId, normalizeSettings, createSession,
    getStore, participantFromCard, requestInterview, beginTurn, finishTurn, discardTurn, streamInterview, StaleInterviewError,
    collectSceneParticipants, mergeParticipants, buildDetectionRequest, parseDetectedParticipants, describeApiError,
} from './interview-core.mjs';

let settings;
let activeWindow = null;
let chatEpoch = 0;
let requestInFlight = false;
let mainGenerating = false;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(text, onClick, className = '') {
    const node = element('button', `menu_button ${className}`, text);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

function reportError(error) {
    const details = describeApiError(error);
    console.error('[Behind the Scene]', { message: details });
    toastr.error(details, 'Behind the Scene', { escapeHtml: true });
}

function chatKey(context = getContext()) {
    const currentId = context.getCurrentChatId?.() ?? context.chatId;
    if (currentId !== undefined && currentId !== null && currentId !== '') return String(currentId);
    if (context.chatMetadata?.integrity) return `metadata:${context.chatMetadata.integrity}`;
    return `context:${context.characterId ?? 'none'}:${context.groupId ?? 'none'}`;
}

function hasChat(context = getContext()) {
    const id = context.getCurrentChatId?.() ?? context.chatId;
    return Array.isArray(context.chat) && (
        (id !== undefined && id !== null && id !== '')
        || (context.chat.length > 0 && (context.characterId !== undefined && context.characterId !== null
            || context.groupId !== undefined && context.groupId !== null))
    );
}

function captureChat() {
    const context = getContext();
    return { metadata: context.chatMetadata, id: chatKey(context), character: context.characterId, group: context.groupId, epoch: chatEpoch };
}

function sameChat(snapshot) {
    const context = getContext();
    return snapshot.epoch === chatEpoch && snapshot.metadata === context.chatMetadata
        && snapshot.id === chatKey(context) && snapshot.character === context.characterId && snapshot.group === context.groupId;
}

async function persist(snapshot = captureChat()) {
    if (!sameChat(snapshot) || !hasChat()) return;
    await getContext().saveMetadata();
}

function saveSettings() {
    getContext().extensionSettings[MODULE_NAME] = settings;
    getContext().saveSettingsDebounced();
}

function closeInterview() {
    if (!activeWindow) return;
    const view = activeWindow;
    activeWindow = null;
    view.controller?.abort();
    if (view.turn?.assistant.pending) {
        view.turn.assistant.pending = false;
        view.turn.assistant.failed = true;
        view.turn.user.failed = true;
        view.turn.assistant.error = 'Окно закрыто. Ответ прерван.';
        if (sameChat(view.snapshot)) void persist(view.snapshot).catch(reportError);
    }
    view.viewportCleanup?.();
    view.backdrop?.remove();
    document.removeEventListener('keydown', view.keyHandler);
    view.dialog.close?.();
    view.dialog.removeAttribute('open');
    view.dialog.remove();
}

// Only *emphasis* is interpreted. HTML and model-generated scripts remain text.
function appendContent(node, text) {
    for (const part of String(text).split(/(\*[^*\n]+\*)/g)) {
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2) node.append(element('em', '', part.slice(1, -1)));
        else node.append(document.createTextNode(part));
    }
}

function renderMessages(view, forceScroll = true) {
    const scrollTop = view.log.scrollTop;
    const follow = forceScroll || view.log.scrollHeight - scrollTop - view.log.clientHeight < 80;
    view.log.replaceChildren();
    view.messageNodes = new Map();
    if (!view.session.messages.length) view.log.append(element('p', 'bts-muted', 'Задайте первый вопрос. Основной сюжетный чат останется без изменений.'));
    for (const message of view.session.messages) {
        const bubble = element('article', `bts-bubble bts-${message.role}`);
        bubble.append(element('strong', '', message.role === 'user' ? 'Вы — интервьюер' : 'За кулисами'));
        if (message.participants?.length) bubble.append(element('small', 'bts-muted', `Участники: ${message.participants.join(', ')}`));
        const content = element('div', 'bts-message-text');
        appendContent(content, message.content);
        bubble.append(content);
        view.messageNodes.set(message, content);
        if (message.pending) bubble.append(element('small', 'bts-typing', message.content ? 'Печатает…' : 'Ожидание первых слов…'));
        if (message.error) bubble.append(element('small', 'bts-error', message.error));
        if (message.role === 'assistant' && message.failed && !view.busy) {
            const index = view.session.messages.indexOf(message);
            const user = view.session.messages[index - 1];
            if (user?.role === 'user') bubble.append(button('Повторить вопрос', () => {
                if (view.busy || requestInFlight) return;
                view.input.value = user.content;
                discardTurn(view.session, { user, assistant: message });
                void sendQuestion(view);
            }));
        }
        view.log.append(bubble);
    }
    view.log.scrollTop = follow ? view.log.scrollHeight : scrollTop;
}

function updateStreamBubble(view, message) {
    const follow = view.log.scrollHeight - view.log.scrollTop - view.log.clientHeight < 80;
    const content = view.messageNodes.get(message);
    if (!content) return;
    // Preserve the bubble and scroll position rather than rebuilding the transcript per token.
    content.replaceChildren();
    appendContent(content, message.content);
    if (follow) view.log.scrollTop = view.log.scrollHeight;
}

function remember(view) {
    if (!sameChat(view.snapshot)) return;
    void persist(view.snapshot).catch(reportError);
    renderHistory();
}

function renderParticipants(view) {
    view.participants.replaceChildren();
    if (!view.session.participants.length) view.participants.append(element('p', 'bts-muted', 'Добавьте персонажа из карточек или NPC вручную.'));
    for (const participant of view.session.participants) {
        const row = element('div', 'bts-participant');
        const label = element('label', 'checkbox_label');
        const check = element('input');
        check.type = 'checkbox';
        check.checked = participant.selected;
        check.addEventListener('change', () => { participant.selected = check.checked; remember(view); });
        const source = { persona: 'персона', card: 'карточка', npc: 'NPC' }[participant.kind];
        label.append(check, document.createTextNode(`${participant.name}${source ? ` (${source})` : ''}`));
        label.title = participant.description || 'Описание не задано';
        const remove = button('×', () => {
            view.session.participants = view.session.participants.filter(p => p.id !== participant.id);
            renderParticipants(view);
            remember(view);
        });
        remove.setAttribute('aria-label', `Убрать ${participant.name}`);
        row.append(label, remove);
        view.participants.append(row);
    }
}

function fillProfiles(select, value) {
    select.replaceChildren(new Option('Основное подключение SillyTavern', ''));
    const context = getContext();
    for (const profile of context.extensionSettings.connectionManager?.profiles || []) {
        const option = new Option(`${profile.name || profile.id}${profile.proxy ? ` · прокси: ${profile.proxy}` : ''}`, profile.id);
        option.disabled = !context.ConnectionManagerRequestService?.sendRequest
            || context.extensionSettings.disabledExtensions?.includes('connection-manager');
        select.add(option);
    }
    if (value && !Array.from(select.options).some(o => o.value === value)) select.add(new Option('Профиль удалён — выберите другой', value));
    select.value = value;
}

function labeled(text, control) {
    const label = element('label', 'bts-field');
    label.append(element('span', '', text), control);
    return label;
}

async function detectParticipants(view) {
    if (activeWindow !== view || !sameChat(view.snapshot) || view.busy) return;
    if (requestInFlight || mainGenerating) {
        view.detectionStatus.textContent = 'Распознавание отложено: идёт генерация. Нажмите «Найти NPC в сцене» после её окончания.';
        return;
    }
    view.busy = true;
    requestInFlight = true;
    view.controls.disabled = true;
    view.send.disabled = true;
    view.controller = new AbortController();
    view.stop.hidden = false;
    view.stop.disabled = false;
    view.detectionStatus.textContent = 'Ищу участников и NPC в тексте сцены…';
    try {
        const text = await requestInterview(getContext(), view.session.profileId, buildDetectionRequest(view.session), view.controller.signal);
        if (activeWindow !== view || !sameChat(view.snapshot)) return;
        mergeParticipants(view.session, parseDetectedParticipants(text));
        renderParticipants(view);
        remember(view);
        view.detectionStatus.textContent = 'Участники найдены. Проверьте галочки: модель может ошибаться.';
    } catch (error) {
        if (activeWindow === view && sameChat(view.snapshot)) {
            view.detectionStatus.textContent = view.controller.signal.aborted
                ? 'Поиск NPC остановлен. Можно задать вопрос выбранным участникам.'
                : `Не удалось найти NPC: ${describeApiError(error)} Можно повторить или добавить вручную.`;
            console.warn('[Behind the Scene] Participant detection:', describeApiError(error));
        }
    } finally {
        view.busy = false;
        requestInFlight = false;
        view.controls.disabled = false;
        view.send.disabled = false;
        view.stop.hidden = true;
    }
}

async function hydrateParticipants(view) {
    // Load shallow cards after showing the window, never before a mobile tap opens it.
    for (const participant of view.session.participants) {
        if (!participant.avatar) continue;
        const id = Object.keys(getContext().characters || {}).find(key => getContext().characters[key]?.avatar === participant.avatar);
        if (id === undefined) continue;
        try {
            await getContext().unshallowCharacter?.(id);
            if (activeWindow !== view || !sameChat(view.snapshot)) return;
            const card = getContext().characters[id];
            if (card?.avatar === participant.avatar) participant.description = participantFromCard(card).description;
        } catch (error) { console.warn('[Behind the Scene] Card details unavailable', error); }
    }
    if (activeWindow === view && sameChat(view.snapshot)) {
        renderParticipants(view);
        remember(view);
    }
}

function showInterviewWindow(view) {
    const dialog = view.dialog;
    // Preserve native modality where supported; fall back to a fixed accessible overlay.
    try {
        if (typeof dialog.showModal !== 'function') throw new Error('Native dialog unavailable');
        dialog.showModal();
    } catch (error) {
        console.info('[Behind the Scene] Using mobile dialog fallback:', error.message);
        dialog.className += ' bts-dialog-fallback';
        dialog.setAttribute('open', '');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        view.backdrop = element('div', 'bts-backdrop');
        document.body.append(view.backdrop);
    }
    view.keyHandler = event => {
        if (event.key === 'Escape') { event.preventDefault(); closeInterview(); }
        if (event.key === 'Tab') {
            const nodes = Array.from(dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary'));
            const first = nodes[0];
            const last = nodes.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    };
    document.addEventListener('keydown', view.keyHandler);
    const viewport = globalThis.visualViewport;
    if (viewport) {
        const resize = () => {
            dialog.style.setProperty('--bts-viewport-height', `${viewport.height}px`);
            dialog.style.setProperty('--bts-viewport-top', `${viewport.offsetTop}px`);
        };
        resize();
        viewport.addEventListener('resize', resize);
        viewport.addEventListener('scroll', resize);
        view.viewportCleanup = () => {
            viewport.removeEventListener('resize', resize);
            viewport.removeEventListener('scroll', resize);
        };
    }
}

async function sendQuestion(view) {
    if (view.busy || requestInFlight) return toastr.warning('Дождитесь завершения текущего запроса интервью.');
    if (!settings.enabled || !sameChat(view.snapshot)) return;
    if (mainGenerating) return toastr.warning('Сначала дождитесь ответа в основном чате.');
    const question = view.input.value.trim();
    if (!question) return view.input.focus();
    if (!view.session.participants.some(p => p.selected)) return toastr.warning('Выберите хотя бы одного участника.');
    const turn = beginTurn(view.session, question);
    view.turn = turn;
    view.busy = true;
    requestInFlight = true;
    view.controls.disabled = true;
    view.input.disabled = true;
    view.send.disabled = true;
    view.controller = new AbortController();
    view.stop.hidden = false;
    view.stop.disabled = false;
    view.input.value = '';
    view.status.textContent = 'Ожидание ответа модели…';
    renderMessages(view);
    void persist(view.snapshot).catch(reportError);
    try {
        let answer = '';
        for await (const text of streamInterview(getContext(), view.session.profileId, turn.request, view.controller.signal, requestMainStream)) {
            if (activeWindow !== view || !sameChat(view.snapshot)) throw new StaleInterviewError();
            // ST yields cumulative snapshots, not token deltas.
            answer = text;
            turn.assistant.content = text;
            view.status.textContent = 'Получаем ответ…';
            updateStreamBubble(view, turn.assistant);
        }
        if (activeWindow !== view || !sameChat(view.snapshot)) throw new StaleInterviewError();
        finishTurn(turn, answer);
        renderMessages(view);
        await persist(view.snapshot);
        renderHistory();
        view.status.textContent = 'Ответ готов.';
    } catch (error) {
        turn.user.failed = true;
        turn.assistant.pending = false;
        turn.assistant.failed = true;
        turn.assistant.error = view.controller.signal.aborted ? 'Генерация остановлена.' : describeApiError(error);
        if (activeWindow === view && sameChat(view.snapshot) && !(error instanceof StaleInterviewError)) {
            view.status.textContent = `Не удалось получить ответ: ${describeApiError(error)}. Вопрос можно отправить повторно.`;
            if (!view.controller.signal.aborted) reportError(error);
            await persist(view.snapshot).catch(reportError);
        }
    } finally {
        view.busy = false;
        requestInFlight = false;
        view.controls.disabled = false;
        view.input.disabled = false;
        view.send.disabled = false;
        view.stop.hidden = true;
        view.turn = null;
        if (activeWindow === view) { renderMessages(view, false); view.input.focus(); }
    }
}

function openInterview(session) {
    console.info('[Behind the Scene] Opening mini-chat', { sessionId: session.id, chat: chatKey() });
    closeInterview();
    // A page reload cannot resume a saved network request.
    session.messages.forEach((message, index) => {
        if (!message.pending) return;
        message.pending = false;
        message.failed = true;
        message.error = 'Предыдущая генерация была прервана.';
        if (session.messages[index - 1]?.role === 'user') session.messages[index - 1].failed = true;
    });
    const dialog = element('dialog', 'bts-dialog');
    dialog.setAttribute('aria-labelledby', 'bts-dialog-title');
    const header = element('header', 'bts-dialog-header');
    const title = element('h3', '', '🎬 За кулисами');
    title.id = 'bts-dialog-title';
    header.append(title, button('Закрыть', closeInterview));
    const body = element('div', 'bts-dialog-body');
    const sidebar = element('aside', 'bts-sidebar');
    const controls = element('fieldset', 'bts-controls');
    const view = { session, dialog, controls, snapshot: captureChat(), busy: false };
    activeWindow = view;
    const scene = element('details', 'bts-scene');
    scene.append(element('summary', '', `Сцена: ${session.sceneName}`), element('div', 'bts-message-text', session.scene));
    controls.append(scene, element('h4', '', 'Кого спросить?'));
    view.participants = element('div', 'bts-participants');
    controls.append(view.participants);
    renderParticipants(view);
    view.detectionStatus = element('div', 'bts-muted', 'Участники из карточек и персона доступны сразу. Поиск NPC использует выбранное подключение.');
    view.detectionStatus.setAttribute('role', 'status');
    controls.append(button('Найти NPC в сцене', () => void detectParticipants(view)), view.detectionStatus);

    const cardSelect = element('select', 'text_pole');
    cardSelect.add(new Option('Выберите карточку…', ''));
    Object.entries(getContext().characters || {}).forEach(([id, card]) => {
        if (card) cardSelect.add(new Option(card.name || `Персонаж ${id}`, id));
    });
    const addCard = button('Добавить персонажа', async () => {
        if (!cardSelect.value) return;
        const id = cardSelect.value;
        addCard.disabled = true;
        try {
            await getContext().unshallowCharacter?.(id);
            if (activeWindow !== view || !sameChat(view.snapshot)) return;
            const card = getContext().characters[id];
            if (!card) throw new Error('Карточка не найдена.');
            if (session.participants.some(p => p.avatar && p.avatar === card.avatar)) return toastr.info('Персонаж уже добавлен.');
            session.participants.push(participantFromCard(card));
            renderParticipants(view);
            remember(view);
        } catch (error) { reportError(error); }
        finally { addCard.disabled = false; }
    });
    controls.append(labeled('Из карточек SillyTavern', cardSelect), addCard);
    const npcDetails = element('details');
    npcDetails.append(element('summary', '', 'Добавить NPC вручную'));
    const npcName = element('input', 'text_pole');
    npcName.maxLength = 100;
    const npcDescription = element('textarea', 'text_pole');
    npcDescription.rows = 3;
    npcDescription.maxLength = 6000;
    npcDetails.append(labeled('Имя NPC', npcName), labeled('Характер и роль (необязательно)', npcDescription), button('Добавить NPC', () => {
        if (!npcName.value.trim()) return npcName.focus();
        session.participants.push({ id: createId(), name: npcName.value.trim(), description: npcDescription.value.trim(), selected: true });
        npcName.value = '';
        npcDescription.value = '';
        renderParticipants(view);
        remember(view);
    }));
    controls.append(npcDetails);
    const profile = element('select', 'text_pole');
    fillProfiles(profile, session.profileId);
    profile.addEventListener('change', () => {
        session.profileId = profile.value;
        settings.profileId = profile.value;
        saveSettings();
        remember(view);
    });
    controls.append(labeled('Подключение для интервью', profile), button('Обновить список подключений', () => fillProfiles(profile, session.profileId)),
        element('small', 'bts-muted', 'Отдельный API/прокси настройте в Connection Manager. Основное подключение не переключается. Ключи здесь не хранятся.'));
    const length = element('input', 'text_pole');
    length.type = 'number';
    length.min = '80';
    length.max = '800';
    length.step = '20';
    length.value = session.responseLength;
    length.addEventListener('change', () => {
        session.responseLength = normalizeSettings({ responseLength: length.value }).responseLength;
        length.value = session.responseLength;
        settings.responseLength = session.responseLength;
        saveSettings();
        remember(view);
    });
    controls.append(labeled('Лимит токенов на весь ответ', length));
    const include = element('input');
    include.type = 'checkbox';
    include.checked = session.includeContext;
    include.addEventListener('change', () => { session.includeContext = include.checked; remember(view); });
    controls.append(labeled('Учитывать соседние сообщения сцены', include));
    sidebar.append(controls);

    const conversation = element('section', 'bts-conversation');
    view.log = element('div', 'bts-chat-log');
    view.log.setAttribute('role', 'log');
    view.log.setAttribute('aria-label', 'История интервью');
    const quick = element('div', 'bts-quick-questions');
    QUICK_QUESTIONS.forEach(question => quick.append(button(question, () => {
        if (view.busy) return;
        view.input.value = question;
        view.input.focus();
    })));
    view.input = element('textarea', 'text_pole bts-question');
    view.input.rows = 3;
    view.input.maxLength = 4000;
    view.input.placeholder = 'Ваш вопрос…';
    view.input.setAttribute('aria-label', 'Ваш вопрос участникам интервью');
    view.input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void sendQuestion(view);
        }
    });
    view.send = button('Спросить', () => void sendQuestion(view));
    view.stop = button('Остановить', () => {
        view.controller?.abort();
        view.stop.disabled = true;
        view.status.textContent = 'Останавливаем запрос… Для старого основного API нужно дождаться его завершения.';
    });
    view.stop.hidden = true;
    view.status = element('div', 'bts-status', 'Enter — отправить, Shift+Enter — новая строка.');
    view.status.setAttribute('role', 'status');
    conversation.append(view.log, quick, view.input, view.send, view.stop, view.status);
    body.append(sidebar, conversation);
    dialog.append(header, body);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeInterview(); });
    document.body.append(dialog);
    renderMessages(view);
    showInterviewWindow(view);
    // Don't summon the phone keyboard before the user can choose participants.
    if (!globalThis.matchMedia?.('(pointer: coarse)').matches) view.input.focus();
    return view;
}

async function startInterview(messageIndex) {
    if (!settings.enabled || !hasChat()) {
        console.warn('[Behind the Scene] Cannot open mini-chat: no active SillyTavern chat context.');
        toastr.warning('Не удалось определить открытый чат. Откройте чат с персонажем и повторите.');
        return;
    }
    console.info('[Behind the Scene] Scene button clicked', { messageIndex, chat: chatKey() });
    const snapshot = captureChat();
    try {
        const context = getContext();
        const session = createSession(context.chat, messageIndex, settings);
        mergeParticipants(session, collectSceneParticipants(context, session));
        getStore(getContext().chatMetadata).sessions.unshift(session);
        const view = openInterview(session);
        renderHistory();
        void hydrateParticipants(view);
        if (settings.autoDetect !== false) void detectParticipants(view);
        await persist(snapshot);
    } catch (error) { reportError(error); }
}

function renderHistory() {
    const list = document.getElementById('bts-interview-list');
    if (!list) return;
    list.replaceChildren();
    if (!hasChat()) return list.append(element('p', 'bts-muted', 'Откройте чат, чтобы увидеть его интервью.'));
    const store = getStore(getContext().chatMetadata);
    if (!store.sessions.length) list.append(element('p', 'bts-muted', 'Нажмите 🎬 у сообщения сцены, чтобы начать интервью.'));
    for (const session of store.sessions) {
        const row = element('div', 'bts-history-item');
        row.append(element('strong', '', session.sceneName), element('small', '', new Date(session.timestamp).toLocaleString('ru-RU')),
            element('p', '', session.scene.slice(0, 100)));
        const open = button('Открыть', () => openInterview(session));
        open.disabled = !settings.enabled;
        row.append(open, button('Удалить', () => {
            if (!confirm('Удалить это интервью?')) return;
            if (activeWindow?.session === session) closeInterview();
            store.sessions = store.sessions.filter(item => item !== session);
            void persist().catch(reportError);
            renderHistory();
        }));
        list.append(row);
    }
}

function syncButtons() {
    document.querySelectorAll('.mes').forEach(message => {
        const old = message.querySelector('.bts-interview-btn');
        if (!settings.enabled) { old?.remove(); return; }
        if (old) return;
        const target = message.querySelector('.mes_buttons');
        if (!target) return;
        const action = button('🎬', event => {
            event.stopPropagation();
            void startInterview(Number(message.getAttribute('mesid')));
        }, 'bts-interview-btn');
        action.title = 'Открыть закулисный мини-чат';
        action.setAttribute('aria-label', action.title);
        target.append(action);
    });
}

function createUI() {
    const panel = element('div');
    panel.id = 'bts-panel';
    const drawer = element('details');
    drawer.append(element('summary', '', '🎬 Behind the Scenes — мини-чат'));
    const enabled = element('input');
    enabled.type = 'checkbox';
    enabled.checked = settings.enabled;
    enabled.addEventListener('change', () => {
        settings.enabled = enabled.checked;
        saveSettings();
        if (!settings.enabled) closeInterview();
        syncButtons();
        renderHistory();
    });
    drawer.append(labeled('Включить расширение', enabled));
    const autoDetect = element('input');
    autoDetect.type = 'checkbox';
    autoDetect.checked = settings.autoDetect !== false;
    autoDetect.addEventListener('change', () => { settings.autoDetect = autoDetect.checked; saveSettings(); });
    drawer.append(labeled('Автоматически искать NPC моделью при открытии (дополнительный запрос)', autoDetect));
    drawer.append(button('🎬 Интервью по последнему сообщению', () => {
        const chat = getContext().chat || [];
        if (!chat.length) return toastr.warning('Откройте чат с сообщениями.');
        void startInterview(chat.length - 1);
    }));
    const list = element('div');
    list.id = 'bts-interview-list';
    drawer.append(element('h4', '', 'Интервью текущего чата'), list);
    panel.append(drawer);
    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!target) throw new Error('Контейнер настроек расширений не найден.');
    target.append(panel);
    renderHistory();
}

jQuery(() => {
    try {
        const context = getContext();
        settings = normalizeSettings(context.extensionSettings[MODULE_NAME]);
        context.extensionSettings[MODULE_NAME] = settings;
        createUI();
        syncButtons();
        const events = context.eventTypes || context.event_types;
        const on = (name, handler) => { if (events?.[name]) context.eventSource.on(events[name], handler); };
        on('CHAT_CHANGED', () => { chatEpoch++; closeInterview(); renderHistory(); syncButtons(); });
        for (const name of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MORE_MESSAGES_LOADED', 'MESSAGE_SWIPED']) on(name, syncButtons);
        on('GENERATION_STARTED', (_type, _options, dryRun) => { if (!dryRun) mainGenerating = true; });
        on('GENERATION_ENDED', () => { mainGenerating = false; });
        on('GENERATION_STOPPED', () => { mainGenerating = false; });
        $(document).on('mouseenter.bts focusin.bts', '.mes', syncButtons);
        // Themes may clone controls, losing direct listeners. Delegation covers those taps.
        $(document).on('click.bts', '.bts-interview-btn', function(event) {
            event.preventDefault();
            event.stopPropagation();
            const message = this.closest('.mes');
            if (message) void startInterview(Number(message.getAttribute('mesid')));
        });
        const chatNode = document.getElementById('chat');
        if (chatNode && typeof MutationObserver !== 'undefined') {
            new MutationObserver(syncButtons).observe(chatNode, { childList: true, subtree: true });
        }
        console.log('[Behind the Scene] Mini-chat v2.2.0 loaded');
    } catch (error) { reportError(error); }
});

export { MODULE_NAME };