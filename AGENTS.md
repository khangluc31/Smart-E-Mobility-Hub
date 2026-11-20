# AGENTS.md — rules for every AI tool in this repo

> Applies to Claude Code, Antigravity/Gemini, Copilot, Cursor, ChatGPT — any AI a team member uses.
> If a prompt conflicts with this file, **stop and ask the human**. Owner: **M1**.

## 1. Read before you write

1. `docs/SPEC.md` — the rules: states (§4), business rules (§5), FR acceptance criteria (§6), decisions `D-xx` (§8).
2. `docs/ARCHITECTURE.md` — how it's built: module rules (§3), conventions (§4), data model (§5), the section for your module.
3. `docs/CONTRACTS.md` — the exact endpoint you are building or calling.
4. The ticket in `docs/TASKS.md` — scope, files, acceptance criteria.
5. `backend/src/modules/hubs/` and `backend/tests/hubs.test.ts` — the **full example** to copy for structure and style.

If something you need isn't in these files, don't invent it. Ask, or leave a `// TODO(Mx): question` and say so in the PR.

## 2. Stack — fixed, don't change

- Backend: Node.js, Express, TypeScript (strict), Prisma, PostgreSQL. Tests: Vitest + Supertest.
- Frontend: React, TypeScript, Vite, TanStack Query, shadcn/ui, Tailwind.
- **Not allowed:** Fastify, Zod, NestJS, TypeORM, Redux, Socket.io, Redis, RabbitMQ, any ORM other than Prisma.
- **New npm package?** Only with the ticket owner's OK, and say why in the PR.

## 3. Where you may write

