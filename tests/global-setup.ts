// The exact file the docs prescribe to consumers, pointed at the library source. No
// `image` or `databaseName`: the integration run proves those documented defaults
// end-to-end. One `postgresSettings` entry, read back with `SHOW` by
// tests/integration/container.test.ts: `log_checkpoints` defaults to `on`, so `off`
// proves the setting reached the server, and it only silences checkpoint log lines, so
// no other integration test can tell. The `seed` (tests/seed.ts) is shared with the url
// project's tests/global-setup-url.ts.
import { createGlobalSetup } from "../src/global-setup.js";
import { seed } from "./seed.js";

export default createGlobalSetup({ postgresSettings: { log_checkpoints: false }, seed });
