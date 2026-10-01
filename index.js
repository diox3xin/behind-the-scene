(function() {
    'use strict';

    const extensionName = 'behind-the-scenes';
    const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

    let interviewHistory = [];

    const defaultSettings = {
        enabled: true,
        interviewStyle: 'casual',
        includeContext: true,
        maxInterviews: 50
    };

    function loadSettings() {
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        if (Object.keys(extension_settings[extensionName]).length === 0) {
            Object.assign(extension_settings[extensionName], defaultSettings);
        }
        
        if (chat_metadata[extensionName]) {
            interviewHistory = chat_metadata[extensionName].history || [];
        }
    }

    function saveSettings() {
        saveSettingsDebounced();
        chat_metadata[extensionName] = chat_metadata[extensionName] || {};
        chat_metadata[extensionName].history = interviewHistory;
    }

    async function generateInterview(messageIndex) {
        const context = SillyTavern.getContext();
        
        if (!context.chat || context.chat.length === 0) {
            toastr.warning('Нет сообщений для интервью');
            return;
        }
        
        const message = context.chat[messageIndex];
        if (!message) {
            toastr.warning('Сообщение не найдено');
            return;
        }
        
        const characterName = message.name || 'Персонаж';
        const sceneText = message.mes;
        const contextStart = Math.max(0, messageIndex - 2);
        const contextEnd = Math.min(context.chat.length, messageIndex + 3);
        const sceneContext = context.chat.slice(contextStart, contextEnd)
            .map(msg => `${msg.name}: ${msg.mes}`).join('\n\n');
        
        const interviewPrompt = `[Это закулисное интервью. ${characterName} — актёр/актриса, который(ая) только что сыграл(а) сцену в фильме/сериале. Веди себя как актёр, обсуждающий свою роль, эмоции, трудности съёмки и взаимодействие с партнёрами по съёмочной площадке.]

Интервьюер: Спасибо, что нашли время! Расскажите о сцене, которую вы только что сняли.

Сцена:
"${sceneText}"

${extension_settings[extensionName].includeContext ? `\nКонтекст сцены:\n${sceneContext}` : ''}

${characterName} (как актёр): `;

        const loadingToast = toastr.info('Генерация интервью...', '', { timeOut: 0 });
        
        try {
            const interview = await generateQuietPrompt(interviewPrompt, false, false);
            const interviewData = {
                id: Date.now(),
                timestamp: new Date().toISOString(),
                character: characterName,
                messageIndex: messageIndex,
                scene: sceneText,
                interview: interview,
                context: extension_settings[extensionName].includeContext ? sceneContext : null
            };
            
            interviewHistory.unshift(interviewData);
            if (interviewHistory.length > extension_settings[extensionName].maxInterviews) {
                interviewHistory = interviewHistory.slice(0, extension_settings[extensionName].maxInterviews);
            }
            
            saveSettings();
            toastr.clear(loadingToast);
            toastr.success('Интервью сгенерировано!');
            showInterviewPopup(interviewData);
            updateInterviewList();
        } catch (error) {
            toastr.clear(loadingToast);
            toastr.error('Ошибка генерации интервью: ' + error.message);
            console.error('Interview generation error:', error);
        }
    }

    function showInterviewPopup(interviewData) {
        const popup = `
            <div class="bts-interview-popup">
                <div class="bts-interview-header">
                    <h3>🎬 Интервью: ${interviewData.character}</h3>
                    <small>${new Date(interviewData.timestamp).toLocaleString('ru-RU')}</small>
                </div>
                <div class="bts-interview-scene">
                    <h4>Сцена:</h4>
                    <p>${interviewData.scene}</p>
                </div>
                <div class="bts-interview-content">
                    <h4>Интервью:</h4>
                    <p>${interviewData.interview}</p>
                </div>
            </div>
        `;
        callPopup(popup, 'text', '', { wide: true, large: true });
    }

    function updateInterviewList() {
        const container = $('#bts-interview-list');
        if (!container.length) return;
        container.empty();
        
        if (interviewHistory.length === 0) {
            container.append('<div class="bts-no-interviews">Интервью пока нет. Нажмите на кнопку 🎬 рядом с сообщением!</div>');
            return;
        }
        
        interviewHistory.forEach(interview => {
            const item = $(`
                <div class="bts-interview-item" data-interview-id="${interview.id}">
                    <div class="bts-interview-item-header">
                        <strong>${interview.character}</strong>
                        <small>${new Date(interview.timestamp).toLocaleString('ru-RU')}</small>
                    </div>
                    <div class="bts-interview-item-preview">
                        ${interview.scene.substring(0, 100)}${interview.scene.length > 100 ? '...' : ''}
                    </div>
                    <button class="bts-view-btn menu_button" data-interview-id="${interview.id}">
                        👁️ Посмотреть
                    </button>
                    <button class="bts-delete-btn menu_button" data-interview-id="${interview.id}">
                        🗑️ Удалить
                    </button>
                </div>
            `);
            container.append(item);
        });
        
        $('.bts-view-btn').on('click', function() {
            const id = $(this).data('interview-id');
            const interview = interviewHistory.find(i => i.id === id);
            if (interview) showInterviewPopup(interview);
        });
        
        $('.bts-delete-btn').on('click', function() {
            const id = $(this).data('interview-id');
            interviewHistory = interviewHistory.filter(i => i.id !== id);
            saveSettings();
            updateInterviewList();
            toastr.success('Интервью удалено');
        });
    }

    function addInterviewButtons() {
        $(document).on('mouseenter', '.mes', function() {
            const mesBlock = $(this);
            if (mesBlock.find('.bts-interview-btn').length > 0) return;
            
            const messageIndex = mesBlock.attr('mesid');
            const btn = $(`
                <div class="bts-interview-btn" title="Взять интервью о сцене" data-message-index="${messageIndex}">
                    🎬
                </div>
            `);
            
            btn.on('click', function(e) {
                e.stopPropagation();
                const index = parseInt($(this).data('message-index'));
                generateInterview(index);
            });
            
            mesBlock.find('.mes_buttons').append(btn);
        });
    }
