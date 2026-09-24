#!/usr/bin/env node
/** Dispatch and continue OPL DSH work through the desktop control CLI. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const json = file => JSON.parse(readFileSync(file, 'utf8'))

/** Invoke the existing control CLI's rpc command, preserving its token handling. */
export function createControlInvoker(config) {
  const node = config.node ?? process.execPath
  const cli = resolve(config.controlCli)
  return request => {
    const dir = mkdtempSync(join(tmpdir(), 'opl-dsh-dispatch-'))
    const file = join(dir, 'request.json')
    try {
      writeFileSync(file, JSON.stringify(request))
      const env = { ...process.env }
      if (config.dshHome) env.DSH_OPL_HOME = resolve(config.dshHome)
      const result = spawnSync(node, [cli, 'rpc', '--file', file], {
        encoding: 'utf8', env, timeout: config.timeoutMs ?? 150_000,
      })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error((result.stderr || 'control CLI failed').trim())
      const line = result.stdout.trim()
      return line ? JSON.parse(line) : undefined
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
}

function valueOf(response) {
  if (!response || response.ok === false || response.code) throw new Error(`control request failed: ${response?.code ?? 'unknown'}`)
  return response.value ?? response
}
function parseArgs(argv) {
  const command = argv[0]
  if (command !== 'dispatch' && command !== 'continue') throw new Error('usage: dispatch|continue --config config.json ...')
  const out = { command }
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) throw new Error(`unexpected argument ${token}`)
    const key = token.slice(2).replaceAll('-', '')
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`)
    out[key] = value
  }
  if (!out.config || !out.task || !out.promptfile || !out.acceptancefile) throw new Error('--config, --task, --prompt-file, and --acceptance-file are required')
  return out
}

function ledgerPaths(config) {
  const dir = resolve(config.ledgerDir)
  mkdirSync(dir, { recursive: true })
  return { dir, file: join(dir, 'dispatch-ledger.json'), lock: join(dir, '.dispatch.lock') }
}
function withLock(lock, fn) {
  let fd
  try { fd = openSync(lock, 'wx') } catch { throw new Error(`dispatch ledger is locked: ${lock}`) }
  try { return fn() } finally { closeSync(fd); unlinkSync(lock) }
}
function readLedger(file) {
  if (!existsSync(file)) return { version: 1, tasks: {} }
  const data = json(file)
  if (data.version !== 1 || typeof data.tasks !== 'object') throw new Error('invalid dispatch ledger')
  return data
}
function saveLedger(file, ledger) { writeFileSync(file, JSON.stringify(ledger, null, 2) + '\n') }

/** Execute one dispatch operation. `invoke` is injectable for node:test. */
export function runDispatch(options, invoke = createControlInvoker(options.config)) {
  const { config, command, task, promptFile, acceptanceFile, cwd, session, provider, model, effort, preset } = options
  if (!config?.controlCli || !config?.ledgerDir || !config?.targetThreadId) throw new Error('config requires controlCli, ledgerDir, and targetThreadId')
  if (config.pathMode !== undefined && config.pathMode !== 'native') throw new Error(`unsupported pathMode ${config.pathMode}; WSL path bridging is not implemented`)
  const prompt = readFileSync(promptFile, 'utf8')
  const acceptance = readFileSync(acceptanceFile, 'utf8')
  const fingerprint = sha({ task, prompt, acceptance, cwd, session, provider, model, effort, preset })
  const paths = ledgerPaths(config)
  return withLock(paths.lock, () => {
    const ledger = readLedger(paths.file)
    const prior = ledger.tasks[task]
    if (prior && prior.fingerprint !== fingerprint) throw new Error(`task ${task} already exists with different inputs`)
    if (prior?.promptSent) return { ...prior, idempotent: true }
    if (prior?.status === 'creating') throw new Error(`task ${task} has an unfinished session.create; inspect the desktop and reconcile it manually`)
    let sessionId = session ?? prior?.sessionId
    if (command === 'dispatch' && !sessionId) {
      ledger.tasks[task] = { taskId: task, fingerprint, status: 'creating', promptSent: false }
      saveLedger(paths.file, ledger)
      const created = valueOf(invoke({ namespace: 'session', method: 'create', args: { request: { ...(cwd ? { cwd } : { standalone: true }), ...(preset ? { permissionPreset: preset } : {}) } } }))
      sessionId = created.sessionId ?? created.session?.sessionId
      if (typeof sessionId !== 'string') throw new Error('ambiguous session.create response; do not retry automatically, inspect the desktop')
    }
    if (!sessionId) throw new Error('continue requires --session or a ledger entry')
    if ((provider === undefined) !== (model === undefined)) throw new Error('--provider and --model must be supplied together')
    if (provider !== undefined) {
      valueOf(invoke({ namespace: 'session', method: 'selectModel', args: { request: {
        sessionId, provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }),
      } } }))
    } else if (effort !== undefined) throw new Error('--effort requires --provider and --model')
    if (preset) {
      const permissions = valueOf(invoke({ namespace: 'session', method: 'permissions', args: { request: { sessionId } } }))
      const effective = permissions.effectivePreset ?? permissions.preset ?? permissions.permissionPreset
      if (effective !== preset) throw new Error(`permission preset validation failed: expected ${preset}, got ${effective ?? 'unknown'}`)
    }
    const taskId = prior?.taskId ?? task
    const registered = valueOf(invoke({ namespace: 'taskFeedback', method: 'register', args: { request: {
      taskId, sessionId, target: { kind: 'codex-thread', threadId: config.targetThreadId }, acceptance,
    } } }))
    if (!registered.task) throw new Error('ambiguous taskFeedback.register response; prompt was not sent')
    const requestId = prior?.requestId ?? sha({ taskId, fingerprint }).slice(0, 32)
    ledger.tasks[task] = { taskId, sessionId, requestId, fingerprint, status: 'registered', promptSent: false }
    saveLedger(paths.file, ledger)
    let promptResponse
    try {
      promptResponse = valueOf(invoke({ namespace: 'session', method: 'prompt', args: { request: {
        sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: prompt }],
      } } }))
    } catch (error) {
      if (!/ambiguous|timeout|timed out/i.test(String(error?.message))) throw error
      // The request may have reached the desktop. Retrying with the same id is safe.
      promptResponse = valueOf(invoke({ namespace: 'session', method: 'prompt', args: { request: {
        sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: prompt }],
      } } }))
    }
    if (promptResponse?.accepted === false || promptResponse?.accepted === undefined && promptResponse?.requestId === undefined) throw new Error('ambiguous session.prompt response; requestId must be checked manually')
    const record = { taskId, sessionId, requestId, fingerprint, status: 'sent', promptSent: true, accepted: promptResponse.accepted ?? true }
    ledger.tasks[task] = record
    saveLedger(paths.file, ledger)
    return record
  })
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const config = json(args.config)
  return runDispatch({ ...args, config, promptFile: args.promptfile, acceptanceFile: args.acceptancefile, cwd: args.cwd, session: args.session, provider: args.provider, model: args.model, effort: args.effort, preset: args.preset })
}
if (import.meta.url === `file://${process.argv[1]}`) {
  try { console.log(JSON.stringify(main(), null, 2)) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
