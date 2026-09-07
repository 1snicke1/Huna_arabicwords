// api/bot-webhook.js
//
// Support relay for the Huna Arabic bot. No database needed:
//   1. A message from a regular user is forwarded to the owner's chat.
//   2. When the owner replies (in Telegram) to that forwarded message,
//      Telegram includes `forward_from` on it — we read the original
//      sender's id from there and send the reply back to them.
//
// Required environment variables (set in Vercel → Project → Settings →
// Environment Variables):
//   BOT_TOKEN      — the bot's API token from @BotFather
//   OWNER_CHAT_ID  — your own numeric Telegram id (get it from @userinfobot)

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  const BOT_TOKEN = process.env.BOT_TOKEN;
  const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
  const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

  const call = (method, payload) =>
    fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((e) => console.error('telegram api error', method, e));

  const update = req.body;
  const msg = update && update.message;

  if (!msg) return res.status(200).send('OK');

  try {
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
      // if it's not a reply to a forward, ignore (owner just chatting/testing)
    } else {
      // ---- message from a regular user: forward to the owner, then acknowledge
      await call('forwardMessage', {
        chat_id: OWNER_CHAT_ID,
        from_chat_id: msg.chat.id,
        message_id: msg.message_id,
      });

      const ack = msg.text === '/start'
        ? 'Здравствуйте! Напишите ваш вопрос — мы ответим здесь же, в этом чате.'
        : 'Спасибо, сообщение получено — скоро ответим здесь же.';
      await call('sendMessage', { chat_id: msg.chat.id, text: ack });
    }
  } catch (e) {
    console.error('webhook handler error', e);
  }

  res.status(200).send('OK');
}
