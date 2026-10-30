# PaySim Architecture

> Status: **foundation only**. This document describes what exists today and marks
> everything that is planned but not built. Last updated: 2026-10-30.

## 1. Overview

PaySim is a modular monolith in a pnpm + Turborepo monorepo:

```text
paysim/
├── apps/
│   ├── api/                NestJS 12 API (ESM) — the only process that touches the database
│   └── web/                Next.js 16 App Router console (Tailwind 4, shadcn/ui)
├── packages/
│   ├── shared-types/       TypeScript contracts shared by api and web
│   ├── state-machine/      Reserved: payment lifecycle transition rules (pure, no I/O)
│   └── test-engine/        Reserved: scenario execution and assertions (pure, no I/O)
├── prisma/                 schema.prisma (empty of models) and future migrations
├── docs/
├── docker-compose.yml      PostgreSQL 17
├── turbo.json              task graph
└── tsconfig.base.json      strict compiler settings inherited by every workspace
```

### Why a modular monolith

One deployable API, internally split into NestJS modules with explicit imports.
It gives transactional consistency (one database, one transaction boundary) for
financial state changes, and keeps the system easy to test end to end. Modules can be
extracted later if a real scaling need appears. That need does not exist today.

## 2. Runtime and toolchain

| Concern         | Choice                      | Notes                                                                                     |
| --------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| Runtime         | Node.js ≥ 24                | Native `process.loadEnvFile`, so there is no dotenv dependency.                           |
| Package manager | pnpm 12 (via corepack)      | Dependency build scripts are deny-by-default; see `allowBuilds` in `pnpm-workspace.yaml`. |
| Build graph     | Turborepo 2                 | `^build` ensures packages compile before apps; `generate` runs Prisma first.              |
| Language        | TypeScript **6.0** (strict) | Pinned below 7.0: typescript-eslint supports `<6.1` and Nest CLI pins `~6.0`.             |
| Module system   | **ESM everywhere**          | NestJS 12 is ESM-only, so the API and packages use `nodenext` with `.js` import suffixes. |
| Lint            | ESLint **9.39** flat config | ESLint 10 is blocked by `eslint-config-next` plugins (react, jsx-a11y, import).           |
| Format          | Prettier                    | Single quotes, trailing commas, 100 columns.                                              |
| Tests           | Vitest (API)                | Unit specs in `src/**/*.spec.ts`, e2e in `test/**/*.e2e-spec.ts`.                         |

### Package resolution

Workspace packages are compiled by `tsc` to `dist/` (ESM + `.d.ts` + declaration maps)
and consumed through their `exports` map. Node (API) and Next (web) resolve them the
same way, with no path-alias tricks. Turbo builds them before any app task runs.

## 3. API (`apps/api`)

```text
src/
├── main.ts                     loads + validates env, then boots Nest
├── app.module.ts               AppModule.register(env), so tests inject their own config
├── config/                     zod env schema, AppConfig injectable, global ConfigModule
├── modules/
│   ├── health/                 GET /health (implemented)
│   ├── payments/               ┐
│   ├── claims/                 │
│   ├── events/                 │  empty @Module() foundations,
│   ├── state-machine/          │  registered in AppModule,
│   ├── failure-injection/      │  no business logic yet
│   ├── replay/                 │
│   └── test-runs/              ┘
├── infrastructure/
│   ├── database/               PrismaService (driver adapter: @prisma/adapter-pg)
│   ├── queues/                 placeholder module, no backend chosen
│   └── logger/                 JSON/pretty ConsoleLogger + request-context middleware
├── common/
│   ├── errors/                 AppError hierarchy (code + HTTP status + details)
│   ├── filters/                AllExceptionsFilter → ApiErrorResponse envelope
│   └── types/                  RequestWithContext
└── generated/prisma/           Prisma client output (gitignored, produced by `generate`)
```

### Configuration

- One `.env` at the repository root, used by the API, Prisma CLI, docker-compose and Next.js.
  Existing environment variables are never overridden.
- `src/config/env.ts` validates with zod **before** Nest starts. Invalid config exits
  with code 1 and lists every problem.

### Logging and traceability

