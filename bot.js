import { Bot, session } from "grammy";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

// Initialize the Telegram bot with your token from environment variables
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Initialize the OpenAI client with your API key
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Define the initial session value
function initialSession() {
    return {
        messages: [
            {
                role: "system",
                content: "You are a helpful assistant integrated with Telegram. Be concise and friendly."
            }
        ],
        // Optional: Add a message count or timestamp to manage conversation history
        messageCount: 0,
        lastInteraction: Date.now()
    };
}

// Install session middleware
bot.use(session({
    initial: initialSession,
    // Optional: Set an expiration time for conversations
    getSessionKey: (ctx) => ctx.chat?.id.toString(),
}));

// Handle incoming messages
bot.on("message", async (ctx) => {
    // Only process text messages
    if (!ctx.message.text) {
        return ctx.reply("I can only process text messages.");
    }

    if (ctx.message.text === "/start") {
        ctx.session = initialSession();
        return ctx.reply("Hello! I'm your AI assistant. How can I help you today?");
    }

    if (ctx.message.text === "/help") {
        return ctx.reply(
            "I'm an AI assistant powered by OpenAI. You can ask me questions, request information, or just chat with me."
        );
    }

    if (ctx.message.text === "/reset") {
        ctx.session = initialSession();
        return ctx.reply("Conversation history has been reset.");
    }

    try {
        // Show typing indicator
        await ctx.replyWithChatAction("typing");

        // Add the user message to the conversation history
        ctx.session.messages.push({
            role: "user",
            content: ctx.message.text
        });

        // Increment message count
        ctx.session.messageCount++;
        ctx.session.lastInteraction = Date.now();

        // Prevent the context from getting too large (OpenAI has token limits)
        // Keep only the last 10 messages plus the system message
        if (ctx.session.messageCount > 10) {
            // Always keep the system message (first one) and the latest messages
            ctx.session.messages = [
                ctx.session.messages[0],
                ...ctx.session.messages.slice(-10)
            ];
        }

        // Call OpenAI API with the conversation history
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Using the correct model name
            messages: ctx.session.messages,
            max_tokens: 500 // Limit response length
        });

        // Extract the assistant's reply
        const reply = response.choices[0].message.content;

        // Add the assistant's reply to the conversation history
        ctx.session.messages.push({
            role: "assistant",
            content: reply
        });

        // Send the response back to the user
        await ctx.reply(reply);

    } catch (error) {
        console.error("Error when calling OpenAI API:", error);
        await ctx.reply("Sorry, I encountered an error processing your request.");
    }
});

// Handle the /start command
bot.command("start", (ctx) => {
    // Reset the session
    ctx.session = initialSession();
    ctx.reply("Hello! I'm your AI assistant. How can I help you today?");
});

// Handle the /help command
bot.command("help", (ctx) => {
    ctx.reply(
        "I'm an AI assistant powered by OpenAI. You can ask me questions, request information, or just chat with me."
    );
});

// Add a reset command to clear conversation history
bot.command("reset", (ctx) => {
    ctx.session = initialSession();
    ctx.reply("Conversation history has been reset.");
});

// Start the bot
console.log("Starting the bot...");
bot.start();