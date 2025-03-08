const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'channelMapping.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('[ERROR] Could not connect to database:', err.message);
  } else {
    console.log('[INFO] Connected to SQLite database at', dbPath);
  }
});

// Create channel_mapping table if it doesn't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS channel_mapping (
      channel_id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL
    )
  `, (err) => {
    if (err) {
      console.error('[ERROR] Failed to create channel_mapping table:', err.message);
    } else {
      console.log('[INFO] channel_mapping table is ready.');
    }
  });
});

// Create product_mapping table with an extra column for channel_id.
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS product_mapping (
      title TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      channel_id TEXT
    )
  `, (err) => {
    if (err) {
      console.error('[ERROR] Failed to create product_mapping table:', err.message);
    } else {
      console.log('[INFO] product_mapping table is ready.');
    }
  });
});

// Lookup product id by title (case-insensitive)
function getProductIdForTitle(title) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT product_id FROM product_mapping WHERE lower(title)=lower(?)`, [title], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row ? row.product_id : null);
      }
    });
  });
}

// Lookup product id by channel id
function getProductIdForChannel(channelId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT product_id FROM channel_mapping WHERE channel_id = ?`, [channelId], (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row ? row.product_id : null);
      }
    });
  });
}

module.exports = {
  getProductIdForChannel,
  getProductIdForTitle,
  db
};
