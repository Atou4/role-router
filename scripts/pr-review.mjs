#!/usr/bin/env node

// role-router pr-review <[Repo:]TASK | #PR | PR-url> [--panel] [--no-post] [--no-rework]
//
// A fresh review of the PR as it is on GitHub (its real diff, after main moved on, after hand
// edits), on an account that neither built nor reviewed the task. --panel asks one top-tier
// model per account at once. The result is posted as one comment on the PR (never an approval).
// When the review asks for changes on a role-router task, the task goes back for rework with the
// findings; the open PR updates when the fix passes. Without GitHub, the task branch is reviewed
// against its base locally and nothing is posted.

import path from 'node:path';
import { gitRoot, resolveRepo } from '../lib/repos.mjs';
import { repoRootFor } from '../lib/runs.mjs';
import { reviewPr } from '../lib/prflow.mjs';

const args = process.argv.slice(2);
const spec = args.find((a) => !a.startsWith('--'));
try {
  if (!spec) throw new Error('usage: role-router pr-review <[Repo:]TASK | #PR | PR-url> [--panel] [--no-post] [--no-rework]');
  const here = gitRoot();
  const url = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(spec);
  const m = /^([^:\s#]+):(\S+)$/.exec(spec);
  const repoName = url?.[1] ?? m?.[1];
  const root = repoName ? resolveRepo(repoName, here ? repoRootFor(here) : path.join(process.cwd(), '_')) : here && repoRootFor(here);
  if (!root) throw new Error(`cannot find the repo for ${spec}; use Repo:TASK, a PR url, or run inside the repo (role-router -C <repo>)`);
  const number = url ? Number(url[2]) : /^#?(\d+)$/.exec(spec) ? Number(spec.replace('#', '')) : undefined;
  const id = number ? undefined : (m ? m[2] : spec);
  console.log(`Reviewing ${id ?? `PR #${number}`} in ${path.basename(root)}${args.includes('--panel') ? ' with a panel' : ''}…`);
  const r = await reviewPr(root, { id, number, panel: args.includes('--panel'), post: !args.includes('--no-post'), rework: !args.includes('--no-rework') });
  console.log(`\n${r.comment.split('\n').slice(1).join('\n')}\n`);
  console.log(`verdict: ${r.verdict}`);
  if (r.posted) console.log(`posted: ${r.posted}`);
  else if (r.postError) console.log(`not posted (${r.postError}); the comment is in ${r.commentFile}`);
  else console.log(`comment: ${r.commentFile}`);
  if (r.rework === 'rework') console.log(`→ sent back for rework with these findings: role-router launch ${path.basename(root)}:${id} --detach`);
  if (r.rework === 'parked') console.log('→ the fix rounds are used up: it is in role-router inbox');
} catch (error) {
  console.error(`role-router: ${error.message}`);
  process.exit(1);
}