- Nest's built-in `ConsoleLogger`: JSON lines when `NODE_ENV=production` or
  `LOG_FORMAT=json`, readable output otherwise.
- `RequestContextMiddleware` gives every request an ID. It reuses a well-formed inbound
  `x-request-id` or generates a UUID, echoes it on the response, and logs one structured
  line per request (`requestId`, method, path, status, duration).
- The request ID also appears in every error response. It is the first step toward
  constraint #3: every event must be independently traceable.

### Error handling

| Thrown               | Response                                                        |
| -------------------- | --------------------------------------------------------------- |
| `AppError` subclass  | its `httpStatus`, `code`, `message`, optional `details`         |
| Nest `HttpException` | its status, with the code mapped from the status                |
| anything else        | `500 INTERNAL_ERROR`, generic message, stack logged server-side |

All error bodies follow `ApiErrorResponse` from `@paysim/shared-types`.

### Health

`GET /health` returns `HealthResponse`. It responds `200` when the database answers
`SELECT 1` within 2 s, otherwise `503` with `status: "degraded"`. The API boots even if
the database is down, so the health endpoint can report the problem instead of the
process crash-looping.

## 4. Web (`apps/web`)

- App Router, React 19, Tailwind 4 and shadcn/ui (`base-nova` style, Base UI primitives,
  shadcn's `cn` helper).
- The app shell has a navy sidebar with sections for Overview, Simulate and Reliability,
  and a light content area. Design tokens live in `src/app/globals.css` (light theme
  only for now). Status colours (`success`, `warning`, `destructive`) are reserved for
  system state.
- Dashboard (`/`): a server component that probes the API health endpoint at request time.
  It also shows module readiness, the engineering invariants and workspace package status.
- All other routes render an explicit "not implemented" state.
- The API base URL comes from `PAYSIM_API_URL` and is read only on the server.

## 5. Database

- PostgreSQL 17 via docker-compose. Host port **5433** avoids clashing with a local 5432.
- Prisma **7.10** (stable; npm's `latest` tag currently points to an 8.0 RC, which we
  avoid).
  - `apps/api/prisma.config.ts` configures the CLI. The schema lives at `prisma/schema.prisma`.
  - Generator: `prisma-client`, ESM output to `apps/api/src/generated/prisma`.
  - Runtime connection goes through the `@prisma/adapter-pg` driver adapter.
- **No models and no migrations exist yet.** The data model will be designed separately.

## 6. Engineering constraints (project-wide)

1. Financial calculations never use JavaScript floating point. Store integer minor
   units (`BigInt`) or `Decimal`.
2. Payment state changes go through a validated transition mechanism (`@paysim/state-machine`).
3. Payment events are independently traceable: own IDs, correlation to request and payment.
4. Duplicate event delivery never causes duplicate financial effects. Use idempotency
   keys enforced by unique constraints.
5. Replays never mutate original payment records.
6. Simulations use synthetic data only.
7. No integration with real banks or payment providers.
8. No connection to SnapRefund systems and no use of its branding.
9. Modular monolith over microservices.
10. Correctness and testability over premature complexity.

## 7. Not implemented yet

| Area                               | State                                                          |
| ---------------------------------- | -------------------------------------------------------------- |
| Payment / claim / event data model | Not designed. `schema.prisma` has no models.                   |
| Payment lifecycle                  | Draft only (`docs/payment-lifecycle.md`). No code.             |
| `@paysim/state-machine`            | Exports a placeholder constant only.                           |
| `@paysim/test-engine`              | Exports a placeholder constant only.                           |
| Domain modules                     | Empty `@Module()` classes. No controllers, services or routes. |
| Queues / async processing          | No backend chosen (Redis/BullMQ, pg-boss, etc. undecided).     |
| Webhook simulation                 | Not started.                                                   |
| Request validation (DTOs)          | No inbound payloads yet. zod is the intended tool.             |
| AuthN / AuthZ                      | None. Local development tool only.                             |
| API versioning / prefix            | Not decided. Routes are currently unprefixed.                  |
| Web tests                          | None yet.                                                      |
| CI pipeline                        | None yet.                                                      |
| Dark theme                         | Tokens removed. Light theme only.                              |
