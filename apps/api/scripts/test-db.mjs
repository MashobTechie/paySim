// Isolated test database management for the PaySim database integration suite.
//
//   node scripts/test-db.mjs prepare   create the test database if missing, apply migrations,
//                                      enable the app roles' LOGIN for tests
//   node scripts/test-db.mjs reset     DROP and recreate the test database, then prepare
//
// Safety: refuses to touch any database whose name does not end in "_test", or that equals
// the development database named in DATABASE_URL. The development database is never modified.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rootEnv = path.resolve(apiDir, '../../.env');
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export function testDatabaseConfig() {
  const devUrl = process.env.DATABASE_URL;
  if (!devUrl && !process.env.TEST_DATABASE_URL) {
    throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL, from which it is derived).');
  }
  const testUrl = new URL(process.env.TEST_DATABASE_URL ?? devUrl);
  if (!process.env.TEST_DATABASE_URL)
    testUrl.pathname = `${testUrl.pathname.replace(/^\//, '')}_test`;
  testUrl.searchParams.delete('schema');
  const testDb = decodeURIComponent(testUrl.pathname.replace(/^\//, ''));
  const devDb = devUrl
    ? decodeURIComponent(new URL(devUrl).pathname.replace(/^\//, ''))
    : undefined;
  if (!testDb.endsWith('_test'))
    throw new Error(`Refusing: test database "${testDb}" must end with "_test".`);
  if (testDb === devDb)
    throw new Error(`Refusing: test database equals the development database "${devDb}".`);

  const adminUrl = new URL(testUrl);
  adminUrl.pathname = '/postgres';
  const roleUrl = (role, password) => {
    const u = new URL(testUrl);
    u.username = role;
    u.password = password;
    return u.toString();
  };
  const paysimPassword = process.env.TEST_PAYSIM_APP_PASSWORD ?? 'paysim_app_test_only';
  const simbankPassword = process.env.TEST_SIMBANK_APP_PASSWORD ?? 'simbank_app_test_only';
  return {
    testDb,
    ownerUrl: testUrl.toString(),
    adminUrl: adminUrl.toString(),
    paysimAppUrl: roleUrl('paysim_app', paysimPassword),
    simbankAppUrl: roleUrl('simbank_app', simbankPassword),
    paysimPassword,
    simbankPassword,
  };
}

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function prepareTestDatabase({ recreate = false } = {}) {
  const cfg = testDatabaseConfig();
  await withClient(cfg.adminUrl, async (c) => {
    const ident = `"${cfg.testDb.replaceAll('"', '""')}"`;
    if (recreate) await c.query(`DROP DATABASE IF EXISTS ${ident} WITH (FORCE)`);
    const exists = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [cfg.testDb]);
    if (exists.rowCount === 0) await c.query(`CREATE DATABASE ${ident}`);
  });
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: apiDir,
    env: { ...process.env, DATABASE_URL: cfg.ownerUrl },
    stdio: process.env.TEST_DB_VERBOSE ? 'inherit' : 'pipe',
  });
  // Roles are cluster-wide and created NOLOGIN by the migrations; tests log in as them.
  await withClient(cfg.ownerUrl, async (c) => {
    await c.query(
      `ALTER ROLE paysim_app WITH LOGIN PASSWORD '${cfg.paysimPassword.replaceAll("'", "''")}'`,
    );
    await c.query(
      `ALTER ROLE simbank_app WITH LOGIN PASSWORD '${cfg.simbankPassword.replaceAll("'", "''")}'`,
    );
    await c.query(`GRANT CONNECT ON DATABASE "${cfg.testDb}" TO paysim_app, simbank_app`);
  });
  return cfg;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const cmd = process.argv[2];
  if (cmd !== 'prepare' && cmd !== 'reset') {
    console.error('usage: node scripts/test-db.mjs <prepare|reset>');
    process.exit(2);
  }
  const cfg = await prepareTestDatabase({ recreate: cmd === 'reset' });
  console.error(`test database ready: ${cfg.testDb}`);
}
