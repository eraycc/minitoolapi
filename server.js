const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
require('dotenv').config();

// Environment variables with defaults
const AUTH_TOKENS = (process.env.AUTH_TOKENS || 'sk-default,sk-none').split(',');
const BASE_URL = process.env.BASE_URL || 'https://minitoolai.com';
const MODEL_CACHE_DAYS = parseInt(process.env.MODEL_CACHE_DAYS || '7');
const PORT = process.env.PORT || 3000;

// User agents for browser simulation
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
];

// Model paths
const MODEL_PATHS = [
    'chatGPT',
    'deepseek',
    'qwen',
    'Claude-3',
    'Gemini',
    'grok',
    'bytedance-seed',
    'gpt-oss',
    'llama'
];

// Initialize Express app
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.text());

// Initialize SQLite database
const db = new Database('models.db');

// Create tables if not exists
db.exec(`
    CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        group_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS model_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    );
`);

// Browser instance manager
class BrowserManager {
    constructor() {
        this.browser = null;
        this.pages = new Map();
    }

    async init() {
        if (!this.browser) {
            this.browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process'
                ]
            });
        }
        return this.browser;
    }

    async getPage(modelPath) {
        await this.init();
        
        if (!this.pages.has(modelPath)) {
            const page = await this.browser.newPage();
            const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
            
            // Set user agent and extra headers
            await page.setUserAgent(userAgent);
            await page.setExtraHTTPHeaders({
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Content-Type': 'text/html',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            });
            
            this.pages.set(modelPath, page);
        }
        
        return this.pages.get(modelPath);
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.pages.clear();
        }
    }
}

const browserManager = new BrowserManager();

// Authentication middleware
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const token = authHeader.slice(7);
    
    if (!AUTH_TOKENS.includes(token)) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    
    next();
}

// Model discovery function with proper headers
async function discoverModels() {
    const models = [];
    const browser = await browserManager.init();
    
    const discoveryPromises = MODEL_PATHS.map(async (modelPath) => {
        try {
            const page = await browser.newPage();
            const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
            
            // Set user agent
            await page.setUserAgent(userAgent);
            
            // Set request interception to add headers
            await page.setRequestInterception(true);
            
            page.on('request', (request) => {
                const headers = {
                    ...request.headers(),
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Content-Type': 'text/html',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1'
                };
                
                request.continue({ headers });
            });
            
            const url = `${BASE_URL}/${modelPath}/`;
            console.log(`Fetching models from: ${url}`);
            
            // Navigate with proper options
            const response = await page.goto(url, { 
                waitUntil: 'networkidle2', 
                timeout: 30000 
            });
            
            // Check response status
            if (response && response.status() === 415) {
                console.error(`Got 415 error for ${modelPath}, retrying with different approach...`);
                
                // Alternative approach: set headers before navigation
                await page.setExtraHTTPHeaders({
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Content-Type': 'text/html'
                });
                
                await page.goto(url, { 
                    waitUntil: 'networkidle2', 
                    timeout: 30000 
                });
            }
            
            // Wait for select element to be present
            await page.waitForSelector('#select_model', { timeout: 5000 }).catch(() => {
                console.log(`No select_model found for ${modelPath}`);
            });
            
            // Extract model options
            const modelOptions = await page.evaluate(() => {
                const select = document.querySelector('#select_model');
                if (!select) return [];
                
                return Array.from(select.options).map(option => ({
                    id: option.value,
                    text: option.textContent.trim()
                }));
            });
            
            await page.close();
            
            if (modelOptions.length > 0) {
                console.log(`Found ${modelOptions.length} models for ${modelPath}`);
                
                // Store models in database
                const stmt = db.prepare('INSERT OR REPLACE INTO models (id, group_name, created_at, updated_at) VALUES (?, ?, ?, ?)');
                const timestamp = Date.now();
                
                modelOptions.forEach(option => {
                    models.push({
                        id: option.id,
                        group: modelPath.toLowerCase(),
                        created_at: timestamp
                    });
                    
                    stmt.run(option.id, modelPath.toLowerCase(), timestamp, timestamp);
                });
            } else {
                console.log(`No models found for ${modelPath}`);
            }
            
            return modelOptions.map(o => ({ ...o, group: modelPath.toLowerCase() }));
        } catch (error) {
            console.error(`Error discovering models for ${modelPath}:`, error.message);
            return [];
        }
    });
    
    const results = await Promise.all(discoveryPromises);
    return results.flat();
}

