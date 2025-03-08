const fs = require('fs');
const path = require('path');
const { db } = require('./voodoo');

const mappingFile = path.join(__dirname, 'Product ID List.txt');

fs.readFile(mappingFile, 'utf8', (err, data) => {
  if (err) {
    return console.error('[ERROR] Failed to read mapping file:', err.message);
  }
  
  // Split into lines and filter out empty/comment lines.
  const lines = data.split('\n').filter(line => {
    line = line.trim();
    return line && !line.startsWith('//') && !line.startsWith('-');
  });
  
  db.serialize(() => {
    // Prepare statements for both tables.
    const stmtProduct = db.prepare(`INSERT OR REPLACE INTO product_mapping (title, product_id, channel_id) VALUES (?, ?, ?)`);
    const stmtChannel = db.prepare(`INSERT OR REPLACE INTO channel_mapping (channel_id, product_id) VALUES (?, ?)`);
    
    lines.forEach(line => {
      // Expecting format: TITLE : SHOPIFY ID : CHANNEL ID
      const parts = line.split(':');
      if (parts.length >= 3) {
        const title = parts[0].trim();
        const shopifyId = parts[1].trim();
        const channelId = parts[2].trim();
        
        stmtProduct.run(title, shopifyId, channelId, err => {
          if (err) {
            console.error(`[ERROR] Inserting product mapping for "${title}":`, err.message);
          } else {
            console.log(`[INFO] Mapped product "${title}" -> ${shopifyId} with channel ${channelId}`);
          }
        });
        
        stmtChannel.run(channelId, shopifyId, err => {
          if (err) {
            console.error(`[ERROR] Inserting channel mapping for channel ${channelId}:`, err.message);
          } else {
            console.log(`[INFO] Mapped channel "${channelId}" -> ${shopifyId}`);
          }
        });
      } else {
        console.warn(`[WARN] Skipping malformed line: ${line}`);
      }
    });
    
    stmtProduct.finalize(err => {
      if (err) {
        console.error('[ERROR] Finalizing product mapping statement:', err.message);
      }
    });
    stmtChannel.finalize(err => {
      if (err) {
        console.error('[ERROR] Finalizing channel mapping statement:', err.message);
      } else {
        console.log('[INFO] DB population complete.');
      }
      process.exit(0);
    });
  });
});
