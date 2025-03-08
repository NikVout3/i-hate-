// auth-command.js - Command handler for license key authentication
const axios = require('axios');
require('dotenv').config();

// Easy-product-downloads API token
const EPD_API_TOKEN = process.env.EPD_API_TOKEN || '3dACRfbXfmMslsAHq7yDzuPykM30COW7lR8BZ3tnrRKuMb9twpCR5slRMC07';
const STRIPE_API_URL = process.env.STRIPE_API_URL || 'http://localhost:3000'; // Your Stripe server URL
const EASY_DOWNLOADS_API_URL = process.env.EASY_DOWNLOADS_API_URL || 'https://your-shopify-store.com/api/get-license-keys-by-order';

// State tracking for user conversations
const userState = new Map();

/**
 * Handles the authentication command flow
 * @param {Object} message - The Discord message object
 * @param {Object} client - The Discord client
 */
async function handleAuthCommand(message, client) {
  const userId = message.author.id;
  
  // Initial command to start the authentication process
  if (message.content.toLowerCase() === '!auth') {
    userState.set(userId, { 
      stage: 'awaiting_input',
      timestamp: Date.now()
    });
    
    return message.reply('Please provide your order number and session ID in the following format: `order_number session_id`');
  }
  
  // Check if user is in the authentication flow
  const state = userState.get(userId);
  if (!state || state.stage !== 'awaiting_input') {
    return; // Not in authentication flow
  }
  
  // Check for timeout (10 minutes)
  if (Date.now() - state.timestamp > 10 * 60 * 1000) {
    userState.delete(userId);
    return message.reply('Authentication session timed out. Please start again with `!auth`.');
  }
  
  // Extract order number and session ID from the message
  const parts = message.content.trim().split(/\s+/);
  if (parts.length !== 2) {
    return message.reply('Invalid format. Please provide your information as: `order_number session_id`');
  }
  
  const [orderNumber, sessionId] = parts;
  
  try {
    // Let the user know we're processing
    await message.reply('Verifying your information, please wait...');
    
    // First, verify that the session ID matches the order number via Stripe API
    const validationResult = await validateOrderSession(orderNumber, sessionId);
    
    if (!validationResult.valid) {
      userState.delete(userId);
      return message.reply('❌ Validation failed: The order number and session ID do not match or the order was not found.');
    }
    
    // If validation succeeds, fetch the license key from Easy-product-downloads
    const licenseResult = await fetchLicenseKey(orderNumber);
    
    if (licenseResult.success && licenseResult.keys && licenseResult.keys.length > 0) {
      // Success - send license key(s) via DM for security
      const dmChannel = await message.author.createDM();
      
      await dmChannel.send(`✅ **Verification successful!**\n\nHere are your license keys for order #${orderNumber}:`);
      
      // Send each key in a code block for easy copying
      for (const key of licenseResult.keys) {
        await dmChannel.send(`\`\`\`\n${key}\n\`\`\``);
      }
      
      // Reply in the public channel that keys were sent via DM
      await message.reply('✅ Verification successful! Your license key(s) have been sent via direct message.');
    } else {
      await message.reply('⚠️ Your order is valid, but we couldn\'t retrieve your license keys. Please contact support for assistance.');
    }
    
    // Clear the user state
    userState.delete(userId);
    
  } catch (error) {
    console.error('[ERROR] Authentication error:', error.message);
    message.reply('❌ An error occurred during verification. Please try again later or contact support.');
    userState.delete(userId);
  }
}

/**
 * Validates that a session ID matches an order number via Stripe API
 * @param {string} orderNumber - The Shopify order number
 * @param {string} sessionId - The Stripe session ID
 * @returns {Object} - Validation result { valid: boolean, order?: Object }
 */
async function validateOrderSession(orderNumber, sessionId) {
  try {
    const response = await axios.get(`${STRIPE_API_URL}/order-validation`, {
      params: {
        order_number: orderNumber,
        session_id: sessionId
      }
    });
    
    return { 
      valid: response.data.valid,
      order: response.data.order
    };
  } catch (error) {
    console.error('[ERROR] Order validation error:', error.message);
    return { valid: false };
  }
}

/**
 * Fetches license keys for an order from the Easy-product-downloads API
 * @param {string} orderNumber - The Shopify order number
 * @returns {Object} - Result with keys { success: boolean, keys?: string[] }
 */
async function fetchLicenseKey(orderNumber) {
  try {
    const response = await axios.get(EASY_DOWNLOADS_API_URL, {
      params: {
        order_number: orderNumber,
        api_token: EPD_API_TOKEN
      }
    });
    
    if (response.data && response.data.success && response.data.license_keys) {
      return {
        success: true,
        keys: response.data.license_keys
      };
    }
    
    return { success: false };
  } catch (error) {
    console.error('[ERROR] License key retrieval error:', error.message);
    return { success: false };
  }
}

module.exports = {
  handleAuthCommand
};