// Get cached models or refresh
async function getModels() {
    const cacheKey = 'model_list';
    const now = Date.now();
    
    // Check cache
    const cached = db.prepare('SELECT value FROM model_cache WHERE key = ? AND expires_at > ?').get(cacheKey, now);
    
    if (cached) {
        console.log('Using cached model list');
        return JSON.parse(cached.value);
    }
    
    console.log('Discovering models...');
    // Discover models
    const models = await discoverModels();
    
    if (models.length > 0) {
        // Cache the results
        const expiresAt = now + (MODEL_CACHE_DAYS * 24 * 60 * 60 * 1000);
        db.prepare('INSERT OR REPLACE INTO model_cache (key, value, expires_at) VALUES (?, ?, ?)').run(
            cacheKey,
            JSON.stringify(models),
            expiresAt
        );
        console.log(`Cached ${models.length} models`);
    }
    
    return models;
}

// Chat completion handler with proper headers
async function handleChatCompletion(req, res) {
    const { messages, model, temperature = 0.7, stream = false } = req.body;
    
    if (!messages || !model) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    try {
        // Get model info
        const models = await getModels();
        const modelInfo = models.find(m => m.id === model);
        
        if (!modelInfo) {
            return res.status(400).json({ error: `Model ${model} not found` });
        }
        
        // Format messages
        const formattedMessages = messages.map(m => `${m.role}:${m.content}`).join(';');
        
        // Get the appropriate page
        const modelPath = MODEL_PATHS.find(p => p.toLowerCase() === modelInfo.group);
        const page = await browserManager.getPage(modelPath);
        
        // Set request interception for chat page
        await page.setRequestInterception(true);
        
        page.removeAllListeners('request');
        page.on('request', (request) => {
            const headers = {
                ...request.headers(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Content-Type': 'text/html'
            };
            request.continue({ headers });
        });
        
        // Navigate to the model page if not already there
        const currentUrl = page.url();
        const expectedUrl = `${BASE_URL}/${modelPath}/`;
        
        if (!currentUrl.includes(modelPath)) {
            await page.goto(expectedUrl, { waitUntil: 'networkidle2' });
            
            // Wait for page to be ready
            await page.waitForSelector('#select_model', { timeout: 10000 });
            await page.waitForSelector('#message', { timeout: 10000 });
            await page.waitForSelector('#send-button', { timeout: 10000 });
        }
        
        // Select the model
        await page.select('#select_model', model);
        await new Promise(resolve => setTimeout(resolve, 500)); // Small delay after selection
        
        // Set temperature if within valid range
        const tempInput = await page.$('#temperature');
        if (tempInput) {
            const minTemp = await page.$eval('#temperature', el => parseFloat(el.min));
            const maxTemp = await page.$eval('#temperature', el => parseFloat(el.max));
            
            if (temperature >= minTemp && temperature <= maxTemp) {
                await page.evaluate((temp) => {
                    document.querySelector('#temperature').value = temp;
                    // Trigger change event
                    document.querySelector('#temperature').dispatchEvent(new Event('change', { bubbles: true }));
                }, temperature);
            }
        }
        
        // Clear and input the message
        await page.evaluate(() => {
            const textarea = document.querySelector('#message');
            textarea.value = '';
            textarea.focus();
        });
        
        await page.type('#message', formattedMessages, { delay: 10 });
        
        // Click send button with retry logic
        let clickSuccess = false;
        for (let i = 0; i < 3; i++) {
            try {
                await page.click('#send-button');
                clickSuccess = true;
                break;
            } catch (error) {
                console.log(`Send button click attempt ${i + 1} failed, retrying...`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        if (!clickSuccess) {
            // Fallback: press Enter key
            await page.keyboard.press('Enter');
        }
        
        // Handle streaming or non-streaming response
        if (stream) {
            await handleStreamingResponse(page, res, model);
        } else {
            await handleNonStreamingResponse(page, res, model);
        }
        
    } catch (error) {
        console.error('Chat completion error:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
}

// Handle streaming response
async function handleStreamingResponse(page, res, model) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    
    const chatId = `chatcmpl-${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);
    
    // Send initial chunk
    const initialChunk = {
        id: chatId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
            index: 0,
            delta: {
                role: 'assistant',
                content: null
            },
            finish_reason: null
        }]
    };
    
    res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);
    
    // Monitor for response
    let lastContent = '';
    let isComplete = false;
    let noChangeCount = 0;
    const maxNoChangeCount = 10; // Stop after 10 consecutive no-change checks
    
    const checkInterval = setInterval(async () => {
        try {
            // Check for response content
            const responseContent = await page.evaluate(() => {
                const responses = document.querySelectorAll('.response');
                if (responses.length === 0) return null;
                
                const lastResponse = responses[responses.length - 1];
                const copyButton = lastResponse.querySelector('.copyres');
                
                // Get text content, excluding button text
                let content = lastResponse.textContent;
                content = content.replace('Copy', '').replace('Copied!', '').trim();
                
                return {
                    content: content,
                    isComplete: !!copyButton
                };
            });
            
            if (responseContent) {
                if (responseContent.content !== lastContent) {
                    const newContent = responseContent.content.substring(lastContent.length);
                    noChangeCount = 0; // Reset no-change counter
                    
                    if (newContent) {
                        const chunk = {
                            id: chatId,
                            object: 'chat.completion.chunk',
                            created,
                            model,
                            choices: [{
                                index: 0,
                                delta: {
                                    content: newContent
                                },
                                finish_reason: null
                            }]
                        };
                        
                        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                        lastContent = responseContent.content;
                    }
                } else {
                    noChangeCount++;
                }
                
                if ((responseContent.isComplete && !isComplete) || noChangeCount >= maxNoChangeCount) {
                    isComplete = true;
                    
                    // Send finish chunk
                    const finishChunk = {
                        id: chatId,
                        object: 'chat.completion.chunk',
                        created,
                        model,
                        choices: [{
                            index: 0,
                            delta: {},
                            finish_reason: 'stop'
                        }],
                        usage: {
                            prompt_tokens: 10,
                            completion_tokens: lastContent.length,
                            total_tokens: 10 + lastContent.length
                        }
                    };
                    
                    res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                    clearInterval(checkInterval);
                }
            }
        } catch (error) {
            console.error('Streaming error:', error);
            clearInterval(checkInterval);
            res.end();
        }
    }, 500);
    
    // Timeout after 60 seconds
    setTimeout(() => {
        if (!isComplete) {
            clearInterval(checkInterval);
            res.end();
        }
    }, 60000);
}

// Handle non-streaming response
async function handleNonStreamingResponse(page, res, model) {
    const chatId = `chatcmpl-${uuidv4()}`;
    const created = Math.floor(Date.now() / 1000);
    
    // Wait for response with timeout
    const maxWaitTime = 60000;
    const startTime = Date.now();
    let lastContent = '';
    let noChangeCount = 0;
    const maxNoChangeCount = 10;
    
    while (Date.now() - startTime < maxWaitTime) {
        const responseContent = await page.evaluate(() => {
            const responses = document.querySelectorAll('.response');
            if (responses.length === 0) return null;
            
            const lastResponse = responses[responses.length - 1];
            const copyButton = lastResponse.querySelector('.copyres');
            
            if (!copyButton) return null;
            
            // Get text content, excluding button text
            let content = lastResponse.textContent;
            content = content.replace('Copy', '').replace('Copied!', '').trim();
            
            return content;
        });
        
        if (responseContent) {
            if (responseContent === lastContent) {
                noChangeCount++;
                if (noChangeCount >= maxNoChangeCount) {
                    // Content hasn't changed for a while, consider it complete
                    const response = {
                        id: chatId,
                        object: 'chat.completion',
                        created,
                        model,
                        choices: [{
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: responseContent
                            },
                            finish_reason: 'stop'
                        }],
                        usage: {
                            prompt_tokens: 10,
                            completion_tokens: responseContent.length,
                            total_tokens: 10 + responseContent.length
                        }
                    };
                    
                    return res.json(response);
                }
            } else {
                lastContent = responseContent;
                noChangeCount = 0;
            }
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // If we have any content, return it
    if (lastContent) {
        const response = {
            id: chatId,
            object: 'chat.completion',
            created,
            model,
            choices: [{
                index: 0,
                message: {
                    role: 'assistant',
                    content: lastContent
                },
                finish_reason: 'stop'
            }],
            usage: {
                prompt_tokens: 10,
                completion_tokens: lastContent.length,
                total_tokens: 10 + lastContent.length
            }
        };
        
        return res.json(response);
    }
    
    res.status(500).json({ error: 'Response timeout' });
}

// API Routes
app.get('/v1/models', authenticate, async (req, res) => {
    try {
        const models = await getModels();
        const timestamp = Math.floor(Date.now() / 1000);
        
        const formattedModels = models.map(model => ({
            id: model.id,
            object: 'model',
            created: model.created_at || timestamp,
            owned_by: model.group
        }));
        
        res.json({
            object: 'list',
            data: formattedModels
        });
    } catch (error) {
        console.error('Error fetching models:', error);
        res.status(500).json({ error: 'Failed to fetch models', details: error.message });
    }
});

app.post('/v1/chat/completions', authenticate, handleChatCompletion);

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    await browserManager.close();
    db.close();
    process.exit(0);
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Models endpoint: http://localhost:${PORT}/v1/models`);
    console.log(`Chat endpoint: http://localhost:${PORT}/v1/chat/completions`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});
