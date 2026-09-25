#!/usr/bin/env node
/** Dispatch through the desktop control CLI with durable per-operation receipts. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const has = (value, key) => Object.hasOwn(value, key)
const terminal = new Set(['completed', 'failed', 'cancelled'])
const stages = ['prepared', 'creating', 'created', 'configured', 'registering', 'registered', 'sending', 'sent']
const flags = new Map(['config', 'thread', 'task', 'operation', 'prompt-file', 'acceptance-file', 'cwd', 'session', 'provider', 'model', 'effort', 'preset'].map(flag => [flag, flag.replace(/-([a-z])/g, (_, char) => char.toUpperCase())]))

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label} must be a non-empty string without NUL`)
  return value
}
function identifier(value, label) {
  nonempty(value, label)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} must contain 1-128 letters, digits, dots, underscores, colons, or hyphens`)
  return value
}
function absolute(value, label) {
  nonempty(value, label)
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute native path`)
  return resolve(value)
}
function validateConfig(config) {
  if (!record(config)) throw new Error('config must be an object')
  const keys = new Set(['controlCli', 'ledgerDir', 'targetThreadId', 'node', 'dshHome', 'pathMode', 'timeoutMs', 'startCommand', 'startArgs', 'startCwd', 'startupTimeoutMs', 'electronNode', 'ledgerPerThread'])
  for (const key of Object.keys(config)) if (!keys.has(key)) throw new Error(`unknown config field ${key}`)
  if (config.pathMode !== undefined && config.pathMode !== 'native') throw new Error(`unsupported pathMode ${config.pathMode}; use a native Node process and native paths`)
  for (const key of ['electronNode', 'ledgerPerThread']) if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`config.${key} must be boolean`)
  if (config.node !== undefined) nonempty(config.node, 'config.node')
  if (config.startCommand !== undefined) nonempty(config.startCommand, 'config.startCommand')
  if (config.startArgs !== undefined && (!Array.isArray(config.startArgs) || !config.startArgs.every(value => typeof value === 'string' && !value.includes('\0')))) throw new Error('config.startArgs must be an array of strings without NUL')
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 86_400_000)) throw new Error('config.timeoutMs must be an integer between 1 and 86400000')
  if (config.startCwd !== undefined) absolute(config.startCwd, 'config.startCwd')
  if (config.startupTimeoutMs !== undefined && (!Number.isSafeInteger(config.startupTimeoutMs) || config.startupTimeoutMs <= 0 || config.startupTimeoutMs > 120_000)) throw new Error('config.startupTimeoutMs must be an integer between 1 and 120000')
  return { ...config, controlCli: absolute(config.controlCli, 'config.controlCli'), ledgerDir: absolute(config.ledgerDir, 'config.ledgerDir'), targetThreadId: nonempty(config.targetThreadId, 'config.targetThreadId'), ...(config.dshHome === undefined ? {} : { dshHome: absolute(config.dshHome, 'config.dshHome') }), ...(config.startCwd === undefined ? {} : { startCwd: absolute(config.startCwd, 'config.startCwd') }) }
}
function readText(file, label) {
  nonempty(file, label)
  if (!statSync(file).isFile()) throw new Error(`${label} must be a regular file`)
  return nonempty(readFileSync(file, 'utf8'), label)
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function dshHome(config) {
  if (config.dshHome !== undefined) return config.dshHome
  const configured = process.env.DSH_OPL_HOME?.trim() || process.env.DSH_HOME?.trim()
  if (configured) return configured
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), '@deepseek-ai', 'dsh-desktop', 'dsh-home')
  return join(homedir(), '.dsh-opl')
}

function controlBinding(config) {
  return join(dshHome(config), 'profiles', 'desktop', 'control.json')
}

/** Start one configured native DSH desktop and wait for its authenticated binding. */
function ensureDesktop(config, state) {
  const binding = controlBinding(config)
  if (existsSync(binding)) return
  if (config.startCommand === undefined) throw new Error(`DSH desktop is not running and no startCommand is configured; start OPL DSH or add startCommand to the coordinator config (expected binding: ${binding})`)
  if (!state.started) {
    const environment = { ...process.env, ...(config.dshHome === undefined ? {} : { DSH_OPL_HOME: config.dshHome }) }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(config.startCommand, config.startArgs ?? [], { cwd: config.startCwd, env: environment, detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    state.started = true
  }
  const timeout = config.startupTimeoutMs ?? 30_000
  const deadline = Date.now() + timeout
  while (!existsSync(binding) && Date.now() < deadline) sleepSync(Math.min(100, Math.max(1, deadline - Date.now())))
  if (!existsSync(binding)) throw new Error(`DSH desktop did not publish its control binding within ${String(timeout)}ms: ${binding}`)
}

/**
 * Invoke rpc --file using the control CLI's existing token handling.
 * @param config - validated native executable, home, and timeout configuration.
 * @returns one synchronous RPC invoker.
 */
export function createControlInvoker(config) {
  const node = config.node ?? process.execPath
  const state = { started: false }
  return request => {
    ensureDesktop(config, state)
    const dir = mkdtempSync(join(tmpdir(), 'opl-dsh-dispatch-'))
    const file = join(dir, 'request.json')
    try {
      writeFileSync(file, JSON.stringify(request), { flag: 'wx', mode: 0o600 })
      const env = { ...process.env }
      if (config.dshHome) env.DSH_OPL_HOME = config.dshHome
      if (config.electronNode) env.ELECTRON_RUN_AS_NODE = '1'
      const result = spawnSync(node, [config.controlCli, 'rpc', '--file', file, '--timeout', String((config.timeoutMs ?? 150_000) / 1000)], {
        encoding: 'utf8', env, timeout: (config.timeoutMs ?? 150_000) + 15_000,
      })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error((result.stderr || 'control CLI failed').trim())
      return JSON.parse(result.stdout)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
}
function valueOf(response) {
  if (!record(response) || response.ok === false || response.code) throw new Error(`control request failed: ${response?.code ?? 'unknown'}`)
  return has(response, 'value') ? response.value : response
}
function parseArgs(argv) {
  const [command] = argv
  if (!['dispatch', 'continue'].includes(command)) throw new Error('usage: dispatch|continue [--config FILE] [--thread ID] --task ID --operation ID --prompt-file FILE --acceptance-file FILE')
  const out = { command }
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index]
    const key = flag.startsWith('--') && flags.get(flag.slice(2))
    if (!key) throw new Error(`unknown argument ${flag}`)
    if (has(out, key)) throw new Error(`duplicate argument ${flag}`)
    const value = argv[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    out[key] = value
  }
  for (const key of ['task', 'operation', 'promptFile', 'acceptanceFile']) nonempty(out[key], key)
  return out
}
function withLock(lock, fn) {
  let fd
  try { fd = openSync(lock, 'wx', 0o600) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error(`dispatch ledger is locked: ${lock}; verify the recorded process is stopped before removing a stale lock`)
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    return fn()
  } finally { closeSync(fd); unlinkSync(lock) }
}
function readLedger(file) {
  if (!existsSync(file)) return { version: 2, tasks: {} }
  const data = json(file)
  if (!record(data) || data.version !== 2 || !record(data.tasks)) throw new Error('invalid dispatch ledger; version 1 needs explicit session and receipt reconciliation before migration')
  for (const [key, task] of Object.entries(data.tasks)) {
    if (!record(task) || task.task !== key || !record(task.operations) || typeof task.binding !== 'string' || typeof task.sessionId !== 'string' || typeof task.firstOperation !== 'string' || typeof task.lastOperation !== 'string') throw new Error('invalid task in dispatch ledger')
    for (const [id, op] of Object.entries(task.operations)) {
      if (!record(op) || op.operation !== id || !['dispatch', 'continue'].includes(op.command) || !stages.includes(op.status) || typeof op.fingerprint !== 'string' || typeof op.requestId !== 'string' || typeof op.taskId !== 'string' || op.sessionId !== task.sessionId || typeof op.createSession !== 'boolean' || typeof op.promptSent !== 'boolean' || (op.status === 'sent') !== op.promptSent || (op.promptSent && op.accepted !== true)) throw new Error('invalid operation in dispatch ledger')
    }
    if (!has(task.operations, task.firstOperation) || !has(task.operations, task.lastOperation)) throw new Error('invalid operation pointer in dispatch ledger')
  }
  return data
}
function saveLedger(file, ledger) {
  const temporary = `${file}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    try { writeFileSync(fd, JSON.stringify(ledger, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, file)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
function permissionCheck(rpc, sessionId, expected) {
  const permissions = rpc('session', 'permissions', { sessionId })
  if (!record(permissions) || permissions.sessionId !== sessionId || typeof permissions.preset !== 'string' || typeof permissions.running !== 'boolean' || !(permissions.turn === null || Number.isSafeInteger(permissions.turn) && permissions.turn >= 0)) throw new Error('invalid session.permissions response')
  if (expected !== undefined && permissions.preset !== expected) throw new Error(`permission preset validation failed: expected ${expected}, got ${permissions.preset}`)
  return permissions
}
function requireIdle(rpc, sessionId, permissions) {
  if (permissions.running || permissions.turn !== null) throw new Error('session has a live turn; inspect it before dispatching another operation')
  const projections = rpc('session', 'projections', { sessionId })
  const inbox = projections?.values?.inbox
  if (!record(inbox) || !Array.isArray(inbox['next-turn']) || !Array.isArray(inbox['next-step'])) throw new Error('session inbox is unavailable; cannot establish that the session is idle')
  if (inbox['next-turn'].length || inbox['next-step'].length) throw new Error('session has pending input; inspect it before dispatching another operation')
}
function requireSettled(rpc, task) {
  const tasks = rpc('taskFeedback', 'tasks')
  if (!Array.isArray(tasks)) throw new Error('invalid taskFeedback.tasks response')
  const previous = task.operations[task.lastOperation]
  const prior = tasks.find(item => item.taskId === previous.taskId)
  if (!prior || prior.sessionId !== task.sessionId || !terminal.has(prior.state)) throw new Error('previous operation has not reached a terminal task state; review its feedback before continuing')
  if (tasks.some(item => item.sessionId === task.sessionId && !terminal.has(item.state))) throw new Error('another task is still active in this session; inspect it before continuing')
}
function requireFeedbackIdle(rpc, op) {
  const tasks = rpc('taskFeedback', 'tasks')
  if (!Array.isArray(tasks)) throw new Error('invalid taskFeedback.tasks response')
  for (const task of tasks) {
    if (task.sessionId !== op.sessionId) continue
    if (task.taskId === op.taskId) {
      if (!['accepted', 'queued'].includes(task.state)) throw new Error('registered task already observed another turn; inspect its feedback before sending')
    } else if (!terminal.has(task.state)) throw new Error('another task is still active in this session; inspect it before dispatching')
  }
}

/**
 * Send one explicitly identified operation, resuming its saved stage on retry.
 * @param options - task, operation, input files, native config, and optional model/preset.
 * @param invoke - optional synchronous control invoker for isolated tests.
 * @returns a durable admission receipt; accepted does not mean work completed.
 */
export function runDispatch(options, invoke) {
  const config = validateConfig({ ...options.config, targetThreadId: options.thread ?? options.config?.targetThreadId ?? process.env.CODEX_THREAD_ID })
  if (config.ledgerPerThread) config.ledgerDir = join(config.ledgerDir, sha(config.targetThreadId))
  const { command, task, operation, session, provider, model, effort, preset } = options
  if (!['dispatch', 'continue'].includes(command)) throw new Error('command must be dispatch or continue')
  identifier(task, 'task'); identifier(operation, 'operation')
  for (const [key, value] of Object.entries({ session, provider, model, effort, preset })) if (value !== undefined) nonempty(value, key)
  if ((provider === undefined) !== (model === undefined)) throw new Error('--provider and --model must be supplied together')
  if (effort !== undefined && provider === undefined) throw new Error('--effort requires --provider and --model')
  const cwd = options.cwd === undefined ? undefined : absolute(options.cwd, 'cwd')
  if (cwd !== undefined && !statSync(cwd).isDirectory()) throw new Error('cwd must be a directory')
  if (command === 'continue' && cwd !== undefined) throw new Error('continue uses the original session workspace; omit --cwd')
  if (session !== undefined && cwd !== undefined) throw new Error('--session uses an existing workspace; omit --cwd')
  const prompt = readText(options.promptFile, 'promptFile')
  const acceptance = readText(options.acceptanceFile, 'acceptanceFile')
  const fingerprint = sha({ command, prompt, acceptance, cwd, provider, model, effort, preset })
  const binding = sha({ target: config.targetThreadId, controlCli: config.controlCli, ledgerDir: config.ledgerDir, dshHome: config.dshHome ?? process.env.DSH_OPL_HOME ?? process.env.DSH_HOME ?? null })
  const paths = { file: join(config.ledgerDir, 'dispatch-ledger.json'), lock: join(config.ledgerDir, '.dispatch.lock') }
  mkdirSync(config.ledgerDir, { recursive: true, mode: 0o700 })
  const call = invoke ?? createControlInvoker(config)
  const rpc = (namespace, method, request) => valueOf(call({ namespace, method, args: request === undefined ? {} : { request } }))
  return withLock(paths.lock, () => {
    const ledger = readLedger(paths.file)
    let entry = has(ledger.tasks, task) ? ledger.tasks[task] : undefined
    if (entry && entry.binding !== binding) throw new Error('task belongs to a different desktop or target thread')
    if (entry && session !== undefined && session !== entry.sessionId) throw new Error('session differs from the task ledger')
    let op = entry && has(entry.operations, operation) ? entry.operations[operation] : undefined
    if (op && op.fingerprint !== fingerprint) throw new Error(`operation ${operation} already exists with different inputs; use a new operation id for new work`)
    if (op?.promptSent) return { ...op, idempotent: true }
    if (!op) {
      if (entry && command === 'dispatch') throw new Error('task already exists; use continue with a new operation id')
      if (!entry && command === 'continue' && session === undefined) throw new Error('continue requires --session or an existing task ledger')
      if (entry) {
        if (Object.values(entry.operations).some(item => !item.promptSent)) throw new Error('task has an unfinished operation; retry that operation id first')
        requireSettled(rpc, entry)
      }
      const sessionId = entry?.sessionId ?? session ?? `session-${sha({ binding, ledgerDir: config.ledgerDir, task }).slice(0, 32)}`
      const identity = sha({ binding, task, operation })
      op = { operation, command, taskId: `codex-${identity.slice(0, 32)}`, sessionId, requestId: `codex-${identity}`, fingerprint, status: 'prepared', promptSent: false, ...(entry ? { parentTaskId: entry.operations[entry.lastOperation].taskId, rootTaskId: entry.operations[entry.firstOperation].taskId } : {}), createSession: command === 'dispatch' && session === undefined }
      if (!entry) {
        entry = { task, binding, sessionId, firstOperation: operation, lastOperation: operation, operations: {} }
        Object.defineProperty(ledger.tasks, task, { value: entry, enumerable: true, writable: true })
      }
      Object.defineProperty(entry.operations, operation, { value: op, enumerable: true, writable: true })
      entry.lastOperation = operation
      saveLedger(paths.file, ledger)
    }
    const save = status => { op.status = status; saveLedger(paths.file, ledger) }
    if (stages.indexOf(op.status) < stages.indexOf('created')) {
      if (op.createSession) {
        save('creating')
        const created = rpc('session', 'create', { sessionId: entry.sessionId, ...(cwd === undefined ? { standalone: true } : { cwd }), ...(preset === undefined ? {} : { permissionPreset: preset }) })
        if (created?.sessionId !== entry.sessionId) throw new Error('ambiguous session.create response; retry the same operation id to adopt its recorded session')
      }
      save('created')
    }
    const permissions = permissionCheck(rpc, entry.sessionId, preset ?? entry.preset)
    if (entry.preset === undefined) { entry.preset = permissions.preset; saveLedger(paths.file, ledger) }
    if (op.status !== 'sending') {
      requireIdle(rpc, entry.sessionId, permissions)
      requireFeedbackIdle(rpc, op)
    }
    if (stages.indexOf(op.status) < stages.indexOf('configured')) {
      if (provider !== undefined) rpc('session', 'selectModel', { sessionId: entry.sessionId, provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
      save('configured')
    }
    if (stages.indexOf(op.status) < stages.indexOf('registered')) {
      save('registering')
      const registration = { taskId: op.taskId, sessionId: entry.sessionId, target: { kind: 'codex-thread', threadId: config.targetThreadId }, acceptance, ...(op.parentTaskId ? { parentTaskId: op.parentTaskId, rootTaskId: op.rootTaskId } : {}) }
      const registered = rpc('taskFeedback', 'register', registration)?.task
      if (!record(registered) || registered.taskId !== op.taskId || registered.sessionId !== entry.sessionId || registered.target?.threadId !== config.targetThreadId || registered.target?.kind !== 'codex-thread' || registered.acceptance !== acceptance) throw new Error('taskFeedback.register returned conflicting or incomplete task data; prompt was not sent')
      if (!['accepted', 'queued'].includes(registered.state)) throw new Error('registered task already observed another turn; inspect its feedback before sending')
      save('registered')
    }
    save('sending')
    const request = { sessionId: entry.sessionId, requestId: op.requestId, mode: 'queue', content: [{ type: 'text', text: prompt }] }
    const response = rpc('session', 'prompt', request)
    if (response?.accepted !== true) throw new Error('ambiguous session.prompt response; retry the same operation id to reconcile admission')
    op.accepted = true
    op.promptSent = true
    save('sent')
    return { ...op }
  })
}

/**
 * Parse native CLI arguments and dispatch one operation.
 * @param argv - arguments after the executable and script paths.
 * @returns the saved operation receipt.
 */
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  return runDispatch({ ...args, config: json(args.config ?? fileURLToPath(new URL('../coordinator.json', import.meta.url))) })
}
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(), null, 2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
