// The repository's generated Prisma client and pg adapter work against the Phase 3 schema,
// through the restricted paysim_app role, with exact BigInt money.
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { app, cfg, useDatabase } from './support/db.js';
import { createClaim, createProfile, createRun } from './support/fixtures.js';

useDatabase();

describe('generated Prisma client', () => {
  it('reads the catalogue and run-owned records as paysim_app with exact BigInt amounts', async () => {
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: cfg.paysimAppUrl }),
    });
    try {
      const { runId } = await createRun(await createProfile());
      await createClaim(app, runId, '9007199254740993');
      const operators = await prisma.syntheticOperator.findMany({
        include: { permissions: true },
        orderBy: { id: 'asc' },
      });
      // The five seeded operators (other suites may add test-only operators; the catalogue is insert-only).
      expect(operators.map((o) => o.id)).toEqual(
        expect.arrayContaining(['fin-02', 'ops-01', 'ops-07', 'recon-01', 'support-01']),
      );
      const run = await prisma.simulationRun.findUniqueOrThrow({
        where: { id: runId },
        include: { claims: true, banks: true },
      });
      expect(run.status).toBe('ACTIVE');
      expect(run.runReference).toMatch(/^RUN-\d{4,}$/);
      expect(run.claims[0]?.approvedPayableAmountMinor).toBe(9007199254740993n);
      expect(run.banks[0]?.providerCode).toBe('SIMBANK');
    } finally {
      await prisma.$disconnect();
    }
  });
});
