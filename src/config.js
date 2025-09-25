const dotenv = require('dotenv');
dotenv.config();

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

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

module.exports = {
  DEBUG: process.env.DEBUG === 'true',
  AUTH_TOKENS: (process.env.AUTH_TOKENS || 'sk-default,sk-none').split(','),
  BASE_URL: process.env.BASE_URL || 'https://minitoolai.com',
  MODEL_CACHE_DAYS: parseInt(process.env.MODEL_CACHE_DAYS || '7'),
  PORT: parseInt(process.env.PORT || '3000'),
  USER_AGENTS,
  MODEL_PATHS
};
