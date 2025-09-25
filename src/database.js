const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { MODEL_CACHE_DAYS, DEBUG } = require('./config');

class Database {
  constructor() {
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(path.join(__dirname, '../data.db'), (err) => {
        if (err) {
          reject(err);
        } else {
          this.createTables().then(resolve).catch(reject);
        }
      });
    });
  }

  async createTables() {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(`
          CREATE TABLE IF NOT EXISTS models (
            id TEXT PRIMARY KEY,
            group_name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )
        `, (err) => {
          if (err) reject(err);
        });

        this.db.run(`
          CREATE TABLE IF NOT EXISTS cache (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  async saveModels(models) {
    const now = Date.now();
    const expires = now + (MODEL_CACHE_DAYS * 24 * 60 * 60 * 1000);

    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        // Clear old models
        this.db.run('DELETE FROM models', (err) => {
          if (err && DEBUG) console.error('Error clearing models:', err);
        });

        // Insert new models
        const stmt = this.db.prepare('INSERT INTO models (id, group_name, created_at, updated_at) VALUES (?, ?, ?, ?)');
        
        for (const model of models) {
          stmt.run(model.id, model.group, now, now);
        }
        
        stmt.finalize((err) => {
          if (err) reject(err);
          else {
            // Save cache timestamp
            this.setCache('models_updated', JSON.stringify({ timestamp: now }), expires)
              .then(() => resolve())
              .catch(reject);
          }
        });
      });
    });
  }

  async getModels() {
    return new Promise((resolve, reject) => {
      this.db.all('SELECT * FROM models', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  async isModelsCacheValid() {
    const cache = await this.getCache('models_updated');
    if (!cache) return false;
    
    try {
      const data = JSON.parse(cache);
      const now = Date.now();
      const expires = data.timestamp + (MODEL_CACHE_DAYS * 24 * 60 * 60 * 1000);
      return now < expires;
    } catch {
      return false;
    }
  }

  async setCache(key, value, expiresAt) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)',
        [key, value, expiresAt],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  }

  async getCache(key) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT value FROM cache WHERE key = ? AND expires_at > ?',
        [key, Date.now()],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? row.value : null);
        }
      );
    });
  }

  async findModelGroup(modelId) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT group_name FROM models WHERE id = ?',
        [modelId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row ? row.group_name : null);
        }
      );
    });
  }
}

module.exports = Database;
