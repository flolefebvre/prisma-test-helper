// A test file's opt-in state, shared by the `/setup` entry and the main entry.
//
// Under Vitest's default `isolate: true` every test file gets a fresh module registry,
// so this module, and the state below, is new per file. Under `isolate: false` a worker
// keeps its modules across files — and across watch-mode reruns of the same file — so
// the state must be cleared at each file's start by something that runs for every file
// in both modes. That is `setupWorkerDatabase()`: Vitest re-runs `setupFiles` before
// collecting each file, and the call is already mandatory. Vitest re-evaluates the setup
// file itself, not what it imports, so this module stays one instance per worker, shared
// with `database.ts`.

let optedIn = false;

/** Start a test file's opt-in state: no file has opted in yet. Called by the `/setup` entry. */
export function beginFile(): void {
  optedIn = false;
}

/** Record that this file called `setupDatabase(db)`. */
export function markOptedIn(): void {
  optedIn = true;
}

/** Whether this file called `setupDatabase(db)`. */
export function isOptedIn(): boolean {
  return optedIn;
}
