// Role Router — desktop notifications for things that need you (or are done). Never throws.
// Disabled with ROLE_ROUTER_NOTIFY=0 or config escalation.notify = false.

import { spawnSync } from 'node:child_process';

export function notify(title, message) {
  if (process.env.ROLE_ROUTER_NOTIFY === '0') return false;
  const clean = (s) => String(s).replace(/["\\]/g, "'").replace(/\s+/g, ' ').slice(0, 220);
  try {
    if (process.platform === 'darwin') {
      spawnSync('osascript', ['-e', `display notification "${clean(message)}" with title "${clean(title)}"`], { stdio: 'ignore', timeout: 5000 });
      return true;
    }
    if (process.platform === 'linux') {
      spawnSync('notify-send', [clean(title), clean(message)], { stdio: 'ignore', timeout: 5000 });
      return true;
    }
  } catch { /* notifications are a convenience */ }
  return false;
}
