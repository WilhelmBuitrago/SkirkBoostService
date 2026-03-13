const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const pool = require('./pool');

dotenv.config();

async function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await pool.query(sql);
    console.log(`Migration applied: ${file}`);
  }
}

runMigrations()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Migration error:', error);
    await pool.end();
    process.exit(1);
  });
