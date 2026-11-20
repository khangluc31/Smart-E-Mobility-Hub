## Ticket / Owner / FR IDs

- **Ticket:** T-XX
- **Owner:** MX
- **FR IDs:** FR-XX

## What changed

<!-- Summarize the changes in this PR -->

## How it was tested

<!-- Commands you ran and their results -->

## Definition of Done

- [ ] Only files inside the ticket's scope changed
- [ ] Every FR in the ticket has passing tests named with its id
- [ ] Endpoints match `docs/CONTRACTS.md` exactly (or the PR updates it, approved by M1)
- [ ] No hard-coded business numbers; `assertTransition` used for every state change
- [ ] Operator actions audited; affected users notified
- [ ] `npm run lint`, `typecheck`, `test` pass locally
- [ ] One line added to `docs/AI_USAGE_LOG.md`