| You may edit | You may NOT edit (open a PR comment / ask the owner instead) |
|---|---|
| Your module: `backend/src/modules/<yours>/`, its test file, your frontend pages/hooks/types | `backend/src/core/*` (M1) |
| `frontend/src/types/<yours>.ts` and the matching backend types | `backend/prisma/schema.prisma` and migrations (M1 — request changes by PR) |
| `docs/AI_USAGE_LOG.md` (append your line) | `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `docs/CONTRACTS.md` (M1 — propose changes by PR) |
| | Another member's module (call its exported service functions instead) |
| | `types/enums.ts` (M1) |

Module owners are listed in `docs/SPEC.md` §1.

## 4. Backend rules

- **Layers:** `*.routes.ts` = validate input, call the service, send the response. `*.service.ts` = rules, transactions, Prisma. No Prisma in routes. No `req`/`res` in services.
- **Cross-module calls:** import another module's `*.service.ts` (or its exported pure helper) only. No circular imports (CI runs `madge --circular`).
- **Validation:** use the helpers in `core/errors.ts` (`requireString`, `requireInt`, `requireEnum`, …). Bad input → `400 VALIDATION_ERROR`, **no state change**.
- **Errors:** throw `AppError` with a code from `CONTRACTS.md` §0, a human `message`, and at least one `nextActions` entry. Never send raw Prisma errors.
- **State changes:** call `assertTransition()` from `core/stateMachine.ts` before every status update. Never write a status string by hand that isn't in `types/enums.ts`.
- **Concurrency:** any check-then-change runs inside `db.$transaction`. Lock the resource row first with `lockRow()` (or `FOR UPDATE SKIP LOCKED` to pick "any free one"), then the booking row. See ARCHITECTURE §4.1 and §6.1.
- **Audit + notify:** every Operator state change calls `audit(tx, …)`; every change to a user's booking made by the system or an Operator calls `notify(tx, …)`. Both inside the same transaction.
- **Events:** `events.emit(...)` only **after** the transaction commits, and only for side effects that can be lost (the jobs repeat them).
- **Numbers:** never hard-code 15 min, 20 %, 85 %, 5 s, weights or thresholds. Import them from `core/config.ts`.
- **Time:** services take `now: Date` as a parameter (default `new Date()`) so tests can control time.
- **Ownership:** Students only see their own records; another user's id → 404. Operator routes go under `/api/ops/*`.
- **Simulation engine** (`simulation/engine.ts`, `recommend.ts`) must not import Prisma or `core/db.ts`.

## 5. Frontend rules

- Data fetching only through hooks in `src/hooks/use<Module>.ts` (TanStack Query) using `lib/api.ts`. No `fetch` in components.
- Live views poll with `refetchInterval: 5000`. Mutations invalidate the related queries.
- Status labels and colours **only** via `components/common/StatusBadge`; battery via `BatteryBar`. Errors via `ErrorBox` (shows message, next actions, alternatives).
- Use shadcn components from `components/ui/`; add new ones with the shadcn CLI, don't hand-copy.
- Student pages must work at 360 px width.
- Operator pages go inside `RequireRole role="OPERATOR"`.

## 6. Tests (Definition of Done needs them)

- One test file per module: `backend/tests/<module>.test.ts`.
- **Test names start with the FR id:** `it('FR-06 rejects a second active reservation', …)`.
- Cover every acceptance line in SPEC §6 for your FRs, plus boundaries (19/20 %, 84/85 %, 9/10-char reason) and the 403 for non-operators on your `/ops` routes.
- Use `tests/helpers.ts` (`createTestApp`, `resetDb`, `loginAs`). Tests run against the real test Postgres, jobs off.
- ≥ 70 % line coverage for your module.

## 7. Commands

```bash
npm run dev                         # root: backend + frontend
docker compose up -d                # local Postgres
npm run db:migrate -w backend       # apply migrations (dev)
npm run db:seed -w backend          # 5 Hubs, 300 vehicles, 60 charging points, accounts
npm test -w backend                 # all backend tests
npm run lint && npm run typecheck   # root, both apps
```

## 8. Git workflow

- One branch per ticket: `feat/T-<nn>-<short-name>` (or `fix/…`). Never commit to `main`.
- Small commits; message starts with the ticket id: `T-12: reserve vehicle with row lock`.
- Open a PR using the template. CI must be green (lint, typecheck, tests, build, no cycles) before review.
- Never commit `.env`, secrets, `node_modules`, or generated `dist/`.

## 9. Definition of Done (copy into the PR)

- [ ] Only files inside the ticket's scope changed
- [ ] Every FR in the ticket has passing tests named with its id
- [ ] Endpoints match `docs/CONTRACTS.md` exactly (or the PR updates it, approved by M1)
- [ ] No hard-coded business numbers; `assertTransition` used for every state change
- [ ] Operator actions audited; affected users notified
- [ ] `npm run lint`, `typecheck`, `test` pass locally
- [ ] One line added to `docs/AI_USAGE_LOG.md`

## 10. AI roles in this project

| Role | Tool | Does | Doesn't |
|---|---|---|---|
| Orchestrator | Claude Opus 5.5 (Claude Code) | Writes docs and tickets, reviews at milestones, designs the hard parts | Write production code directly |
| Writer | Opus 4.6 (Antigravity) | Implements **one ticket** on its branch, with tests | Edit files outside the ticket; change docs/schema without saying so |
| Checker | Sonnet 4.6 (Antigravity, separate conversation) | Writes tests **from the ticket and SPEC before reading the code**, runs lint/typecheck/tests, reports PASS/FAIL with reasons | Fix the code itself (it reports; the writer fixes) |
| Helper | Haiku 5.5 (Claude Code) | Search the codebase, seed data, boilerplate, `AI_USAGE_LOG.md` lines | Business logic |
| Auditor | Gemini Flash (Antigravity) | At milestones, compares the whole repo to SPEC §6 / §9 and lists gaps | Change code |

## 11. Academic honesty

The course requires declaring AI use, and every member must be able to explain the code they own. So:
- Log every AI-assisted change in `docs/AI_USAGE_LOG.md` (date, member, ticket, tool, what it did, what you changed or checked).
- Prefer clear, plain code over clever code. Add a short comment on any non-obvious rule with its id (`// BR-10: first committed wins`).
- If the AI produced something you don't understand, don't merge it — ask.