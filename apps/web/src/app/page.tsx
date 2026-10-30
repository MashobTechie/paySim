import { STATE_MACHINE_PACKAGE } from '@paysim/state-machine';
import { TEST_ENGINE_PACKAGE } from '@paysim/test-engine';
import { PageHeader } from '@/components/app-shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { API_URL, getApiHealth, type HealthResult } from '@/lib/api';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Dashboard' };

type Readiness = 'ready' | 'reserved';

const MODULES: { name: string; area: string; readiness: Readiness }[] = [
  { name: 'Health & observability', area: 'infrastructure', readiness: 'ready' },
  { name: 'Database (Prisma / PostgreSQL)', area: 'infrastructure', readiness: 'ready' },
  { name: 'Payments', area: 'simulate', readiness: 'reserved' },
  { name: 'Claims', area: 'simulate', readiness: 'reserved' },
  { name: 'Events & webhooks', area: 'simulate', readiness: 'reserved' },
  { name: 'State machine', area: 'core', readiness: 'reserved' },
  { name: 'Failure injection', area: 'reliability', readiness: 'reserved' },
  { name: 'Replay', area: 'reliability', readiness: 'reserved' },
  { name: 'Test runs', area: 'reliability', readiness: 'reserved' },
];

const PACKAGES = [
  { name: '@paysim/shared-types', status: 'active' },
  STATE_MACHINE_PACKAGE,
  TEST_ENGINE_PACKAGE,
] as const;

const INVARIANTS = [
  'Money is integer minor units — never floating point.',
  'Every state change passes a validated transition.',
  'Every event is independently traceable.',
  'Duplicate delivery never duplicates a financial effect.',
  'Replays never mutate original records.',
  'Synthetic data only — no real banks or providers.',
];

export default async function DashboardPage() {
  const health = await getApiHealth();

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Foundation status for the PaySim simulator."
        actions={<SystemBadge health={health} />}
      />

      <div className="grid gap-6 p-8 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>System</CardTitle>
            <CardDescription>
              Live probe of <span className="font-mono text-xs">{API_URL}/health</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <HealthTable health={health} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Invariants</CardTitle>
            <CardDescription>Rules every feature must uphold.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2.5 text-sm">
              {INVARIANTS.map((rule, i) => (
                <li key={rule} className="flex gap-3">
                  <span className="font-mono text-xs leading-5 text-muted-foreground tabular-nums">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span>{rule}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Modules</CardTitle>
            <CardDescription>API modules registered in the modular monolith.</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-y bg-muted/50 text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Module</th>
                  <th className="px-4 py-2 font-medium">Area</th>
                  <th className="px-4 py-2 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {MODULES.map((m) => (
                  <tr key={m.name}>
                    <td className="px-4 py-2.5">{m.name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                      {m.area}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <StatusDot tone={m.readiness === 'ready' ? 'success' : 'muted'}>
                        {m.readiness === 'ready' ? 'Ready' : 'Not implemented'}
                      </StatusDot>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workspace packages</CardTitle>
            <CardDescription>Resolved from the monorepo at build time.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2.5">
              {PACKAGES.map((pkg) => (
                <li key={pkg.name} className="flex items-center justify-between gap-3">
                  <span className="font-mono text-xs">{pkg.name}</span>
                  <Badge variant={pkg.status === 'active' ? 'secondary' : 'outline'}>
                    {pkg.status}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function SystemBadge({ health }: { health: HealthResult }) {
  if (!health.reachable) return <StatusDot tone="destructive">API unreachable</StatusDot>;
  return health.health.status === 'ok' ? (
    <StatusDot tone="success">All systems operational</StatusDot>
  ) : (
    <StatusDot tone="warning">Degraded</StatusDot>
  );
}

function HealthTable({ health }: { health: HealthResult }) {
  if (!health.reachable) {
    return (
      <p className="text-sm text-muted-foreground">
        Could not reach the API ({health.error}). Start it with{' '}
        <code className="font-mono text-xs">pnpm dev</code>.
      </p>
    );
  }

  const { health: h } = health;
  const db = h.checks.database;

  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-6 gap-y-3 text-sm">
      <Row label="Service">
        <span className="font-mono text-xs">{h.service}</span>
      </Row>
      <Row label="Version">
        <span className="font-mono text-xs">{h.version}</span>
      </Row>
      <Row label="Uptime">
        <span className="font-mono text-xs tabular-nums">{h.uptimeSeconds}s</span>
      </Row>
      <Row label="PostgreSQL">
        <StatusDot tone={db.status === 'up' ? 'success' : 'destructive'}>
          {db.status === 'up'
            ? `Up · ${db.latencyMs ?? '–'} ms`
            : `Down · ${db.error ?? 'unknown'}`}
        </StatusDot>
      </Row>
      <Row label="Checked at">
        <span className="font-mono text-xs">{h.timestamp}</span>
      </Row>
    </dl>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

const TONES = {
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground/40',
} as const;

function StatusDot({ tone, children }: { tone: keyof typeof TONES; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className={cn('size-2 rounded-full', TONES[tone])} />
      {children}
    </span>
  );
}
