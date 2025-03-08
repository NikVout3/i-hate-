const express = require('express');
const axios = require('axios');
const winston = require('winston');
require('dotenv').config();

const app = express();
app.use(express.json());

const API_SECRET = process.env.API_SECRET;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'api.log' })
  ]
});

// This function updates a product's tag on your Shopify store.
async function updateShopifyProductTag(productId, tag) {
  try {
    // Construct the payload as expected by Shopify.
    const payload = {
      product: {
        id: productId,
        tags: tag
      }
    };

    // Use Shopify Admin API endpoint.
    const response = await axios.put(
      `https://${SHOPIFY_STORE}/admin/api/2023-07/products/${productId}.json`,
      payload,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );
    logger.info(`Updated product ${productId} with tag "${tag}": HTTP ${response.status}`);
    return response.data;
  } catch (error) {
    logger.error(`Failed to update product ${productId}: ${error.message}`);
    throw error;
  }
}
    async function updateShopifyStatusPage(htmlContent) {
      // Replace with your actual status page ID.
      // You can store this in the .env file as, for example, STATUS_PAGE_ID.
      const statusPageId = process.env.STATUS_PAGE_ID;
      if (!statusPageId) {
        logger.error('STATUS_PAGE_ID not defined in the environment variables.');
        return;
      }
      
      try {
        const payload = {
          page: {
            id: statusPageId,
            body_html: htmlContent
          }
        };
    
        const response = await axios.put(
          `https://${SHOPIFY_STORE}/admin/api/2023-07/pages/${statusPageId}.json`,
          payload,
          {
            headers: {
              'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
              'Content-Type': 'application/json'
            }
          }
        );
        logger.info(`Updated status page ${statusPageId} with new content: HTTP ${response.status}`);
      } catch (error) {
        logger.error(`Failed to update status page ${statusPageId}: ${error.message}`);
      }
    }


app.post('/api/update-product-tag', async (req, res) => {
  const auth = req.headers['authorization'] || req.headers['Authorization'];
  if (!auth || auth !== `Bearer ${API_SECRET}`) {
    logger.warn('Unauthorized access attempt');
    return res.status(401).send('Unauthorized');
  }

  const { tag, productId } = req.body;
  if (typeof tag !== 'string' || !productId) {
    logger.warn('Invalid tag or missing product id');
    return res.status(400).send('Invalid tag or missing product id');
  }

  logger.info(`Received request to update product ${productId} tag to: ${tag}`);
  logger.info(`Updating product ${productId} tag to: ${tag}`);

  // Update the product tag on Shopify.
  try {
    await updateShopifyProductTag(productId, tag);
    res.json({ success: true, productId, tag });
  } catch (error) {
    logger.error(`Error updating product tag: ${error.message}`);
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  logger.info(`API server running on port ${PORT}`);
  logger.info(`API server running on port ${PORT}`);
});
