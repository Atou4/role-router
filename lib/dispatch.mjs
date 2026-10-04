// Role Router — the orchestrator's one entry point.
//
// dispatch() runs a Role on the best usable profile in its chain, falling
// through on usage limits with a handoff, and asking before a planning Role
// drops to a lighter tier. No model participates in these decisions.
//
// Sketch for ADR-0006 / docs/design/dispatch.md. Bodies are not implemented yet.

/** @typedef {'architect' | 'builder' | 'worker' | 'review' | 'docs' | 'escalation'} RoleName */

/**
 * @typedef {object} DispatchRequest
 * @property {RoleName} role
 * @property {string} [task]       TASK-id; enables handoff resume and cross-vendor review
 * @property {string} [message]    free text for the role prompt's $ARGUMENTS (or the raw prompt with `raw`)
 * @property {boolean} [raw]       send `message` as-is instead of the role prompt
 * @property {'interactive' | 'headless'} mode
 * @property {string} cwd
 * @property {string} [profile]    explicit override: run exactly this profile, no fallback
 * @property {boolean} [dryRun]    resolve the chain and print launches; spawn nothing
 */

/**
 * @typedef {object} RunRef
 * @property {string} profile
 * @property {import('./agents/types.mjs').AgentResult['kind']} kind
 * @property {string} [recordPath]  .role-router/runs/<task>/<seq>-<profile>.json (headless only)
 */

/**
 * @typedef {object} Outcome
 * @property {'ok' | 'crashed' | 'waiting' | 'needs_choice' | 'aborted'} status
 *   ok           the agent finished (Role-level success is read from the board, not here)
 *   crashed      the agent failed for a reason other than limits
 *   waiting      every profile in the chain is limited; see resumeAt
 *   needs_choice headless tier drop on an `ask` Role; the caller surfaces `choice`
 *   aborted      the user chose abort (or wait) at the tier prompt
 * @property {string} [profile]      the profile that produced the final result
 * @property {boolean} tierDropped   ran below the chain head's tier with user consent
 * @property {Date} [resumeAt]       earliest account reset, for waiting/aborted
 * @property {{ question: string, options: string[] }} [choice]
 * @property {string} [handoff]      path of the latest handoff.md, if any
 * @property {RunRef[]} runs
 */

/**
 * @param {DispatchRequest} request
 * @returns {Promise<Outcome>}
 */
export async function dispatch(request) {
  // config  = loadConfig()
  // policy  = config.roles[bindingRole(request.role)]
  // chain   = request.profile ? [request.profile] : orderChain(policy, request.task)
  // loop over chain:
  //   skip profiles whose account is paused (accountStates)
  //   if profile.tier < chain head tier && policy.onTierDrop === 'ask' && !consented:
  //     TTY → askTierDrop(); headless → return needs_choice
  //   prompt = rolePrompt(request) + resume note if handoff.md exists for task
  //   result = await runAgent(profile, prompt, request)
  //   rate_limited → retry same profile up to defaults.transientRetries with backoff
  //   usage_limit  → pauseAccount(resetAt ?? now + cooldown), writeHandoff(), continue
  //   ok | crashed → return
  // exhausted → { status: 'waiting', resumeAt: earliest pausedUntil }
  throw new Error('not implemented');
}

/**
 * Chain order for this request. For `worker` with `avoidBuilderAccount`, profiles
 * on the account that last built `task` (from run records) move to the end.
 * @returns {import('./config.mjs').Profile[]}
 */
function orderChain(config, policy, task) {
  throw new Error('not implemented');
}

/**
 * TTY prompt: wait / switch / abort, showing each skipped profile's reset time.
 * @returns {Promise<'switch' | 'wait' | 'abort'>}
 */
async function askTierDrop(skipped, candidate) {
  throw new Error('not implemented');
}
