# prisma-test-helper

A standalone library that gives Prisma + Vitest projects an isolated Postgres database
per test: one throwaway container per run, one database per worker, emptied again after
every test.

## Language

**Harness**:
The whole system this library ships: container lifecycle, Worker Databases, the Reset,
and the Vitest wiring. Factories are NOT part of the harness — they live in consumer
projects and plug into its seams.

**Template Database**:
The database migrated once per run, then cloned once per worker slot. It never hosts a
test, and the Reset refuses it.

**Worker Database**:
A per-worker-slot clone of the Template Database, named `<template>_<pool id>`. Tests
commit to it for real. The only kind of database the Reset may empty.

**Reset**:
The pass that returns a Worker Database to empty: one PL/pgSQL `DO` block, sent through
the consumer's own Prisma client, that deletes from every table holding rows and rewinds
every owned sequence that moved. Runs once before a file's first test and after every
test. Built once per file from a catalog discovery query.
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
