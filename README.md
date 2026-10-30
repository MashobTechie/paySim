# PaySim

**Insurance Payment Reliability Simulator.** A developer environment for building synthetic
insurance payment workflows, injecting failures, inspecting event processing, replaying
scenarios and verifying that payment systems behave correctly under failure.

> **Status: Phase 3 complete.** The monorepo, API and web shells, the payment lifecycle design
> and the database (schema, integrity enforcement, migrations and verification suite) are in
> place. Payment services and endpoints are not implemented yet. See
> [docs/phase-3-handover.md](docs/phase-3-handover.md).

All data is synthetic. PaySim does not connect to any real bank or payment provider.

## Stack

- **Monorepo:** pnpm workspaces + Turborepo, TypeScript 6 (strict), ESM throughout
- **API:** NestJS 12, Prisma 7, PostgreSQL 17
- **Web:** Next.js 16 (App Router), Tailwind CSS 4, shadcn/ui
- **Quality:** ESLint 9, Prettier, Vitest

## Prerequisites

- Node.js 24+
- pnpm 12 (`corepack enable pnpm`, or `corepack enable --install-directory ~/.local/bin pnpm` without sudo)
- Docker with Compose

## Getting started

```bash
cp .env.example .env          # placeholder values. Change POSTGRES_PASSWORD and DATABASE_URL together
pnpm install
pnpm db:up                    # PostgreSQL on localhost:5433
pnpm dev                      # web → http://localhost:3000, API → http://localhost:4000
```

Check it's running:

```bash
curl localhost:4000/health
```

## Scripts

| Command                      | What it does                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                   | Builds packages, generates the Prisma client, runs everything in watch mode                               |
| `pnpm build`                 | Production build of all workspaces                                                                        |
| `pnpm lint`                  | ESLint across all workspaces                                                                              |
| `pnpm typecheck`             | `tsc --noEmit` across all workspaces                                                                      |
| `pnpm test`                  | Vitest suites                                                                                             |
| `pnpm format`                | Prettier write (`format:check` to verify)                                                                 |
| `pnpm db:up/down`            | Start or stop PostgreSQL                                                                                  |
| `pnpm db:generate`           | Regenerate the Prisma client                                                                              |
| `pnpm db:migrate --name <x>` | Create a new migration **without applying it** (`--create-only`); review it before applying               |
| `pnpm db:migrate:deploy`     | Apply all migrations to the database in `DATABASE_URL`                                                    |
| `pnpm db:status`             | `prisma migrate status` (checks connectivity and pending migrations)                                      |
| `pnpm test:db`               | Database integration suite against an isolated `paysim_test` database ([guide](docs/testing-database.md)) |
| `pnpm db:test:reset`         | Drop, recreate and migrate the test database                                                              |

## Layout

```text
apps/api              NestJS API (modular monolith)
apps/web              Next.js console
packages/shared-types API ↔ web contracts
packages/state-machine  reserved: payment lifecycle rules
packages/test-engine    reserved: scenario execution and assertions
prisma/               schema (no models yet) and migrations
docs/                 architecture, product requirements, payment lifecycle
```
 
