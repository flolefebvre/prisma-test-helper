# prisma-test-helper

A standalone library that gives Prisma + Vitest projects an isolated, per-test-rolled-back
Postgres database: one throwaway container per run, one database per worker, one
transaction per test.

## Language

**Harness**:
The whole system this library ships: container lifecycle, worker databases, the test
transaction engine, and the Vitest wiring. Factories are NOT part of the harness — they
live in consumer projects and plug into its seams.

**Template Database**:
The database migrated once per run, then cloned once per worker slot. It never hosts a
test transaction.

**Worker Database**:
A per-worker-slot clone of the Template Database, named `<template>_<pool id>`. The only
kind of database a Test Transaction may open on.

**Test Transaction**:
The interactive Prisma transaction parked open for the duration of one test and rolled
back after it, discarding every write.
_Avoid_: fake transaction, semi-fake transaction

**Routing Proxy**:
The stand-in for the app's `PrismaClient` that routes model delegates and raw queries
into the live Test Transaction at call time; connection-level methods pass through.

**Client Seam**:
The consumer-owned `vi.mock` block in their Vitest setup file that swaps their Prisma
client module's export for the Routing Proxy via `installTestTransaction`. The library
documents and scaffolds it but never registers it itself.

**Reset Hook**:
A consumer callback run in every `beforeEach` after the Test Transaction opens. Receives
`{ testName, seed }`, where `seed` is a deterministic hash of the test name — this is the
seam through which consumer factories reset sequences and seed faker.
