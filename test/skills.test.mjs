import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectStacks, resolveSkills, verificationSkills } from '../lib/skills.mjs';

const manifest = {
  maxSkills: 3,
  roles: { builder: { core: ['tdd', 'diagnosing-bugs'], stackRules: true }, architect: { core: ['grilling'], optional: ['why'] } },
  stacks: {
    flutter: { detect: [{ file: 'pubspec.yaml' }], skills: ['flutter-coding-rules', 'flutter-performance'] },
    rn: { detect: [{ file: 'package.json', contains: ['"react-native"'] }], skills: ['react-native-skills'] },
    ios: { detect: [{ suffix: '.xcodeproj' }], skills: ['swiftui-expert-skill'] },
  },
};
function world({ files = [], agentsSkills = [], claudeSkills = [] }) {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'rr-sk-repo-'));
  const home = mkdtempSync(path.join(os.tmpdir(), 'rr-sk-home-'));
  for (const [f, body] of files) { mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); writeFileSync(path.join(repo, f), body); }
  for (const [root, names] of [['.agents/skills', agentsSkills], ['.claude/skills', claudeSkills]]) {
    for (const n of names) { mkdirSync(path.join(home, root, n), { recursive: true }); writeFileSync(path.join(home, root, n, 'SKILL.md'), 'x'); }
  }
  return { repo, home };
}

test('stack detection: file presence, file contents, and suffixes', () => {
  const { repo } = world({ files: [['pubspec.yaml', ''], ['package.json', '{"dependencies":{"react":"1"}}'], ['App.xcodeproj/x', '']] });
  assert.deepEqual(detectStacks(manifest, repo).sort(), ['flutter', 'ios']);
});

test('core, then stack rules, capped at maxSkills, filtered to what the agent can see', () => {
  const { repo, home } = world({ files: [['pubspec.yaml', '']], agentsSkills: ['tdd', 'diagnosing-bugs', 'flutter-coding-rules', 'flutter-performance'] });
  const codex = resolveSkills({ role: 'builder', agent: 'codex', repoRoot: repo, manifest, home });
  assert.deepEqual(codex.skills.map((s) => s.name), ['tdd', 'diagnosing-bugs', 'flutter-coding-rules']);
  assert.deepEqual(codex.dropped, ['flutter-performance']);
  const claude = resolveSkills({ role: 'builder', agent: 'claude', repoRoot: repo, manifest, home });
  assert.deepEqual(claude.skills, []);
  assert.deepEqual(claude.missing, ['tdd', 'diagnosing-bugs', 'flutter-coding-rules', 'flutter-performance']);
});

test('opencode sees both folders; missing optional skills are not reported', () => {
  const { repo, home } = world({ claudeSkills: ['grilling'] });
  const r = resolveSkills({ role: 'architect', agent: 'opencode', repoRoot: repo, manifest, home });
  assert.deepEqual(r.skills.map((s) => s.name), ['grilling']);
  assert.deepEqual(r.missing, []);
});

test('review and worker resolve to the same manifest entry; unknown roles get nothing', () => {
  const m = { ...manifest, roles: { ...manifest.roles, review: { core: ['code-review'] } } };
  const { repo, home } = world({ agentsSkills: ['code-review'] });
  assert.deepEqual(resolveSkills({ role: 'worker', agent: 'codex', repoRoot: repo, manifest: m, home }).skills.map((s) => s.name), ['code-review']);
  assert.deepEqual(resolveSkills({ role: 'nope', agent: 'codex', repoRoot: repo, manifest: m, home }).skills, []);
});

test("the repo's verify-<app> skill is handed to verification roles by absolute path, from any agent folder", () => {
  const { repo, home } = world({ files: [['.cursor/skills/verify-shop/SKILL.md', 'x'], ['.claude/skills/not-a-verifier/SKILL.md', 'x']], agentsSkills: ['tdd', 'diagnosing-bugs'] });
  assert.deepEqual(verificationSkills(repo).map((v) => v.name), ['verify-shop']);
  const m = { ...manifest, maxSkills: 6, roles: { ...manifest.roles, builder: { ...manifest.roles.builder, verification: true } } };
  const r = resolveSkills({ role: 'builder', agent: 'codex', repoRoot: repo, manifest: m, home });
  assert.deepEqual(r.skills.map((s) => [s.name, s.why]), [['tdd', 'core'], ['diagnosing-bugs', 'core'], ['verify-shop', 'repo verification']]);
  assert.equal(r.skills[2].path, path.join(repo, '.cursor/skills/verify-shop/SKILL.md'));
  const arch = resolveSkills({ role: 'architect', agent: 'codex', repoRoot: repo, manifest: m, home });
  assert.ok(!arch.skills.some((s) => s.name === 'verify-shop'));
});
