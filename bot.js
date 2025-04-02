import { Bot } from "grammy";

const bot = new Bot("8050692055:AAHpYjgI22d4jzhArSiwTDtwMDgUqxSF1ow"); // <-- put your bot token between the "" (https://t.me/BotFather)

// Reply to any message with "Hi there!".
bot.on("message", (ctx) => ctx.reply(ctx.message.text));

bot.start();