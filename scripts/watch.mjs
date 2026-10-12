#!/usr/bin/env node

// role-router watch           live view of every running task in every repo (Ctrl+C to leave)
// role-router watch --once    print it once (scripts, CI, a quick look)

import { render, snapshot } from '../lib/watch.mjs';

if (process.argv.includes('--once')) {
  console.log(render(snapshot()));
} else {
  const draw = () => process.stdout.write(`\x1b[2J\x1b[H${render(snapshot())}\n\n(refreshes every 2s · Ctrl+C to leave)\n`);
  draw();
  setInterval(draw, 2000);
}
