// Telegram может прислать то же обновление повторно, если webhook ответил
// слишком поздно (например, бот ждал после 429). Повтор с тем же update_id
// пропускаем, чтобы человек не получил файл или ответ дважды.
function createUpdateDeduper(maxSize) {
  const limit = maxSize || 1000;
  const seen = new Set();
  return async (ctx, next) => {
    const id = ctx && ctx.update && ctx.update.update_id;
    if (typeof id === 'number') {
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > limit) seen.delete(seen.values().next().value);
    }
    return next();
  };
}

module.exports = { createUpdateDeduper };
