import { Bot, session } from "grammy";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import axios from "axios";
import fs from "fs";
import path from "path";
import { createWorker } from "tesseract.js";
import { Redis } from '@upstash/redis';

dotenv.config();

// Initialize the Telegram bot with your token from environment variables
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
const ai = new GoogleGenAI(process.env.GOOGLE_API_KEY);

// Initialize Redis client for file storage
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_TOKEN
});

// Function to store file information in Redis
async function storeFileInfo(userId, fileId, fileName, fileUrl, fileType) {
    try {
        // Create file info object
        const fileInfo = {
            userId,
            fileId,
            fileName,
            fileUrl,
            fileType,
            uploadedAt: Date.now()
        };
        
        // Store the file info as a JSON string
        const fileKey = `file:${fileId}`;
        await redis.set(fileKey, JSON.stringify(fileInfo));
        
        // Add file ID to user's set of files
        const userFilesKey = `user:${userId}:files`;
        await redis.sadd(userFilesKey, fileId);
        
        // Add file ID to global set of all files
        await redis.sadd("all-files", fileId);
        
        console.log(`Stored file info for ${fileName} with ID ${fileId}`);
        return fileId;
    } catch (error) {
        console.error("Error storing file info in Redis:", error);
        throw error;
    }
}

// Function to retrieve file information from Redis
async function getFileInfo(fileId) {
    try {
        const fileInfoStr = await redis.get(`file:${fileId}`);
        if (!fileInfoStr) return null;
        
        return JSON.parse(fileInfoStr);
    } catch (error) {
        console.error("Error retrieving file info from Redis:", error);
        return null;
    }
}

// Function to get list of files for a user
async function getUserFiles(userId, limit = 10) {
    try {
        // Get file IDs from user's set
        const userFilesKey = `user:${userId}:files`;
        const fileIds = await redis.smembers(userFilesKey);
        
        // Get file info for each ID
        const fileInfoPromises = fileIds.map(fileId => getFileInfo(fileId));
        let fileInfos = await Promise.all(fileInfoPromises);
        
        // Filter null values and sort by upload time
        fileInfos = fileInfos
            .filter(info => info !== null)
            .sort((a, b) => b.uploadedAt - a.uploadedAt)
            .slice(0, limit);
        
        return fileInfos;
    } catch (error) {
        console.error("Error retrieving user files from Redis:", error);
        return [];
    }
}

// Function to get all files in the system
async function getAllFiles(limit = 100) {
    try {
        // Get all file IDs from global set
        const fileIds = await redis.smembers("all-files");
        
        // Get file info for each ID
        const fileInfoPromises = fileIds.map(fileId => getFileInfo(fileId));
        let fileInfos = await Promise.all(fileInfoPromises);
        
        // Filter null values and sort by upload time
        fileInfos = fileInfos
            .filter(info => info !== null)
            .sort((a, b) => b.uploadedAt - a.uploadedAt)
            .slice(0, limit);
        
        return fileInfos;
    } catch (error) {
        console.error("Error retrieving all files from Redis:", error);
        return [];
    }
}

// Initialize OCR worker correctly for tesseract.js v5.x
let worker = null;

async function initOcr() {
    worker = await createWorker('eng');
    console.log("OCR worker initialized");
}

// Call OCR initialization
initOcr();

// Function to get file URL from Telegram
async function getFileUrl(fileId) {
    try {
        // Get file path from Telegram
        const fileInfo = await bot.api.getFile(fileId);
        const filePath = fileInfo.file_path;
        
        // Construct the URL for accessing
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
        
        return { fileUrl, filePath };
    } catch (error) {
        console.error("Error getting file URL:", error);
        throw error;
    }
}

