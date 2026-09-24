#!/usr/bin/env node
/** Control the running desktop, without starting a separate headless agent. */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const [command = 'help', ...args] = process.argv.slice(2)
if (command === 'help' || command === '--help') {
  console.log('OPL DSH desktop control\n  list\n  create [absolute-directory] [--preset NAME]\n  send SESSION --file PROMPT.txt [--mode queue|steer] [--request-id ID]\n  steer-queued SESSION ITEM\n  read SESSION\n  stop SESSION\n  wait SESSION [--turn N] [--timeout SECONDS]\n  permissions SESSION\n  grant SESSION --preset NAME\n  projects\n  move-session SESSION (--project WORKSPACE_ID | --out)\n  ack TASK DELIVERY --stage received|review-started\n  receive TASK DELIVERY [--consumer ID]\n  receipts\n  outbox [--thread THREAD] [--pending]\n  consume TASK DELIVERY --epoch N\n  resume-failed TASK DELIVERY [--consumer ID]\n  rpc --file REQUEST.json [--timeout SECONDS]\nThe desktop must be running. wait blocks until the session completes, fails, is cancelled, or needs input; exit code 0 means settled, 3 means the timeout expired first, 5 means resume-failed submitted no instruction. send admits one prompt to the named session and prints requestId, requestMode, and the server\'s accepted: accepted is admission, not model execution or reading. --mode queue (the default) appends the prompt for a later turn; --mode steer asks the current turn to take it now, within the backend\'s existing steering semantics. steer-queued converts one still-pending queue occurrence into steering by item id through session/updateQueue; ITEM is the id the session\'s queue projection reports, and the call succeeds only while the item is pending and the session\'s current turn accepts steering, so a refusal exits 1 with session/steer-unavailable or session/queue-item-not-found and leaves the item queued. permissions prints the effective preset, its sandbox mode and approval policy, and the offered presets; grant switches the preset and prints the permission that is now effective. Exit code 4 means the switch was refused because the session is running and the target permission is wider: wait for the session to settle, then retry. projects prints the registered projects with their session membership; move-session places a session in a project, or outside every project with --out, without changing its working directory or history. Receiving a task-feedback notification: run `receive TASK DELIVERY` first and obey the returned action — review on the first claim, resume a claim this consumer already owns, busy when another consumer holds a live claim so this message must not start work, skip on a consumed one; pass --consumer with a stable id so a restart resumes its own claim. Run `receipts` after a restart to list claims that are not consumed, and `consume TASK DELIVERY --epoch N` with the claimEpoch receive returned only once the review has finished; an older claim cannot consume a newer owner\'s review. Run `outbox` to list the notifications a dispatcher was not woken for: each entry carries its delivery id, target thread, stage, and payload, and a needs-input entry additionally carries the questions or the approval plus the DSH session that is waiting for its human, so relay the question to your operator and never submit an answer yourself; --pending keeps only unacknowledged, unretired deliveries and --thread keeps only one target thread. A failure notification marked as the reasoning_text protocol error offers `resume-failed TASK DELIVERY [--consumer ID]`, which claims the delivery under the same stable consumer id used for receive (or continues the claim already recorded for that delivery), verifies the failed turn is still the target, and submits at most one persisted resume instruction (report budget-exhausted to your operator); a replay after a manual turn stands down instead of appending a stale continuation. Exit code 5 means resume-failed submitted nothing: the printed decision and the reason on stderr name the final answer (not-applicable, superseded, running, budget-exhausted, busy, or consumed), and re-running the command cannot change it. ack records the delivery stage (received, then review-started) and enqueueing a message is not a receipt. OPL search is under namespace oplSearch. No API key is printed.')
  process.exit(0)
}
const home = process.env.DSH_OPL_HOME || process.env.DSH_HOME || (process.platform === 'win32' ? join(process.env.APPDATA, '@deepseek-ai/dsh-desktop/dsh-home') : join(homedir(), '.dsh-opl'))

/**
 * Read one optional `--flag VALUE` argument.
 * @param name - flag to look for, including the leading dashes.
 * @returns the following token, or undefined when the flag is absent.
 */
function option(name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(name + ' requires a value')
  return value
}

/** Parse the optional caller deadline in whole seconds. */
function timeoutSeconds() {
  const raw = option('--timeout')
  if (raw === undefined) return 0
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout must be a positive number of seconds')
  return seconds
}

/**
 * Keep only the outbox entries one control read asked for.
 * @param value - the service's answer, when it is a delivery array.
 * @param thread - target thread id to keep, or undefined for every thread.
 * @param pending - whether to keep only deliveries no receiver acknowledged.
 * @returns the filtered deliveries, or the answer unchanged when it is not an array.
 */
function selectDeliveries(value, thread, pending) {
  if (!Array.isArray(value)) return value
  return value.filter(delivery =>
    (thread === undefined || delivery?.target?.threadId === thread)
    && (!pending || (delivery?.acknowledged === false && delivery?.retired === false)))
}

/** Exit code reported when the wait deadline expires before the session settles. */
const TIMEOUT_EXIT_CODE = 3

