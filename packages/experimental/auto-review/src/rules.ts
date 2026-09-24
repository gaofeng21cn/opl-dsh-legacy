/**
 * Deterministic first-pass rules over one pending tool action.
 *
 * The rules only decide the two ends of the fixed risk policy: a closed set of
 * tools whose entire effect is Session state, and the catastrophic shell
 * effects the policy denies unconditionally. Everything else escalates, so a
 * rule can never authorize an effect the model reviewer would have examined.
 * A false denial is the only failure direction the rules may take; a false
 * allow would bypass review entirely.
 *
 * @module @deepseek-ai/dsh-experimental-auto-review/rules
 */

/** Tool names whose complete effect is Session state, never a host effect. */
const SESSION_LOCAL_TOOLS: ReadonlySet<string> = new Set([
  'todo_write',
  'ask_user_question',
  'create_goal',
  'update_goal',
  'get_goal',
])

/** Tool names that execute one shell command string. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh'])

/** Shell verbs whose recursive, forced form destroys a target tree. */
const RECURSIVE_FORCE_DELETE: readonly RegExp[] = [
  /\brm\b(?=[^\n]*\s-[a-z]*r)(?=[^\n]*\s-[a-z]*f)/i,
  /\bRemove-Item\b(?=[^\n]*-Recurse)(?=[^\n]*-Force)/i,
]

/**
 * Filesystem roots and the home directory, as a complete command word. The
 * trailing guard keeps `rm -rf /tmp/x` and `rm -rf ./build` out of the rule.
 */
const ROOT_TARGET = /(?:^|[\s"'`=])(?:\/|\/\*|~\/?|\$HOME\/?|[A-Za-z]:[\\/])(?=$|[\s"'`;|&)]|$)/

/**
 * Credential stores and credential variable names that are secret by
 * definition. Matched as case-folded substrings, because the rule requires a
 * sink marker in the same string and a near miss only escalates.
 */
const CREDENTIAL_SOURCES: readonly string[] = [
  '.ssh/',
  '.aws/credentials',
  '.aws\\credentials',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'aws_secret_access_key',
  'github_token',
  'gh_token',
  'deepseek_api_key',
  'openai_api_key',
  'anthropic_api_key',
]

/**
 * Network sinks that move bytes outside the local machine. A bare `ssh` and a
 * bare `nc` are absent: the credential path `.ssh/` matches the first, and the
 * second matches ordinary words, while each would leave the rule requiring no
 * real send.
 */
const EXTERNAL_SINKS: readonly string[] = [
  'curl',
  'wget',
  'ncat',
  'scp ',
  'sftp ',
  'invoke-webrequest',
  'invoke-restmethod',
  'iwr ',
  'http://',
  'https://',
  'requests.post',
  'requests.put',
  'fetch(',
]

/**
 * String leaves retained from one action's arguments. Bounded because the
 * arguments are one model-authored JSON value whose size the tool schema does
 * not cap; a truncated scan only loses a deny or allow candidate, and the
 * action then escalates to the model reviewer that sees the complete action.
 */
const MAX_SCANNED_STRINGS = 64
const MAX_SCANNED_CHARS = 131_072

/** Identity of every rule that can decide or escalate one pending action. */
export type RuleId =
  | 'session-local-tool'
  | 'credential-exfiltration'
  | 'filesystem-destruction'
  | 'unclassified'

/** Which end of the fixed risk policy a rule decided. */
export type RuleDecision =
  | { readonly kind: 'allow'; readonly rule: 'session-local-tool' }
  | {
    readonly kind: 'deny'
    readonly rule: 'credential-exfiltration' | 'filesystem-destruction'
    readonly reason: string
  }
  | { readonly kind: 'escalate'; readonly rule: 'unclassified' }

/** Whether one case-folded string carries any marker. */
function carries(text: string, markers: readonly string[]): boolean {
  const folded = text.toLowerCase()
  return markers.some(marker => folded.includes(marker))
}

/**
 * Collect the string leaves of one JSON value, breadth-first.
 * @param value - arguments of the pending call.
 * @returns scanned strings, capped by count and total characters.
 */
function stringLeaves(value: unknown): string[] {
  const found: string[] = []
  const queue: unknown[] = [value]
  let chars = 0
  while (queue.length > 0 && found.length < MAX_SCANNED_STRINGS && chars < MAX_SCANNED_CHARS) {
    const next = queue.shift()
    if (typeof next === 'string') {
      found.push(next)
      chars += next.length
      continue
    }
    if (Array.isArray(next)) {
      queue.push(...(next as unknown[]))
      continue
    }
    if (next !== null && typeof next === 'object') queue.push(...Object.values(next as Record<string, unknown>))
  }
  return found
}

/**
 * Read the single shell command string of one pending action.
 * @param name - pending tool name.
 * @param argumentsValue - parsed arguments of the pending call.
 * @returns the command text, or undefined for a non-shell action.
 */
function shellCommand(name: string, argumentsValue: unknown): string | undefined {
  if (!SHELL_TOOLS.has(name)) return undefined
  if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    return undefined
  }
  const command = (argumentsValue as Record<string, unknown>)['command']
  return typeof command === 'string' ? command : undefined
}

/**
 * Judge one pending action without any model or Session input.
 * @param name - pending tool name.
 * @param argumentsValue - parsed arguments of the pending call.
 * @returns the local verdict: a session-local allow, a catastrophic deny, or escalation.
 */
export function ruleDecision(name: string, argumentsValue: unknown): RuleDecision {
  if (SESSION_LOCAL_TOOLS.has(name)) return { kind: 'allow', rule: 'session-local-tool' }

  const command = shellCommand(name, argumentsValue)
  if (command === undefined) return { kind: 'escalate', rule: 'unclassified' }

  for (const pattern of RECURSIVE_FORCE_DELETE) {
    if (pattern.test(command) && ROOT_TARGET.test(command)) {
      return {
        kind: 'deny',
        rule: 'filesystem-destruction',
        reason: 'recursive forced deletion of a filesystem root or the home directory',
      }
    }
  }

  for (const text of stringLeaves(argumentsValue)) {
    if (carries(text, CREDENTIAL_SOURCES) && carries(text, EXTERNAL_SINKS)) {
      return {
        kind: 'deny',
        rule: 'credential-exfiltration',
        reason: 'credential material is read and sent to an external destination in one command',
      }
    }
  }

  return { kind: 'escalate', rule: 'unclassified' }
}
