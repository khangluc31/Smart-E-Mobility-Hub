# AI_USAGE_LOG.md — declaration of AI use (Group 10, HK261)

> The course requires every AI-assisted change to be declared (AGENTS.md §11).
> Add **one line per ticket run** (writer, checker or helper), newest at the bottom. Never edit or delete old lines.
> "Owner" = the member who must be able to explain this code at the demo (SPEC §1).

| Date | Member / owner | Ticket | Tool / model | What the AI did | What the human checked or changed |
|---|---|---|---|---|---|
| 2026-11-19 | M1 | docs | Claude Opus 5.5 (claude.ai project) | Drafted SPEC.md, ARCHITECTURE.md, CONTRACTS.md, AGENTS.md from the Part 2 report | TODO(M1): what you checked/changed |
| 2026-11-20 | M1 | docs | Claude Opus 5.5 (Claude Code, orchestrator) | Aligned ARCHITECTURE routes with CONTRACTS (`/api/ops/*`), updated AI roles, created this log | Approved the changes; committed |
| 2026-11-21 | M1 | docs | Claude Opus 5.5 (Claude Code, orchestrator) | Added D-21/D-22, system state tables, config keys, extra DB checks, utilisation edge cases and test-helper rules to SPEC/ARCHITECTURE/CONTRACTS; wrote tickets T-01–T-05 and reviewed every writer plan | Approved each doc change before commit |
| 2026-11-21 | M1 | T-01 | Antigravity, then Claude Code (Opus 4.6) as writer | Repo skeleton: workspaces, Docker Postgres, CI, Dockerfile, render.yaml, Vite + Tailwind + shadcn, health check | Ran it locally, checked CI on PR #1, merged. Checker skipped (setup ticket) |
| 2026-11-21 | M1 | T-02 | Claude Code: Opus 4.8 High (writer), Sonnet 4.6 High (checker) | Prisma schema (25 models, 27 enums), raw-SQL constraints migration, constraints tests | Checker round 1 FAIL (false positives in checker tests), round 2 PASS; CI green on PR #2, merged |
| 2026-11-21 | M1 | T-03 | Claude Code: Opus 4.8 High (writer), Sonnet 4.6 (checker) | `core/*`: config, db + lockRow, errors/validation helpers, errorHandler, auth middleware, stateMachine, events, scheduler, audit, notify + tests | Checker PASS; CI green on PR #3, merged |
| 2026-11-21 | M1 | T-04 | Claude Code: Opus 4.6 (writer), Sonnet 4.6 Medium (checker) | Hubs module (metrics, service, routes), app.ts router fix, shared DTO types, tests/helpers.ts + fixture, hubs tests | Checker FAIL on one unused import (lint), writer fixed it; 472 tests, hubs coverage 98 %; CI green on PR #4, merged |
