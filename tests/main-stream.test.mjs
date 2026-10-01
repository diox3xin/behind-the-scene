import test from 'node:test';
import assert from 'node:assert/strict';
import { requestMainStream } from '../main-stream.mjs';

test('main stream builds provider payload with a cloned configuration, not global settings', async () => {
    const original = { stream_openai: false, openai_max_tokens: 900, n: 4, chat_completion_source: 'custom' };
    let sent;
    const context = {
        mainApi: 'openai', chatCompletionSettings: original,
        ChatCompletionService: { sendRequest: async (...args) => { sent = args; return 'result'; } },
    };
    const request = { messages: [{ role: 'user', content: 'Вопрос' }], maxTokens: 240 };
    const signal = new AbortController().signal;
    const result = await requestMainStream(context, request, signal, async () => ({
        getChatCompletionModel: () => 'model',
        createGenerationParameters: async (settings, model, type, messages) => {
            assert.notEqual(settings, original);
            assert.equal(settings.stream_openai, true);
            assert.equal(settings.n, 1);
            assert.equal(settings.openai_max_tokens, 240);
            assert.equal(model, 'model');
            assert.equal(type, 'normal');
            assert.deepEqual(messages, request.messages);
            messages[0].content = 'builder mutation';
            return { generate_data: { stream: true, max_tokens: 240 } };
        },
    }));
    assert.equal(result, 'result');
    assert.equal(original.stream_openai, false);
    assert.equal(original.n, 4);
    assert.equal(request.messages[0].content, 'Вопрос');
    assert.deepEqual(sent, [{ stream: true, max_tokens: 240 }, true, signal]);
});

test('older or non-chat-completion hosts return fallback without trying another provider', async () => {
    assert.equal(await requestMainStream({ mainApi: 'kobold' }, {}, null, () => { throw new Error('Unexpected import'); }), null);
    assert.equal(await requestMainStream({ mainApi: 'openai', ChatCompletionService: { sendRequest() {} } }, {}, null, async () => ({})), null);
});