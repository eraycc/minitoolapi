const axios = require('axios');
const cheerio = require('cheerio');
const { BASE_URL, USER_AGENTS, MODEL_PATHS, DEBUG } = require('./config');

class ModelManager {
  constructor(database) {
    this.database = database;
  }

  getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  }

  async fetchModelsFromPage(path) {
    try {
      const url = `${BASE_URL}/${path}/`;
      const response = await axios.get(url, {
        headers: {
          'Content-Type': 'text/html',
          'User-Agent': this.getRandomUserAgent()
        }
      });

      const $ = cheerio.load(response.data);
      const models = [];
      
      $('#select_model option').each((index, element) => {
        const value = $(element).attr('value');
        if (value) {
          models.push({
            id: value,
            group: path.toLowerCase()
          });
        }
      });

      if (DEBUG) {
        console.log(`Fetched ${models.length} models from ${path}`);
      }

      return models;
    } catch (error) {
      if (DEBUG) {
        console.error(`Error fetching models from ${path}:`, error.message);
      }
      return [];
    }
  }

  async fetchAllModels() {
    const allPromises = MODEL_PATHS.map(path => this.fetchModelsFromPage(path));
    const results = await Promise.all(allPromises);
    
    const allModels = results.flat();
    
    if (DEBUG) {
      console.log(`Total models fetched: ${allModels.length}`);
    }
    
    return allModels;
  }

  async getModelsList(forceRefresh = false) {
    // Check if cache is valid
    if (!forceRefresh) {
      const isValid = await this.database.isModelsCacheValid();
      if (isValid) {
        const cachedModels = await this.database.getModels();
        if (cachedModels.length > 0) {
          if (DEBUG) {
            console.log('Using cached models');
          }
          return this.formatModelsResponse(cachedModels);
        }
      }
    }

    // Fetch fresh models
    if (DEBUG) {
      console.log('Fetching fresh models from websites');
    }
    
    const models = await this.fetchAllModels();
    
    if (models.length > 0) {
      await this.database.saveModels(models);
    }
    
    return this.formatModelsResponse(models);
  }

  formatModelsResponse(models) {
    const now = Math.floor(Date.now() / 1000);
    
    return {
      object: 'list',
      data: models.map(model => ({
        id: model.id,
        object: 'model',
        created: now,
        owned_by: model.group_name || model.group
      }))
    };
  }
}

module.exports = ModelManager;
