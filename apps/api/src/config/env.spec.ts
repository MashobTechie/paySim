import { EnvValidationError, loadEnv } from './env.js';

const valid = { DATABASE_URL: 'postgresql://user:pass@localhost:5433/paysim' };

describe('loadEnv', () => {
  it('applies defaults to a minimal valid environment', () => {
    const env = loadEnv(valid);
    expect(env).toMatchObject({ NODE_ENV: 'development', API_PORT: 4000, LOG_LEVEL: 'log' });
  });

  it('coerces API_PORT to an integer', () => {
    expect(loadEnv({ ...valid, API_PORT: '4100' }).API_PORT).toBe(4100);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow(EnvValidationError);
  });

  it('rejects a non-postgres DATABASE_URL and reports every issue', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://x@y/z', API_PORT: '99999' })).toThrow(
      /DATABASE_URL[\s\S]*API_PORT|API_PORT[\s\S]*DATABASE_URL/,
    );
  });
});
