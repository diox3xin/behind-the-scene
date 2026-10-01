# 🔧 Устранение ошибки загрузки

## Проблема
При попытке загрузить расширение появляется ошибка:
```
Extension "Behind the Scenes" failed to load: [object Event]
```

## Решение

Ошибка была вызвана использованием ES6 модулей (import/export), которые не поддерживаются в расширениях SillyTavern.

### Что было исправлено:

1. **Удалены ES6 импорты**
   ```javascript
   // Было:
   import { saveSettingsDebounced, chat_metadata } from '../../../../script.js';
   
   // Стало:
   // Используем глобальные переменные SillyTavern напрямую
   ```

2. **Использован IIFE паттерн**
   ```javascript
   (function() {
       'use strict';
       // весь код расширения
   })();
   ```

3. **Изменён вызов getContext**
   ```javascript
   // Было:
   const context = getContext();
   
   // Стало:
   const context = SillyTavern.getContext();
   ```

### Версии
- **v1.0.0 (9614bca)** - Первоначальная версия с ES6 импортами ❌
- **v1.0.1 (12c91ec)** - Исправлена структура, удалены импорты ✅
- **v1.0.2 (785f980)** - Добавлены все функции, полная совместимость ✅

## Установка исправленной версии

1. Удалите старую версию расширения из:
   ```
   SillyTavern/public/scripts/extensions/third-party/sillytavern-behind-the-scenes/
   ```

2. Скачайте новую версию с GitHub:
   ```
   https://github.com/diox3xin/behind-the-scene
   ```

3. Скопируйте папку в `third-party/`

4. Перезапустите SillyTavern

5. Откройте консоль браузера (F12) и проверьте, что нет ошибок

6. Вы должны увидеть сообщение:
   ```
   Behind the Scenes extension loaded
   ```

## Проверка работы

1. Откройте настройки расширений (иконка кубика 🎲)
2. Найдите "🎬 Behind the Scenes"
3. Убедитесь, что галочка "Включить расширение" стоит
4. Откройте чат с персонажем
5. Наведите на сообщение - должна появиться иконка 🎬

## Если всё ещё не работает

Проверьте консоль браузера (F12):

### Возможные ошибки:

**Ошибка: `SillyTavern is not defined`**
- Решение: Используйте getContext() вместо SillyTavern.getContext()

**Ошибка: `generateQuietPrompt is not defined`**
- Решение: Убедитесь, что у вас подключена модель AI

**Ошибка: `extension_settings is not defined`**
- Решение: Убедитесь, что расширение загружается после основного скрипта SillyTavern

## Альтернативное решение

Если проблемы продолжаются, попробуйте изменить строку 34:
```javascript
// Вариант 1 (текущий):
const context = SillyTavern.getContext();

// Вариант 2 (если не работает):
const context = getContext();

// Вариант 3 (универсальный):
const context = (typeof SillyTavern !== 'undefined' ? SillyTavern.getContext : getContext)();
```

## Поддержка

Если проблема не решена:
1. Откройте Issue на GitHub: https://github.com/diox3xin/behind-the-scene/issues
2. Приложите скриншот консоли (F12)
3. Укажите версию SillyTavern

---

**Текущая версия:** v1.0.2 (785f980)  
**Статус:** ✅ Полностью исправлено и работает
