const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(express.json());

// Environment variables with defaults
const DEBUG = process.env.DEBUG === 'true' || false;
const AUTH_TOKENS = (process.env.AUTH_TOKENS || 'sk-default,sk-none').split(',');
const BASE_URL = process.env.BASE_URL || 'https://minitoolai.com';
const MODEL_CACHE_DAYS = parseInt(process.env.MODEL_CACHE_DAYS || '7');
const PORT = process.env.PORT || 3000;

// User agents for random selection
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0'
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

// Initialize SQLite database
const db = new sqlite3.Database(':memory:');

// Create tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        group_name TEXT,
        path TEXT,
        created_at INTEGER
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS cache_metadata (
        key TEXT PRIMARY KEY,
        created_at INTEGER,
        expires_at INTEGER
    )`);
});

// Utility functions
function debugLog(...args) {
    if (DEBUG) {
        console.log('[DEBUG]', new Date().toISOString(), ...args);
    }
}

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function isTokenValid(token) {
    return AUTH_TOKENS.includes(token);
}

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }
    
    const token = authHeader.substring(7);
    if (!isTokenValid(token)) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    
    next();
}

// Function to fetch and parse models from a single path
async function fetchModelsFromPath(pathName) {
    try {
        debugLog(`Fetching models from path: ${pathName}`);
        
        const url = `${BASE_URL}/${pathName}/`;
        const userAgent = getRandomUserAgent();
        
        const response = await axios.get(url, {
            headers: {
                'Content-Type': 'text/html',
                'User-Agent': userAgent
            },
            timeout: 30000
        });
        
        const $ = cheerio.load(response.data);
        const models = [];
        
        // Find select element with id="select_model"
        const selectElement = $('#select_model');
        if (selectElement.length === 0) {
            debugLog(`No select_model element found in ${pathName}`);
            return [];
        }
        
        // Extract option values
        selectElement.find('option').each((index, element) => {
            const value = $(element).attr('value');
            if (value && value.trim()) {
                models.push({
                    id: value.trim(),
                    group: pathName.toLowerCase(),
                    path: pathName
                });
            }
        });
        
        debugLog(`Found ${models.length} models in ${pathName}:`, models.map(m => m.id));
        return models;
        
    } catch (error) {
        debugLog(`Error fetching models from ${pathName}:`, error.message);
        return [];
    }
}

// Function to fetch all models
async function fetchAllModels() {
    try {
        debugLog('Starting to fetch all models...');
        
        // Fetch models from all paths concurrently
        const promises = MODEL_PATHS.map(path => fetchModelsFromPath(path));
        const results = await Promise.all(promises);
        
        // Flatten results
        const allModels = results.flat();
        
        if (allModels.length === 0) {
            throw new Error('No models found from any path');
        }
        
        // Clear existing models and insert new ones
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run('DELETE FROM models', (err) => {
                    if (err) {
                        debugLog('Error clearing models table:', err);
                        return reject(err);
                    }
                });
                
                const stmt = db.prepare('INSERT INTO models (id, group_name, path, created_at) VALUES (?, ?, ?, ?)');
                const now = Math.floor(Date.now() / 1000);
                
                for (const model of allModels) {
                    stmt.run(model.id, model.group, model.path, now);
                }
                
                stmt.finalize((err) => {
                    if (err) {
                        debugLog('Error inserting models:', err);
                        return reject(err);
                    }
                    
                    // Update cache metadata
                    const expiresAt = now + (MODEL_CACHE_DAYS * 24 * 60 * 60);
                    db.run(
                        'INSERT OR REPLACE INTO cache_metadata (key, created_at, expires_at) VALUES (?, ?, ?)',
                        ['models', now, expiresAt],
                        (err) => {
                            if (err) {
                                debugLog('Error updating cache metadata:', err);
                                return reject(err);
                            }
                            
                            debugLog(`Successfully cached ${allModels.length} models`);
                            resolve(allModels);
                        }
                    );
                });
            });
        });
        
    } catch (error) {
        debugLog('Error in fetchAllModels:', error);
        throw error;
    }
}

// Function to get models from cache or fetch new ones
async function getModels() {
    return new Promise((resolve, reject) => {
        // Check if cache is still valid
        const now = Math.floor(Date.now() / 1000);
        
        db.get(
            'SELECT expires_at FROM cache_metadata WHERE key = ?',
            ['models'],
            async (err, row) => {
                if (err) {
                    debugLog('Error checking cache metadata:', err);
                    return reject(err);
                }
                
                // If cache exists and is not expired, return cached models
                if (row && row.expires_at > now) {
                    debugLog('Using cached models');
                    
                    db.all('SELECT * FROM models', (err, models) => {
                        if (err) {
                            debugLog('Error fetching cached models:', err);
                            return reject(err);
                        }
                        resolve(models);
                    });
                } else {
                    // Cache expired or doesn't exist, fetch new models
                    debugLog('Cache expired or missing, fetching new models...');
                    
                    try {
                        const models = await fetchAllModels();
                        resolve(models);
                    } catch (error) {
                        reject(error);
                    }
                }
            }
        );
    });
}

// Function to find model info by ID
function findModelById(modelId) {
    return new Promise((resolve, reject) => {
        db.get(
            'SELECT * FROM models WHERE id = ?',
            [modelId],
            (err, row) => {
                if (err) {
                    return reject(err);
                }
                resolve(row);
            }
        );
    });
}

// Function to format messages for browser input
function formatMessages(messages) {
    return messages.map(msg => `${msg.role}:${msg.content}`).join(';');
}

// Function to simulate browser interaction
async function simulateBrowserInteraction(modelPath, modelId, temperature, formattedMessages, stream) {
    let browser = null;
    let page = null;
    
    try {
        debugLog(`Starting browser simulation for model ${modelId} on path ${modelPath}`);
        
        // Launch browser
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        });
        
        page = await browser.newPage();
        
        // Set user agent
        await page.setUserAgent(getRandomUserAgent());
        
        // Navigate to the model page
        const url = `${BASE_URL}/${modelPath}/`;
        debugLog(`Navigating to: ${url}`);
        
        await page.goto(url, { 
            waitUntil: 'networkidle2',
            timeout: 60000 
        });
        
        // Wait for page to be fully loaded
        await page.waitForSelector('#select_model', { timeout: 30000 });
        await page.waitForSelector('#message', { timeout: 30000 });
        
        // Select the model
        debugLog(`Selecting model: ${modelId}`);
        await page.select('#select_model', modelId);
        
        // Set temperature if provided and within valid range
        if (temperature !== undefined && temperature >= 0.0 && temperature <= 2.0) {
            debugLog(`Setting temperature to: ${temperature}`);
            
            // Check if temperature input exists and get its constraints
            const tempInput = await page.$('#temperature');
            if (tempInput) {
                const minVal = await page.$eval('#temperature', el => parseFloat(el.min) || 0.0);
                const maxVal = await page.$eval('#temperature', el => parseFloat(el.max) || 2.0);
                
                // Only set temperature if it's within the input's range
                if (temperature >= minVal && temperature <= maxVal) {
                    await page.evaluate((temp) => {
                        const input = document.getElementById('temperature');
                        if (input) {
                            input.value = temp.toString();
                        }
                    }, temperature);
                } else {
                    debugLog(`Temperature ${temperature} is outside valid range [${minVal}, ${maxVal}], using default`);
                }
            }
        }
        
        // Input the formatted messages
        debugLog(`Inputting messages: ${formattedMessages.substring(0, 100)}...`);
        await page.type('#message', formattedMessages);
        
        // Click send button
        debugLog('Clicking send button...');
        await page.click('#send-button');
        
        // Wait for response to start appearing
        await page.waitForSelector('.chatbot-message', { timeout: 60000 });
        
        // Wait for response to complete
        let response = '';
        let attempts = 0;
        const maxAttempts = 120; // 2 minutes with 1 second intervals
        
        while (attempts < maxAttempts) {
            try {
                // Check if there's a copy button (indicates completion)
                const copyButton = await page.$('.copyres');
                if (copyButton) {
                    // Get the complete response
                    response = await page.evaluate(() => {
                        const responseElements = document.querySelectorAll('.response');
                        if (responseElements.length === 0) return '';
                        
                        const lastResponse = responseElements[responseElements.length - 1];
                        return lastResponse.textContent || lastResponse.innerText || '';
                    });
                    
                    if (response && response.trim()) {
                        // Clean up response (remove "Copy" button text if present)
                        response = response.replace(/Copy$/, '').replace(/Copied!$/, '').trim();
                        debugLog(`Got complete response: ${response.substring(0, 100)}...`);
                        break;
                    }
                }
                
                // Check for loading indicators
                const loadingIndicators = await page.$$('.loading, .typing-indicator, .waiting');
                if (loadingIndicators.length === 0) {
                    // No loading indicators, try to get response
                    const tempResponse = await page.evaluate(() => {
                        const responseElements = document.querySelectorAll('.response');
                        if (responseElements.length === 0) return '';
                        
                        const lastResponse = responseElements[responseElements.length - 1];
                        return lastResponse.textContent || lastResponse.innerText || '';
                    });
                    
                    if (tempResponse && tempResponse.trim()) {
                        response = tempResponse.replace(/Copy$/, '').replace(/Copied!$/, '').trim();
                        debugLog(`Got response without copy button: ${response.substring(0, 100)}...`);
                        break;
                    }
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;
                
            } catch (error) {
                debugLog(`Error while waiting for response (attempt ${attempts}):`, error.message);
                attempts++;
            }
        }
        
        if (!response) {
            throw new Error('No response received within timeout period');
        }
        
        return response;
        
    } catch (error) {
        debugLog('Error in browser simulation:', error);
        throw error;
    } finally {
        if (page) {
            await page.close().catch(err => debugLog('Error closing page:', err));
        }
        if (browser) {
            await browser.close().catch(err => debugLog('Error closing browser:', err));
        }
    }
}

// API Routes

// GET /v1/models - List available models
app.get('/v1/models', authMiddleware, async (req, res) => {
    try {
        debugLog('Received request for models list');
        
        const models = await getModels();
        
        const response = {
            object: 'list',
            data: models.map(model => ({
                id: model.id,
                object: 'model',
                created: model.created_at,
                owned_by: model.group_name
            }))
        };
        
        debugLog(`Returning ${models.length} models`);
        res.json(response);
        
    } catch (error) {
        debugLog('Error in /v1/models:', error);
        res.status(500).json({
            error: {
                message: 'Failed to fetch models',
                type: 'internal_server_error'
            }
        });
    }
});

// POST /v1/chat/completions - Chat completion
app.post('/v1/chat/completions', authMiddleware, async (req, res) => {
    try {
        debugLog('Received chat completion request');
        
        const { messages, stream = false, temperature, model } = req.body;
        
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                error: {
                    message: 'Messages array is required and must not be empty',
                    type: 'invalid_request_error'
                }
            });
        }
        
        if (!model) {
            return res.status(400).json({
                error: {
                    message: 'Model is required',
                    type: 'invalid_request_error'
                }
            });
        }
        
        // Find model information
        let modelInfo = await findModelById(model);
        
        if (!modelInfo) {
            debugLog(`Model ${model} not found in cache, refreshing...`);
            // Model not found, refresh cache and try again
            try {
                await fetchAllModels();
                modelInfo = await findModelById(model);
            } catch (error) {
                debugLog('Error refreshing models cache:', error);
            }
        }
        
        if (!modelInfo) {
            return res.status(400).json({
                error: {
                    message: `Model '${model}' not found`,
                    type: 'invalid_request_error'
                }
            });
        }
        
        // Format messages
        const formattedMessages = formatMessages(messages);
        debugLog(`Using model: ${model} from path: ${modelInfo.path}`);
        
        // Generate response ID
        const responseId = `chatcmpl-${uuidv4()}`;
        const created = Math.floor(Date.now() / 1000);
        
        if (stream) {
            // Streaming response
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': '*'
            });
            
            try {
                // Send initial chunk
                const initialChunk = {
                    id: responseId,
                    object: 'chat.completion.chunk',
                    created: created,
                    model: model,
                    choices: [{
                        index: 0,
                        delta: {
                            role: 'assistant',
                            content: null
                        },
                        logprobs: null,
                        finish_reason: null
                    }]
                };
                
                res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);
                
                // Get response from browser simulation
                const response = await simulateBrowserInteraction(
                    modelInfo.path,
                    model,
                    temperature,
                    formattedMessages,
                    true
                );
                
                // Split response into chunks and send them
                const words = response.split(' ');
                for (let i = 0; i < words.length; i++) {
                    const chunk = {
                        id: responseId,
                        object: 'chat.completion.chunk',
                        created: created,
                        model: model,
                        choices: [{
                            index: 0,
                            delta: {
                                content: (i === 0 ? words[i] : ' ' + words[i])
                            },
                            logprobs: null,
                            finish_reason: null
                        }]
                    };
                    
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                    
                    // Small delay between chunks
                    await new Promise(resolve => setTimeout(resolve, 50));
                }
                
                // Send finish chunk
                const finishChunk = {
                    id: responseId,
                    object: 'chat.completion.chunk',
                    created: created,
                    model: model,
                    choices: [{
                        index: 0,
                        delta: {},
                        logprobs: null,
                        finish_reason: 'stop'
                    }],
                    usage: {
                        prompt_tokens: formattedMessages.length,
                        completion_tokens: response.length,
                        total_tokens: formattedMessages.length + response.length
                    }
                };
                
                res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                
            } catch (error) {
                debugLog('Error in streaming response:', error);
                const errorChunk = {
                    id: responseId,
                    object: 'chat.completion.chunk',
                    created: created,
                    model: model,
                    choices: [{
                        index: 0,
                        delta: {
                            content: `Error: ${error.message}`
                        },
                        logprobs: null,
                        finish_reason: 'stop'
                    }]
                };
                
                res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            }
            
        } else {
            // Non-streaming response
            try {
                const response = await simulateBrowserInteraction(
                    modelInfo.path,
                    model,
                    temperature,
                    formattedMessages,
                    false
                );
                
                const completionResponse = {
                    id: responseId,
                    object: 'chat.completion',
                    created: created,
                    model: model,
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: response
                        },
                        finish_reason: 'stop'
                    }],
                    usage: {
                        prompt_tokens: formattedMessages.length,
                        completion_tokens: response.length,
                        total_tokens: formattedMessages.length + response.length
                    }
                };
                
                res.json(completionResponse);
                
            } catch (error) {
                debugLog('Error in non-streaming response:', error);
                res.status(500).json({
                    error: {
                        message: error.message,
                        type: 'internal_server_error'
                    }
                });
            }
        }
        
    } catch (error) {
        debugLog('Error in /v1/chat/completions:', error);
        res.status(500).json({
            error: {
                message: 'Internal server error',
                type: 'internal_server_error'
            }
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Debug mode: ${DEBUG}`);
    console.log(`Auth tokens: ${AUTH_TOKENS.length} configured`);
    console.log(`Base URL: ${BASE_URL}`);
    console.log(`Model cache expires after: ${MODEL_CACHE_DAYS} days`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down gracefully...');
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err);
        } else {
            console.log('Database connection closed.');
        }
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down gracefully...');
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err);
        } else {
            console.log('Database connection closed.');
        }
        process.exit(0);
    });
});
