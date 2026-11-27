import { createDatabase } from './client.js';

const dbUrl = process.env.DATABASE_URL || './data/mj-assistant.db';
const handle = createDatabase(dbUrl);
console.log(`SQLite migrations verified at: ${handle.filePath}`);
handle.close();
