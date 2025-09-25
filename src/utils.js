const { AUTH_TOKENS, DEBUG } = require('./config');

function authenticateRequest(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    if (DEBUG) {
      console.log('Missing or invalid Authorization header');
    }
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.substring(7);
  
  if (!AUTH_TOKENS.includes(token)) {
    if (DEBUG) {
      console.log(`Invalid token: ${token}`);
    }
    return res.status(401).json({ error: 'Invalid token' });
  }

  next();
}

function errorHandler(err, req, res, next) {
  if (DEBUG) {
    console.error('Error:', err);
  }

  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';

  res.status(status).json({
    error: {
      message: message,
      type: err.type || 'error',
      code: err.code || null
    }
  });
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  authenticateRequest,
  errorHandler,
  asyncHandler
};
