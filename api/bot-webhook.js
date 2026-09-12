// api/bot-webhook.js
//
// Support relay for the Huna Arabic bot. No database needed:
//   - /start replies with a link to open the Mini App — nothing is forwarded.
//   - /support first shows two quick self-help tips with a button to proceed
//     anyway. Tapping it sends a "ForceReply" prompt asking for the question;
//     Telegram then marks the user's NEXT message as a reply to that prompt,
//     which is how we know (statelessly) that THIS message should be relayed —
//     random messages sent without going through /support are not forwarded.
//   - When the owner replies (in Telegram) to a forwarded message, Telegram
//     includes `forward_from` on it — we read the original sender's id from
//     there and send the reply back to them.
//
// Required environment variables (set in Vercel → Project → Settings →
// Environment Variables):
//   BOT_TOKEN      — the bot's API token from @BotFather
//   OWNER_CHAT_ID  — your own numeric Telegram id (get it from @userinfobot)
//   MINI_APP_URL   — link opened from /start (e.g. https://t.me/huna_arabic_appbot/app
//                    or your plain hosting URL) — optional, has a fallback text

const SUPPORT_TIPS =
  'Прежде чем писать в поддержку, попробуйте это:\n\n' +
  '1️⃣ Как отключить дневной лимит новых слов — в приложении откройте ' +
  '«Подробная статистика» → «Новых слов в день» → выберите «Без ограничений».\n\n' +
  '2️⃣ Если бот или приложение не отвечает — проверьте соединение с ' +
  'интернетом и попробуйте закрыть и заново открыть приложение через ' +
  'кнопку в этом чате.\n\n' +
  'Не помогло?';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
  const MINI_APP_URL = process.env.MINI_APP_URL;
  const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

  const call = (method, payload) =>
    fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((e) => console.error('telegram api error', method, e));

  const update = req.body;
  const msg = update && update.message;
  const callback = update && update.callback_query;

  try {
    // ---- inline button taps ----
    if (callback) {
      await call('answerCallbackQuery', { callback_query_id: callback.id });
      if (callback.data === 'contact_support') {
        await call('sendMessage', {
          chat_id: callback.message.chat.id,
          text: 'Напишите ваш вопрос одним сообщением — он будет передан в поддержку 👇',
          reply_markup: { force_reply: true },
        });
      }
      return res.status(200).send('OK');
    }

    if (!msg) return res.status(200).send('OK');

    if (String(msg.chat.id) === String(OWNER_CHAT_ID)) {
      // ---- message from the owner: only act if it's a reply to a forwarded user message
      const fwd = msg.reply_to_message && msg.reply_to_message.forward_from;
      if (fwd && msg.text) {
        await call('sendMessage', { chat_id: fwd.id, text: msg.text });
      } else if (msg.reply_to_message && !fwd) {
        await call('sendMessage', {
          chat_id: OWNER_CHAT_ID,
          text: 'Не удалось определить получателя — пользователь скрыл пересылку профиля в настройках приватности Telegram.',
        });
      }
      // not a reply to a forward -> owner just chatting/testing, ignore
      return res.status(200).send('OK');
    }

    // ---- messages from regular users ----
    if (msg.text === '/start') {
      const text = MINI_APP_URL
        ? `Ассаламу алейкум! Откройте приложение здесь: ${MINI_APP_URL}\n\nЕсли возникнут вопросы — отправьте команду /support.`
        : 'Ассаламу алейкум! Если возникнут вопросы — отправьте команду /support.';
      await call('sendMessage', { chat_id: msg.chat.id, text });
      return res.status(200).send('OK');
    }

    if (msg.text === '/support') {
      await call('sendMessage', {
        chat_id: msg.chat.id,
        text: SUPPORT_TIPS,
        reply_markup: {
          inline_keyboard: [[{ text: '✍️ Всё равно написать в поддержку', callback_data: 'contact_support' }]],
        },
      });
      return res.status(200).send('OK');
    }

    // Was this message typed in reply to our own /support prompt above?
    const repliedToSupportPrompt =
      msg.reply_to_message &&
      msg.reply_to_message.from &&
      msg.reply_to_message.from.is_bot;

    if (repliedToSupportPrompt) {
      await call('forwardMessage', {
        chat_id: OWNER_CHAT_ID,
        from_chat_id: msg.chat.id,
        message_id: msg.message_id,
      });
      await call('sendMessage', { chat_id: msg.chat.id, text: 'Спасибо, вопрос передан в поддержку — скоро ответим здесь же.' });
    } else {
      await call('sendMessage', {
        chat_id: msg.chat.id,
        text: 'Чтобы написать в поддержку, отправьте команду /support.',
      });
    }
  } catch (e) {
    console.error('webhook handler error', e);
  }

  res.status(200).send('OK');
}
