import { createDatabase, loadRootEnvIntoProcess, resolveSqlitePath } from './client.js';

const rootDir = loadRootEnvIntoProcess();
const rawDbUrl = process.env.DATABASE_URL || './data/mj-assistant.db';
const resolvedPath = resolveSqlitePath(rawDbUrl, rootDir);
const handle = createDatabase(resolvedPath);
console.log(`SQLite migrations verified at: ${handle.filePath}`);
handle.close();
