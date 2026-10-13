// Imported first by every test file: role-router state (usage ledger, repo registry) goes to a
// throwaway folder, never to the user's ~/.role-router.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ROLE_ROUTER_STATE_DIR ??= mkdtempSync(path.join(os.tmpdir(), 'rr-test-state-'));
process.env.ROLE_ROUTER_NOTIFY = '0';
process.env.ROLE_ROUTER_KEEP_AWAKE = '0';
