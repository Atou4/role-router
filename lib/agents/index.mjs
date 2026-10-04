import { claude } from './claude.mjs';
import { codex } from './codex.mjs';
import { opencode } from './opencode.mjs';

/** @type {Record<import('../config.mjs').AgentName, import('./types.mjs').Agent>} */
export const agents = { codex, claude, opencode };
