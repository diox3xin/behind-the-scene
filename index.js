import { getContext } from '../../../extensions.js';
import {
    MODULE_NAME, QUICK_QUESTIONS, createId, normalizeSettings, createSession,
    getStore, participantFromCard, requestInterview, generateTurn, StaleInterviewError,
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
    console.error('[Behind the Scene]', error);
    toastr.error(error.message || String(error), 'Behind the Scene');
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

function renderMessages(view) {
    view.log.replaceChildren();
    if (!view.session.messages.length) view.log.append(element('p', 'bts-muted', 'Задайте первый вопрос. Основной сюжетный чат останется без изменений.'));
    for (const message of view.session.messages) {
        const bubble = element('article', `bts-bubble bts-${message.role}`);
        bubble.append(element('strong', '', message.role === 'user' ? 'Вы — интервьюер' : 'За кулисами'));
        if (message.participants?.length) bubble.append(element('small', 'bts-muted', `Участники: ${message.participants.join(', ')}`));
        const content = element('div', 'bts-message-text');
        appendContent(content, message.content);
        bubble.append(content);
        view.log.append(bubble);
    }
    view.log.scrollTop = view.log.scrollHeight;
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
        label.append(check, document.createTextNode(participant.name));
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

async function sendQuestion(view) {
    if (view.busy || requestInFlight) return toastr.warning('Дождитесь завершения текущего запроса интервью.');
    if (!settings.enabled || !sameChat(view.snapshot)) return;
    if (mainGenerating) return toastr.warning('Сначала дождитесь ответа в основном чате.');
    const question = view.input.value.trim();
    if (!question) return view.input.focus();
    if (!view.session.participants.some(p => p.selected)) return toastr.warning('Выберите хотя бы одного участника.');
    view.busy = true;
    requestInFlight = true;
    view.controls.disabled = true;
    view.input.disabled = true;
    view.send.disabled = true;
    view.controller = new AbortController();
    view.status.textContent = 'Генерация ответа…';
    try {
        await generateTurn(view.session, question,
            request => requestInterview(getContext(), view.session.profileId, request, view.controller.signal),
            () => activeWindow === view && sameChat(view.snapshot));
        view.input.value = '';
        renderMessages(view);
        await persist(view.snapshot);
        renderHistory();
        view.status.textContent = 'Ответ готов.';
    } catch (error) {
        if (activeWindow === view && sameChat(view.snapshot) && !(error instanceof StaleInterviewError)) {
            view.status.textContent = `Не удалось получить ответ: ${error.message}. Вопрос можно отправить повторно.`;
            reportError(error);
        }
    } finally {
        view.busy = false;
        requestInFlight = false;
        view.controls.disabled = false;
        view.input.disabled = false;
        view.send.disabled = false;
        if (activeWindow === view) view.input.focus();
    }
}

function openInterview(session) {
    console.info('[Behind the Scene] Opening mini-chat', { sessionId: session.id, chat: chatKey() });
    closeInterview();
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
    view.status = element('div', 'bts-status', 'Enter — отправить, Shift+Enter — новая строка.');
    view.status.setAttribute('role', 'status');
    conversation.append(view.log, quick, view.input, view.send, view.status);
    body.append(sidebar, conversation);
    dialog.append(header, body);
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeInterview(); });
    document.body.append(dialog);
    renderMessages(view);
    if (typeof dialog.showModal === 'function') {
        dialog.showModal();
    } else {
        // Compatibility fallback for browsers/themes that replace the dialog element.
        dialog.setAttribute('open', '');
    }
    view.input.focus();
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
        const cardId = Object.keys(context.characters || {}).find(id => context.characters[id]?.name === session.sceneName);
        if (cardId !== undefined) {
            await context.unshallowCharacter?.(cardId);
            if (!sameChat(snapshot)) return;
            session.participants.push(participantFromCard(getContext().characters[cardId]));
        } else if (!context.chat[messageIndex].is_user && !context.chat[messageIndex].is_system) {
            session.participants.push({ id: createId(), name: session.sceneName, description: '', selected: true });
        }
        getStore(getContext().chatMetadata).sessions.unshift(session);
        openInterview(session);
        renderHistory();
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
        on('GENERATION_STARTED', () => { mainGenerating = true; });
        on('GENERATION_ENDED', () => { mainGenerating = false; });
        $(document).on('mouseenter.bts focusin.bts', '.mes', syncButtons);
        console.log('[Behind the Scene] Mini-chat v2.0.1 loaded');
    } catch (error) { reportError(error); }
});

export { MODULE_NAME };