/** Exit code reported when a widening permission switch is refused on a running session. */
const PERMISSION_BUSY_EXIT_CODE = 4

/** Exit code reported when resume-failed reached a decision other than `resumed`. */
const RESUME_NOT_PERFORMED_EXIT_CODE = 5

/**
 * Why resume-failed submitted no instruction, per the service's decision.
 *
 * These are final answers, not transient failures: the failure is no longer the
 * Session's target, another consumer owns the delivery, the resume budget is
 * spent, or the delivery was already handled. Re-running the command cannot
 * change any of them, so the caller reports the reason instead of retrying.
 */
const RESUME_NOT_PERFORMED = {
  'not-applicable': 'no automatic resume: the recorded outcome is not the reasoning_text protocol failure',
  'superseded': 'no automatic resume: a newer turn, message, or target replaced the failed one; continue manually if work is still needed',
  'running': 'no automatic resume: the Session is already running; wait for it to settle',
  'budget-exhausted': 'no automatic resume: the original task has spent its automatic-resume budget; report this to the operator instead of retrying',
  'busy': 'no automatic resume: another consumer holds a live claim on this delivery',
  'consumed': 'no automatic resume: this delivery was already handled',
}

/** Longest deadline the bridge accepts for one control call. */
const BRIDGE_MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000

