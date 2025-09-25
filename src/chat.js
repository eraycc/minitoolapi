const puppeteer = require('puppeteer');
const { v4: uuidv4 } = require('uuid');
const { BASE_URL, DEBUG } = require('./config');

class ChatHandler {
  constructor(database) {
    this.database = database;
    this.browser = null;
  }

  async initBrowser() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });
    }
    return this.browser;
  }

  async processChat(requestBody) {
    const { messages, stream = false, temperature, model } = requestBody;
    
    // Find model group
    let modelGroup = await this.database.findModelGroup(model);
    
    // If model not found in cache, refresh and try again
    if (!modelGroup) {
      if (DEBUG) {
        console.log(`Model ${model} not found in cache, refreshing...`);
      }
      
      const ModelManager = require('./models');
      const modelManager = new ModelManager(this.database);
      await modelManager.getModelsList(true);
      
      modelGroup = await this.database.findModelGroup(model);
      
      if (!modelGroup) {
        throw new Error(`Model ${model} not found`);
      }
    }

    // Format messages
    const formattedMessages = this.formatMessages(messages);
    
    // Process with browser
    const response = await this.sendToBrowser(
      modelGroup,
      model,
      formattedMessages,
      temperature
    );

    // Format response based on stream parameter
    if (stream) {
      return this.formatStreamResponse(response, model);
    } else {
      return this.formatNonStreamResponse(response, model);
    }
  }

  formatMessages(messages) {
    return messages
      .map(msg => `${msg.role}:${msg.content}`)
      .join(';');
  }

  async sendToBrowser(modelGroup, modelId, messages, temperature) {
    const browser = await this.initBrowser();
    const page = await browser.newPage();
    
    try {
      // Navigate to the model page
      const url = `${BASE_URL}/${modelGroup}/`;
      await page.goto(url, { waitUntil: 'networkidle2' });

      // Select the model
      await page.select('#select_model', modelId);

      // Set temperature if provided
      if (temperature !== undefined) {
        await page.evaluate((temp) => {
          const tempInput = document.querySelector('#temperature');
          if (tempInput) {
            tempInput.value = temp;
          }
        }, temperature);
      }

      // Input message
      await page.type('#message', messages);

      // Click send button
      await page.click('#send-button');

      // Wait for response
      const response = await this.waitForResponse(page);
      
      return response;
    } finally {
      await page.close();
    }
  }

  async waitForResponse(page, timeout = 60000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        // Check if response is complete
        const hasResponse = await page.evaluate(() => {
          const copyButton = document.querySelector('.copyres');
          return copyButton !== null;
        });

        if (hasResponse) {
          // Extract the response text
          const responseText = await page.evaluate(() => {
            const responseDiv = document.querySelector('.response');
            if (!responseDiv) return null;
            
            // Get text content, excluding the copy button
            const clone = responseDiv.cloneNode(true);
            const copyBtn = clone.querySelector('.copyres');
            if (copyBtn) copyBtn.remove();
            
            return clone.textContent.trim();
          });

          // Check for reasoning content (for models that support it)
          const reasoningContent = await page.evaluate(() => {
            const reasoningDiv = document.querySelector('.responseReasoning');
            return reasoningDiv ? reasoningDiv.textContent.trim() : null;
          });

          return {
            content: responseText,
            reasoning: reasoningContent
          };
        }
      } catch (error) {
        if (DEBUG) {
          console.error('Error waiting for response:', error);
        }
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    throw new Error('Response timeout');
  }

  formatNonStreamResponse(response, model) {
    const messageId = `chatcmpl-${Date.now()}`;
    const timestamp = Math.floor(Date.now() / 1000);

    const message = {
      role: 'assistant',
      content: response.content
    };

    if (response.reasoning) {
      message.reasoning_content = response.reasoning;
    }

    return {
      id: messageId,
      object: 'chat.completion',
      created: timestamp,
      model: model,
      choices: [{
        index: 0,
        message: message,
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };
  }

  formatStreamResponse(response, model) {
    const chunks = [];
    const messageId = uuidv4();
    const timestamp = Math.floor(Date.now() / 1000);

    // First chunk - role
    chunks.push({
      id: messageId,
      object: 'chat.completion.chunk',
      created: timestamp,
      model: model,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          content: null,
          reasoning_content: response.reasoning ? '' : null
        },
        logprobs: null,
        finish_reason: null
      }]
    });

    // Reasoning chunks if present
    if (response.reasoning) {
      const reasoningChunks = this.splitIntoChunks(response.reasoning, 10);
      for (const chunk of reasoningChunks) {
        chunks.push({
          id: messageId,
          object: 'chat.completion.chunk',
          created: timestamp,
          model: model,
          choices: [{
            index: 0,
            delta: {
              content: null,
              reasoning_content: chunk
            },
            finish_reason: null
          }]
        });
      }
    }

    // Content chunks
    const contentChunks = this.splitIntoChunks(response.content, 10);
    for (const chunk of contentChunks) {
      chunks.push({
        id: messageId,
        object: 'chat.completion.chunk',
        created: timestamp,
        model: model,
        choices: [{
          index: 0,
          delta: {
            content: chunk,
            reasoning_content: null
          },
          finish_reason: null
        }]
      });
    }

    // Final chunk with usage
    chunks.push({
      id: messageId,
      object: 'chat.completion.chunk',
      created: timestamp,
      model: model,
      choices: [{
        index: 0,
        delta: {
          content: '',
          reasoning_content: null
        },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    });

    return chunks;
  }

  splitIntoChunks(text, chunkSize) {
    const chunks = [];
    const words = text.split(' ');
    
    for (let i = 0; i < words.length; i += chunkSize) {
      const chunk = words.slice(i, i + chunkSize).join(' ');
      if (i + chunkSize < words.length) {
        chunks.push(chunk + ' ');
      } else {
        chunks.push(chunk);
      }
    }
    
    return chunks;
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

module.exports = ChatHandler;
