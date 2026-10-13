// Role Router — keep the machine awake while unattended work runs.
//
// Seen live: during a long run the Mac went to idle sleep on battery; every agent froze for
// half an hour and woke without network. On macOS, `caffeinate -i -w <pid>` prevents idle
// sleep exactly as long as this process lives. Closing the lid still sleeps the Mac.
// Elsewhere (or with ROLE_ROUTER_KEEP_AWAKE=0) it does nothing.

import { spawn } from 'node:child_process';

let started = false;

export function keepAwake() {
  if (started || process.platform !== 'darwin' || process.env.ROLE_ROUTER_KEEP_AWAKE === '0') return false;
  try {
    const child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    started = true;
    return true;
  } catch {
    return false;
  }
}
