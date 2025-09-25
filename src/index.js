const express = require('express');
const cors = require('cors');
const { PORT, DEBUG } = require('./config');
const Database = require('./database');
const ModelManager = require('./models');
const ChatHandler = require('./chat');
const { authenticateRequest, errorHandler, asyncHandler } = require('./utils');

const app = express();
const database = new Database();
let modelManager;
let chatHandler;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Get models list
app.get('/v1/models', authenticateRequest, asyncHandler(async (req, res) => {
  if (DEBUG) {
    console.log('GET /v1/models');
  }
  
  const models = await modelManager.getModelsList();
  res.json(models);
}));

// Chat completions
app.post('/v1/chat/completions', authenticateRequest, asyncHandler(async (req, res) => {
  if (DEBUG) {
    console.log('POST /v1/chat/completions', req.body);
  }

  const { stream = false } = req.body;

  if (stream) {
    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    try {
      const chunks = await chatHandler.processChat(req.body);
      
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        
        // Add small delay to simulate streaming
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (error) {
      const errorChunk = {
        error: {
          message: error.message,
          type: 'error'
        }
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.end();
    }
  } else {
    const response = await chatHandler.processChat(req.body);
    res.json(response);
  }
}));

// Error handler
app.use(errorHandler);

// Initialize and start server
async function start() {
  try {
    console.log('Initializing database...');
    await database.init();
    
    modelManager = new ModelManager(database);
    chatHandler = new ChatHandler(database);
    
    console.log('Fetching initial models list...');
    await modelManager.getModelsList();
    
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      if (DEBUG) {
        console.log('Debug mode enabled');
      }
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  if (chatHandler) {
    await chatHandler.cleanup();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  if (chatHandler) {
    await chatHandler.cleanup();
  }
  process.exit(0);
});

// Start the server
start();
