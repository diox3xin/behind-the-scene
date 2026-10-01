// Dynamic feature detection keeps old SillyTavern builds loadable.
export async function requestMainStream(context, request, signal, loadModule = () => import('../../../openai.js')) {
    if (context.mainApi !== 'openai' || !context.ChatCompletionService?.sendRequest) return null;
    const api = await loadModule();
    if (typeof api.createGenerationParameters !== 'function') return null;
    const settings = structuredClone(context.chatCompletionSettings);
    settings.stream_openai = true;
    settings.openai_max_tokens = request.maxTokens;
    settings.n = 1;
    // No changes to global settings, profile, main chat or streamingProcessor.
    const model = api.getChatCompletionModel();
    const { generate_data } = await api.createGenerationParameters(settings, model, 'normal', structuredClone(request.messages));
    if (signal?.aborted) throw new Error('Генерация отменена.');
    return context.ChatCompletionService.sendRequest(generate_data, true, signal);
}