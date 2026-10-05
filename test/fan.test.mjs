import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultFanProfiles, fan } from '../lib/fan.mjs';

const repo = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rr-fan-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
};
const t0 = () => new Date('2026-10-05T12:00:00Z');

test('default lanes: one profile per account, preferring top tier', () => {
  const config = { profiles: {
    a: { id: 'a', account: 'openai', tier: 'lite' }, b: { id: 'b', account: 'openai', tier: 'top' },
    c: { id: 'c', account: 'anthropic', tier: 'lite' },
  } };
  assert.deepEqual(defaultFanProfiles(config), ['b', 'c']);
});

test('every lane gets the same prompt on its pinned profile; answers and an index are written', async () => {
  const cwd = repo();
  const calls = [];
  const dispatch = async (req) => {
    calls.push(req);
    if (req.profile === 'limited') return { status: 'waiting', message: 'every fan profile is limited', runs: [] };
    return { status: 'ok', runs: [{ result: { kind: 'ok', summary: `answer from ${req.profile}` } }] };
  };
  const { out, lanes } = await fan({ prompt: 'Design X', profiles: ['p1', 'p2', 'limited'], cwd, now: t0, dispatch });
  assert.deepEqual(calls.map((c) => [c.role, c.profile, c.raw, c.mode]), [['fan', 'p1', true, 'headless'], ['fan', 'p2', true, 'headless'], ['fan', 'limited', true, 'headless']]);
  assert.ok(calls.every((c) => c.message.endsWith('Design X') && /Do not modify any file/.test(c.message)));
  assert.equal(readFileSync(lanes[0].answer, 'utf8').trim(), 'answer from p1');
  assert.equal(lanes[2].status, 'waiting');
  assert.ok(existsSync(path.join(out, 'fan.json')) && existsSync(path.join(out, 'prompt.md')));
});

test('--worktree gives each lane its own detached checkout', async () => {
  const cwd = repo();
  const seen = [];
  const dispatch = async (req) => { seen.push(req.cwd); return { status: 'ok', runs: [{ result: { kind: 'ok', summary: 'done' } }] }; };
  const { lanes } = await fan({ prompt: 'Build a candidate', profiles: ['p1', 'p2'], cwd, worktree: true, now: t0, dispatch });
  assert.equal(new Set(seen).size, 2);
  for (const l of lanes) assert.ok(existsSync(path.join(l.worktree, '.git')));
});
