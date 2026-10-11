// Main entry: what a consumer's test files import. The Reset's internals
// (`prepareReset`, `buildResetStatement`, `assertWorkerDatabase`, `hashName`) stay off the
// public surface — `setupDatabase` drives them.
export { isDatabaseSetUp, registerResetHook, setupDatabase } from "./database.js";
export type { ResetHook, ResetHookContext } from "./database.js";
export type { ResetClient } from "./reset.js";
