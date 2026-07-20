// Main entry: what a consumer's test setup file imports. The engine internals
// (`TestTransaction`, `testTransaction`, `assertWorkerDatabase`) stay off the public
// surface — the harness's own wiring drives them.
export { installTestTransaction } from "./transaction.js";
export type { MinimalClient, MinimalTransactionClient } from "./transaction.js";