try {
  const binding = JSON.parse(readFileSync(join(home, 'profiles/desktop/control.json'), 'utf8'))
  const endpoint = new URL(binding.endpoint)
  if (binding.version !== 1 || endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:' || endpoint.pathname !== '/rpc') throw new Error('Invalid desktop control binding')
  const timeout = timeoutSeconds()
  /** Deadline the bridge applies to this call, and the client's own bound. */
  const deadlineMs = timeout === 0
    ? command === 'wait' ? BRIDGE_MAX_TIMEOUT_MS : 150_000
    : timeout * 1000
  let request
  /** Target thread an `outbox` read is narrowed to, or undefined for every thread. */
  let outboxThread
  if (command === 'list') request = { namespace: 'session', method: 'list', args: { _request: {} } }
  else if (command === 'create') {
    const preset = option('--preset')
    request = {
      namespace: 'session',
      method: 'create',
      args: {
        request: {
          ...args[0] && !args[0].startsWith('--') ? { cwd: args[0] } : { standalone: true },
          ...preset === undefined ? {} : { permissionPreset: preset },
        },
      },
    }
  }
  else if (command === 'stop') request = { namespace: 'session', method: 'cancel', args: { request: { sessionId: args[0] } } }
  else if (command === 'read') request = { namespace: 'session', method: 'snapshot', args: { request: { address: { kind: 'session', sessionId: args[0] }, maxMessages: 30, assistantStream: true } } }
  else if (command === 'permissions') {
    if (!args[0] || args[0].startsWith('--')) throw new Error('permissions requires SESSION')
    request = { namespace: 'session', method: 'permissions', args: { request: { sessionId: args[0] } } }
  }
  else if (command === 'grant') {
    if (!args[0] || args[0].startsWith('--')) throw new Error('grant requires SESSION')
    const preset = option('--preset')
    if (preset === undefined) throw new Error('grant requires --preset NAME')
    request = { namespace: 'session', method: 'selectPermissions', args: { request: { sessionId: args[0], preset } } }
  }
  else if (command === 'wait') {
    if (!args[0] || args[0].startsWith('--')) throw new Error('wait requires SESSION')
    const turn = option('--turn')
    const parsed = turn === undefined ? undefined : Number(turn)
    if (parsed !== undefined && (!Number.isSafeInteger(parsed) || parsed < 0)) throw new Error('--turn must be a non-negative integer')
    request = {
      namespace: 'session',
      method: 'wait',
      args: { request: { sessionId: args[0], ...(parsed === undefined ? {} : { turn: parsed }) } },
      timeoutMs: deadlineMs,
    }
  } else if (command === 'send') {
    if (!args[0] || args[0].startsWith('--')) throw new Error('send requires SESSION')
    const file = option('--file')
    if (file === undefined) throw new Error('send requires --file PROMPT.txt')
    const mode = option('--mode') ?? 'queue'
    if (mode !== 'queue' && mode !== 'steer') throw new Error('--mode must be queue or steer')
    const requestId = option('--request-id') ?? randomUUID()
    request = { namespace: 'session', method: 'prompt', args: { request: { sessionId: args[0], requestId, mode, content: [{ type: 'text', text: readFileSync(file, 'utf8') }] } } }
  } else if (command === 'steer-queued') {
    if (!args[0] || args[0].startsWith('--')) throw new Error('steer-queued requires SESSION')
    if (!args[1] || args[1].startsWith('--')) throw new Error('steer-queued requires ITEM')
    request = {
      namespace: 'session',
      method: 'updateQueue',
      args: { request: { sessionId: args[0], itemId: args[1], action: { kind: 'steer' } } },
    }
  } else if (command === 'projects') request = { namespace: 'workspace', method: 'follow', args: {} }
  else if (command === 'move-session') {
    if (!args[0] || args[0].startsWith('--')) throw new Error('move-session requires SESSION')
    const project = option('--project')
    const outside = args.includes('--out')
    if (project !== undefined && outside) throw new Error('move-session accepts --project WORKSPACE_ID or --out, not both')
    if (project === undefined && !outside) throw new Error('move-session requires --project WORKSPACE_ID or --out')
    request = {
      namespace: 'workspace',
      method: 'moveSession',
      args: { request: { sessionId: args[0], ...(project === undefined ? {} : { workspaceId: project }) } },
    }
  } else if (command === 'rpc') {
    if (args[0] !== '--file' || !args[1]) throw new Error('rpc requires --file REQUEST.json')
    request = JSON.parse(readFileSync(args[1], 'utf8'))
  } else if (command === 'ack') {
    if (!args[0] || args[0].startsWith('--')) throw new Error('ack requires TASK')
    if (!args[1] || args[1].startsWith('--')) throw new Error('ack requires DELIVERY')
    const stage = option('--stage')
    if (stage !== 'received' && stage !== 'review-started') throw new Error('ack requires --stage received|review-started')
    request = {
      namespace: 'taskFeedback',
      method: 'ack',
      args: { request: { taskId: args[0], deliveryId: args[1], stage } },
    }
  } else if (command === 'receive') {
    if (!args[0] || args[0].startsWith('--')) throw new Error('receive requires TASK')
    if (!args[1] || args[1].startsWith('--')) throw new Error('receive requires DELIVERY')
    const consumer = option('--consumer')
    request = {
      namespace: 'taskFeedback',
      method: 'receive',
      args: { request: { taskId: args[0], deliveryId: args[1], ...(consumer === undefined ? {} : { consumerId: consumer }) } },
    }
  } else if (command === 'outbox') {
    // Read before the request so a malformed flag never reaches the bridge.
    outboxThread = option('--thread')
    request = { namespace: 'taskFeedback', method: 'outbox', args: {} }
  } else if (command === 'receipts') {
    request = { namespace: 'taskFeedback', method: 'receipts', args: {} }
  } else if (command === 'consume') {
    if (!args[0] || args[0].startsWith('--')) throw new Error('consume requires TASK')
    if (!args[1] || args[1].startsWith('--')) throw new Error('consume requires DELIVERY')
    const epoch = Number(option('--epoch'))
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('consume requires --epoch N (the claimEpoch receive returned)')
    const consumer = option('--consumer')
    request = {
      namespace: 'taskFeedback',
      method: 'consume',
      args: { request: { taskId: args[0], deliveryId: args[1], claimEpoch: epoch, ...(consumer === undefined ? {} : { consumerId: consumer }) } },
    }
  } else if (command === 'resume-failed') {
    if (!args[0] || args[0].startsWith('--')) throw new Error('resume-failed requires TASK')
    if (!args[1] || args[1].startsWith('--')) throw new Error('resume-failed requires DELIVERY')
    const consumer = option('--consumer')
    request = {
      namespace: 'taskFeedback',
      method: 'resumeFailed',
      args: { request: { taskId: args[0], deliveryId: args[1], ...(consumer === undefined ? {} : { consumerId: consumer }) } },
    }
  } else throw new Error('Unknown command: ' + command)
  const clientTimeout = deadlineMs + 10_000
  let response
  try {
    response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + binding.token, 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(clientTimeout) })
  } catch (error) {
    if (command === 'wait' && (error?.name === 'TimeoutError' || error?.name === 'AbortError')) {
      console.error('wait timed out after ' + String(clientTimeout / 1000) + 's; the session has not settled')
      process.exit(TIMEOUT_EXIT_CODE)
    }
    throw error
  }
  const result = await response.json()
  if (command === 'outbox') {
    result.value = selectDeliveries(result.value, outboxThread, args.includes('--pending'))
  }
  if (command === 'send') {
    result.requestId = request.args.request.requestId
    result.requestMode = request.args.request.mode
  }
  console.log(JSON.stringify(result, null, 2))
  if (response.status === 504 && result.code === 'timeout') {
    console.error('wait timed out; the session has not settled')
    process.exit(TIMEOUT_EXIT_CODE)
  }
  if (result.code === 'session/permissions-busy') {
    console.error('permission switch refused: the session is running and the target permission is wider; wait for it to settle, then retry')
    process.exit(PERMISSION_BUSY_EXIT_CODE)
  }
  if (command === 'resume-failed' && response.ok && result.ok !== false) {
    // A call the server answered is not a recovery. Report the decision the
    // service reached so a caller that only reads the exit status cannot take
    // "no instruction was submitted" for a resumed task, and cannot retry it
    // mechanically: budget-exhausted and superseded are final answers.
    const decision = result.value?.decision
    if (typeof decision === 'string' && decision !== 'resumed') {
      console.error(RESUME_NOT_PERFORMED[decision] ?? `no automatic resume was performed (decision: ${decision})`)
      process.exit(RESUME_NOT_PERFORMED_EXIT_CODE)
    }
  }
  if (!response.ok || result.ok === false) process.exitCode = 1
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Desktop control failed')
  process.exitCode = 1
}
