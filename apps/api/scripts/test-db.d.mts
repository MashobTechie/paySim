export interface TestDatabaseConfig {
  testDb: string;
  ownerUrl: string;
  adminUrl: string;
  paysimAppUrl: string;
  simbankAppUrl: string;
  paysimPassword: string;
  simbankPassword: string;
}
export function testDatabaseConfig(): TestDatabaseConfig;
export function prepareTestDatabase(options?: { recreate?: boolean }): Promise<TestDatabaseConfig>;
