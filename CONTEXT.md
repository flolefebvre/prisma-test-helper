# prisma-test-helper

A standalone library that gives Prisma + Vitest projects an isolated Postgres database
per test: one throwaway container per run, one database per worker, returned to its
Baseline after every test.

## Language

**Harness**:
The whole system this library ships: container lifecycle, Worker Databases, the Reset,
and the Vitest wiring. Factories are NOT part of the harness — they live in consumer
projects and plug into its seams.

**Template Database**:
The database migrated once per run, then cloned once per worker slot. Between the two,
the harness snapshots its Baseline into the `prisma_test_helper` schema, so every clone
inherits it. It never hosts a test, and the Reset refuses it.

**Worker Database**:
A per-worker-slot clone of the Template Database, named `<template>_<pool id>`. Tests
commit to it for real. The only kind of database the Reset may empty.

**Baseline**:
The rows `prisma migrate deploy` leaves in the Template Database: every table that is
non-empty after migrate is a **Baseline table**. Inferred, never configured. Global setup
snapshots those tables (and the positions of the sequences they own) into the harness's
`prisma_test_helper` schema, and a statement trigger marks an ordinary Baseline table
dirty when a test writes it. Every test starts from the Baseline. See
`docs/adr/0002-baseline-restore.md`.
_Avoid_: snapshot (that is the harness's copy of it, not the rows), fixtures

**Reset**:
The pass that returns a Worker Database to its Baseline: one PL/pgSQL `DO` block, sent
through the consumer's own Prisma client, that empties every table that is not a Baseline
table, restores each Baseline table a test wrote to (and every partitioned one) from its
snapshot, and rewinds every owned sequence, to its start value or, for a Baseline
table's, to its snapshot position, in one statement. Runs once before a file's first
test and after every test. Built once per file from a catalog discovery query.
_Avoid_: truncation, cleanup, wipe

**Reset Hook**:
A consumer callback run in every `beforeEach`, after the previous Reset. Receives
`{ testName, seed }`, where `seed` is a deterministic hash of the test name — this is the
seam through which consumer factories reset their counters and seed faker.

## Retired

Terms from the rollback design (until 0.3.0), replaced by commit-and-reset — see
`docs/adr/0001-commit-and-reset-instead-of-rollback.md`. Do not use them for current code.

- **Test Transaction**: the interactive transaction once parked open per test and rolled
  back. Tests now commit; the Reset replaces the rollback.
- **Routing Proxy**: the stand-in client that routed queries into the Test Transaction.
  Tests now use the consumer's client as-is.
- **Client Seam**: the consumer's `vi.mock` block that installed the Routing Proxy. The
  setup file no longer mocks anything.