// Function to download file from Telegram (only used for OCR)
async function downloadFileForOcr(fileUrl) {
    try {
        // Download the file
        const response = await axios({
            method: 'GET',
            url: fileUrl,
            responseType: 'arraybuffer'
        });
        
        // Create a temporary file
        const tempDir = path.join(process.cwd(), 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const tempFile = path.join(tempDir, `temp_ocr_${Date.now()}.jpg`);
        fs.writeFileSync(tempFile, response.data);
        
        return tempFile;
    } catch (error) {
        console.error("Error downloading file for OCR:", error);
        throw error;
    }
}

// Function to perform OCR on an image
async function performOcr(imagePath) {
    try {
        if (!worker) {
            console.log("Worker not initialized yet, initializing now...");
            await initOcr();
        }
        
        const result = await worker.recognize(imagePath);
        return result.data.text;
    } catch (error) {
        console.error("OCR error:", error);
        throw error;
    }
}

// Define the initial session value
function initialSession() {
    return {
        messages: [
            {
                role: "system",
                content: "You are a helpful assistant integrated with Telegram. Be concise and friendly."
            }
        ],
        messageCount: 0,
        lastInteraction: Date.now()
    };
}

// Install session middleware
bot.use(session({
    initial: initialSession,
    getSessionKey: (ctx) => ctx.chat?.id.toString(),
}));

// Handle incoming messages
bot.on("message", async (ctx) => {
    // Check if the message contains a document (file)
    if (ctx.message.document) {
        try {
            // Get file information
            const fileId = ctx.message.document.file_id;
            const fileName = ctx.message.document.file_name || "document";
            const mimeType = ctx.message.document.mime_type;
            const userId = ctx.from.id.toString();
            
            // Send a confirmation message
            await ctx.reply(`I received your file: ${fileName}. Processing...`);
            
            // Get file URL directly from Telegram API
            const { fileUrl } = await getFileUrl(fileId);
            
            // Store file info in Redis
            await storeFileInfo(userId, fileId, fileName, fileUrl, mimeType);
            
            // Check if the document is a PDF
            if (mimeType === "application/pdf") {
                await ctx.replyWithChatAction("typing");
                
                try {
                    // Get user context: caption (for document) or latest message text
                    const userContext = ctx.message.caption || ctx.message.text || "Analyze and summarize this PDF document.";
                    
                    // Fetch the PDF content directly
                    const pdfResponse = await axios({
                        method: 'GET',
                        url: fileUrl,
                        responseType: 'arraybuffer'
                    });
                    
                    // Convert to base64
                    const base64Pdf = Buffer.from(pdfResponse.data).toString('base64');
                    
                    const contents = [
                        { text: `User Request: ${userContext}` },
                        {
                            inlineData: {
                                mimeType: 'application/pdf',
                                data: base64Pdf
                            }
                        }
                    ];
                    
                    // Send to Gemini for processing
                    const response = await ai.models.generateContent({
                        model: "gemini-1.5-flash",
                        contents: contents
                    });
                    
                    const reply = response.text;
                    
                    // Send the analysis back to the user
                    if (reply.length > 4000) {
                        const chunks = reply.match(/.{1,4000}/gs);
                        for (const chunk of chunks) {
                            await ctx.reply(chunk);
                        }
                    } else {
                        await ctx.reply(reply);
                    }
                    
                    // Add the interaction to conversation history
                    ctx.session.messages.push({
                        role: "user",
                        content: `[Uploaded a PDF: ${fileName}]`
                    });
                    
                    ctx.session.messages.push({
                        role: "assistant",
                        content: reply
                    });
                    
                } catch (error) {
                    console.error("Error processing PDF with Gemini:", error);
                    await ctx.reply("I encountered an error analyzing this PDF. Please try a different file or format.");
                }
            } else {
                await ctx.replyWithDocument(fileId);
                await ctx.reply("I can analyze PDFs, but other file types are not supported for deep analysis.");
            }
            return;
        } catch (error) {
            console.error("Error handling document:", error);
            await ctx.reply("Sorry, I encountered an error processing your file.");
            return;
        }
    }
    
    // Check if the message contains a photo
    if (ctx.message.photo) {
        try {
            const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
            const userId = ctx.from.id.toString();
            
            await ctx.reply(`I received your photo. Processing...`);
            await ctx.replyWithChatAction("typing");
            
            // Get file URL directly from Telegram API
            const { fileUrl } = await getFileUrl(photoId);
            
            // Store photo info in Redis
            await storeFileInfo(userId, photoId, "photo.jpg", fileUrl, "image/jpeg");
            
            try {
                // Fetch the image directly
                const imageResponse = await axios({
                    method: 'GET',
                    url: fileUrl,
                    responseType: 'arraybuffer'
                });
                
                // Convert to base64
                const base64Image = Buffer.from(imageResponse.data).toString('base64');
                
                // Get the caption if any
                const userContext = ctx.message.caption || "Analyze this image and describe what you see.";
                
                const contents = [
                    { text: userContext },
                    {
                        inlineData: {
                            mimeType: 'image/jpeg',
                            data: base64Image
                        }
                    }
                ];
                
                // Process with Gemini
                const response = await ai.models.generateContent({
                    model: "gemini-1.5-flash",
                    contents: contents
                });
                
                const reply = response.text;
                await ctx.reply(reply);
                
                ctx.session.messages.push({
                    role: "user",
                    content: `[Uploaded a photo with caption: ${userContext}]`
                });
                
                ctx.session.messages.push({
                    role: "assistant",
                    content: reply
                });
                
            } catch (error) {
                console.error("Error processing image with Gemini:", error);
                await ctx.reply("I encountered an error analyzing this image.");
                
                // Fall back to OCR if needed
                try {
                    const tempFile = await downloadFileForOcr(fileUrl);
                    const extractedText = await performOcr(tempFile);
                    
                    if (fs.existsSync(tempFile)) {
                        fs.unlinkSync(tempFile);
                    }
                    
                    if (extractedText.length > 0) {
                        await ctx.reply(`Text extracted from the image:\n\n${extractedText}`);
                    }
                } catch (ocrError) {
                    console.error("Error with OCR fallback:", ocrError);
                }
            }
            return;
        } catch (error) {
            console.error("Error handling photo:", error);
            await ctx.reply("Sorry, I encountered an error processing your photo.");
            return;
        }
    }
    
    // Check if message is asking for files
    if (ctx.message.text && ctx.message.text.toLowerCase().includes("show my files")) {
        try {
            const userId = ctx.from.id.toString();
            const files = await getUserFiles(userId);
            
            if (files.length === 0) {
                await ctx.reply("You haven't uploaded any files yet.");
                return;
            }
            
            let filesList = "Your recent files:\n\n";
            files.forEach((file, index) => {
                const date = new Date(file.uploadedAt).toLocaleString();
                filesList += `${index + 1}. ${file.fileName} (${file.fileType}) - Uploaded on ${date}\n`;
            });
            
            await ctx.reply(filesList);
            return;
        } catch (error) {
            console.error("Error retrieving user files:", error);
            await ctx.reply("Sorry, I encountered an error retrieving your files.");
            return;
        }
    }

    if (ctx.message.text === "/start") {
        ctx.session = initialSession();
        return ctx.reply("Hello! I'm your AI assistant. How can I help you today?");
    }

    if (ctx.message.text === "/help") {
        return ctx.reply(
            "I'm an AI assistant powered by Gemini. You can ask me questions, request information, or just chat with me."
        );
    }

    if (ctx.message.text === "/reset") {
        ctx.session = initialSession();
        return ctx.reply("Conversation history has been reset.");
    }

    try {
        await ctx.replyWithChatAction("typing");

        ctx.session.messages.push({
            role: "user",
            content: ctx.message.text
        });

        ctx.session.messageCount++;
        ctx.session.lastInteraction = Date.now();

        if (ctx.session.messageCount > 7) {
            ctx.session.messages = [
                ctx.session.messages[0],
                ...ctx.session.messages.slice(-7)
            ];
        }

        const formattedMessages = ctx.session.messages.map(msg => {
            return {
                role: msg.role === "system" ? "user" : msg.role,
                parts: [{ text: msg.content }]
            };
        });

        const response = await ai.models.generateContent({
            model: "gemini-1.5-flash",
            contents: formattedMessages
        });
        
        const reply = response.text;

        ctx.session.messages.push({
            role: "assistant",
            content: reply
        });

        await ctx.reply(reply);

    } catch (error) {
        console.error("Error when calling Gemini API:", error);
        await ctx.reply("Sorry, I encountered an error processing your request.");
    }
});

// Handle the /start commands
bot.command("start", (ctx) => {
    ctx.session = initialSession();
    ctx.reply("Hello! I'm your AI assistant. How can I help you today?");
});

// Handle the /help command
bot.command("help", (ctx) => {
    ctx.reply(
        "I'm an AI assistant powered by Gemini. You can ask me questions, request information, or just chat with me."
    );
});

// Add a reset command to clear conversation history
bot.command("reset", (ctx) => {
    ctx.session = initialSession();
    ctx.reply("Conversation history has been reset.");
});

// Add a new command to list all files in the system (admin only)
bot.command("allfiles", async (ctx) => {
    // You might want to add admin verification here
    try {
        // Only allow specific user IDs to use this command
        const adminUserIds = ["YOUR_ADMIN_ID"]; // Replace with actual admin ID(s)
        if (adminUserIds.includes(ctx.from.id.toString())) {
            const files = await getAllFiles();
            
            if (files.length === 0) {
                await ctx.reply("No files have been uploaded yet.");
                return;
            }
            
            let filesList = "All files in the system:\n\n";
            files.forEach((file, index) => {
                const date = new Date(file.uploadedAt).toLocaleString();
                filesList += `${index + 1}. User: ${file.userId} - ${file.fileName} (${file.fileType}) - Uploaded on ${date}\n`;
            });
            
            // If the list is too long, split it into multiple messages
            if (filesList.length > 4000) {
                const chunks = filesList.match(/.{1,4000}/gs);
                for (const chunk of chunks) {
                    await ctx.reply(chunk);
                }
            } else {
                await ctx.reply(filesList);
            }
        } else {
            await ctx.reply("You don't have permission to use this command.");
        }
    } catch (error) {
        console.error("Error retrieving all files:", error);
        await ctx.reply("Sorry, I encountered an error retrieving the files.");
    }
});

// Add file statistics command
bot.command("filestats", async (ctx) => {
    try {
        const allFiles = await getAllFiles();
        const userFiles = await getUserFiles(ctx.from.id.toString());
        
        let stats = "File Statistics:\n\n";
        stats += `Total files in system: ${allFiles.length}\n`;
        stats += `Your uploaded files: ${userFiles.length}\n\n`;
        
        // Group by file type
        const fileTypes = {};
        allFiles.forEach(file => {
            fileTypes[file.fileType] = (fileTypes[file.fileType] || 0) + 1;
        });
        
        stats += "File types breakdown:\n";
        for (const [type, count] of Object.entries(fileTypes)) {
            stats += `${type}: ${count}\n`;
        }
        
        await ctx.reply(stats);
    } catch (error) {
        console.error("Error generating file statistics:", error);
        await ctx.reply("Sorry, I encountered an error generating file statistics.");
    }
});

// Start the bot
console.log("Starting the bot...");
bot.start();