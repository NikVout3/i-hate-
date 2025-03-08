const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');
require('dotenv').config();
const { getProductIdForTitle, getProductIdForChannel } = require('./voodoo');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const PRODUCT_API_ENDPOINT = process.env.PRODUCT_API_ENDPOINT;
if (!PRODUCT_API_ENDPOINT) {
  console.error('[ERROR] PRODUCT_API_ENDPOINT is not defined in the environment variables.');
  process.exit(1);
}
const API_SECRET = process.env.API_SECRET;
if (!API_SECRET) {
  console.error('[ERROR] API_SECRET is not defined in the environment variables.');
  process.exit(1);
}
const DEFAULT_PRODUCT_ID = process.env.DEFAULT_PRODUCT_ID || 'unknown';

// Cache to store last known tag for each channel (by channel id)
// If a channel is marked "ignored", it means no mapping was found and we stop scanning it.
const channelStatusCache = {};

/**
 * Determine tag by scanning the full channel name for specific emoji or keywords.
 */
function determineTagFromChannel(channelName) {
  const workingEmojiRegex = /\u{1F7E2}/gu;   // ??
  const downEmojiRegex = /\u{1F534}/gu;       // ??
  const updatingEmojiRegex = /\u{1F7E1}/gu;   // ??

  if (workingEmojiRegex.test(channelName)) return 'working';
  if (downEmojiRegex.test(channelName)) return 'down';
  if (updatingEmojiRegex.test(channelName)) return 'updating';

  const lowerName = channelName.toLowerCase();
  if (lowerName.includes('work')) return 'working';
  if (lowerName.includes('test')) return 'down';
  if (lowerName.includes('update')) return 'updating';

  return 'unknown';
}

/**
 * Helper function to remove emojis from a string.
 */
function removeEmojis(str) {
  return str.replace(/[\u{1F300}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{1FB00}-\u{1FBFF}]/gu, '').trim();
}

/**
 * Update product status by calling the API.
 */
async function updateProductStatus(newTag, productTitle, productId) {
  if (productId === DEFAULT_PRODUCT_ID || productId === 'unknown') {
    console.warn('[WARN] Skipping update because productId is invalid.');
    return;
  }
  try {
    const response = await axios.post(PRODUCT_API_ENDPOINT, {
      tag: newTag,
      title: productTitle,
      productId: productId
    }, {
      headers: { 'Authorization': `Bearer ${API_SECRET}` }
    });
    console.log('[INFO] Product updated:', response.data);
  } catch (error) {
    console.error('[ERROR] Error updating product:', error.response ? error.response.data : error.message);
  }
}

/**
 * Periodic channel scan for status updates based solely on channel names.
 */
client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);

  // Change the interval from 60000 (1 minute) to 3600000 (1 hour)
  setInterval(async () => {
    console.log('[INFO] Starting periodic channel scan for status updates.');

    // Process each guild asynchronously
    const guildPromises = client.guilds.cache.map(async guild => {
      const channels = guild.channels.cache.filter(channel => channel.isTextBased());
      await Promise.all(channels.map(async channel => {
        const channelName = channel.name;

        // If the channel is already marked as "ignored", skip it.
        if (channelStatusCache[channel.id] === 'ignored') {
          console.log(`[INFO] [Scan] Channel "${channelName}" previously ignored. Skipping.`);
          return;
        }

        const newTag = determineTagFromChannel(channelName);
        console.log(`[INFO] [Scan] Channel "${channelName}" status determined as "${newTag}"`);

        // Check cache to see if the tag changed.
        const lastTag = channelStatusCache[channel.id];
        if (lastTag && lastTag === newTag) {
          console.log(`[INFO] [Scan] No status change for channel "${channelName}". Skipping update.`);
          return;
        }

        // First, try to look up product id by channel mapping.
        let productId;
        try {
          productId = await getProductIdForChannel(channel.id);
          if (!productId) {
            const cleanedTitle = removeEmojis(channelName);
            productId = await getProductIdForTitle(cleanedTitle.toLowerCase());
            if (productId) {
              console.log(`[INFO] [Scan] Found product mapping for cleaned title "${cleanedTitle}" as: "${productId}"`);
            } else {
              console.warn(`[WARN] [Scan] No product mapping found for channel "${channelName}" (ID: ${channel.id}). Marking channel as ignored.`);
              channelStatusCache[channel.id] = 'ignored'; // Mark this channel so it won't be scanned again.
              return;
            }
          }
        } catch (err) {
          console.error(`[ERROR] [Scan] DB lookup failed for channel "${channelName}":`, err.message);
          return;
        }

        const productTitle = channelName;
        // Update status only if newTag isn't "unknown"
        if (newTag !== 'unknown') {
          await updateProductStatus(newTag, productTitle, productId);
          // Update cache with the new status.
          channelStatusCache[channel.id] = newTag;
        }
      }));
    });

    // Wait until all guilds have been processed
    await Promise.all(guildPromises);
    console.log('[INFO] Cycle complete. Waiting 30 minutes for the next cycle...');
  }, 1800000); // every 1 hour (3600000 milliseconds)
});

client.on('error', error => console.error('[ERROR] Discord client error:', error));
process.on('unhandledRejection', error => {
  console.error('[ERROR] Unhandled promise rejection:', error);
});

client.login(DISCORD_BOT_TOKEN).catch(error => {
  console.error('[ERROR] Failed to login:', error);
  process.exit(1);
});
