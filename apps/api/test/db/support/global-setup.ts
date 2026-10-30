import { prepareTestDatabase } from '../../../scripts/test-db.mjs';

/**
 * Recreates the isolated *_test database from scratch and applies every migration, so each
 * suite run proves the migrations against a fresh database. Set TEST_DB_REUSE=1 to keep the
 * existing test database (faster local iteration).
 */
export default async function setup(): Promise<void> {
  await prepareTestDatabase({ recreate: process.env.TEST_DB_REUSE !== '1' });
}
