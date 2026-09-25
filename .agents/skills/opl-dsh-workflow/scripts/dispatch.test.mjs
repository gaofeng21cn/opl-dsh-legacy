import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createControlInvoker, main, runDispatch } from './dispatch.mjs'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'opl-dispatch-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const promptFile = join(dir, 'prompt.txt')
  const acceptanceFile = join(dir, 'acceptance.txt')
  writeFileSync(promptFile, 'do the work')
  writeFileSync(acceptanceFile, 'tests pass')
  const config = { controlCli: join(dir, 'control.mjs'), ledgerDir: join(dir, 'ledger'), targetThreadId: 'thread-1' }
  return { dir, promptFile, acceptanceFile, config }
}
function opts(f, extra = {}) { return { config: f.config, promptFile: f.promptFile, acceptanceFile: f.acceptanceFile, command: 'dispatch', task: 'task-1', operation: 'initial', ...extra } }
function readLedger(f) { return JSON.parse(readFileSync(join(f.config.ledgerDir, 'dispatch-ledger.json'), 'utf8')) }
function host() {
  const calls = [], sessions = new Map(), tasks = new Map(), prompts = new Map()
  const invoke = request => {
    calls.push(request)
    const value = request.args.request
    if (request.method === 'create') {
      sessions.set(value.sessionId, sessions.get(value.sessionId) ?? { preset: value.permissionPreset ?? 'workspace-write', running: false, turn: null, inbox: { 'next-turn': [], 'next-step': [] } })
      return { value: { sessionId: value.sessionId } }
    }
    if (request.method === 'permissions') return { value: { sessionId: value.sessionId, ...sessions.get(value.sessionId) } }
    if (request.method === 'projections') return { value: { asOfSeq: 0, values: { inbox: sessions.get(value.sessionId)?.inbox } } }
    if (request.method === 'register') {
      if (!tasks.has(value.taskId)) tasks.set(value.taskId, { ...value, state: 'accepted' })
      return { value: { task: tasks.get(value.taskId) } }
    }
    if (request.method === 'tasks') return { value: [...tasks.values()] }
    if (request.method === 'selectModel') return { value: { selected: value } }
    if (request.method === 'prompt') {
      if (!prompts.has(value.requestId)) prompts.set(value.requestId, value)
      return { value: { accepted: true } }
    }
    throw new Error(`unexpected ${request.method}`)
  }
  return { calls, sessions, tasks, prompts, invoke }
}

test('repeating one operation sends one prompt and returns the same receipt', t => {
  const f = fixture(t), h = host()
  const first = runDispatch(opts(f), h.invoke)
  const count = h.calls.length
  const second = runDispatch(opts(f), h.invoke)
  assert.equal(second.requestId, first.requestId)
  assert.equal(second.idempotent, true)
  assert.equal(h.calls.length, count)
  assert.equal(h.prompts.size, 1)
  assert.equal(readLedger(f).tasks['task-1'].operations.initial.status, 'sent')
})

test('new continuation preserves the session and records independent feedback and lineage', t => {
  const f = fixture(t), h = host()
  const first = runDispatch(opts(f), h.invoke)
  h.tasks.get(first.taskId).state = 'completed'
  writeFileSync(f.promptFile, 'continue with the reviewed correction')
  const next = runDispatch(opts(f, { command: 'continue', operation: 'review-1' }), h.invoke)
  assert.equal(next.sessionId, first.sessionId)
  assert.notEqual(next.requestId, first.requestId)
  assert.notEqual(next.taskId, first.taskId)
  assert.equal(next.parentTaskId, first.taskId)
  assert.equal(next.rootTaskId, first.taskId)
  assert.equal(h.tasks.get(next.taskId).parentTaskId, first.taskId)
  assert.equal(h.calls.filter(call => call.method === 'create').length, 1)
  assert.equal(h.prompts.size, 2)
  const count = h.calls.length
  assert.equal(runDispatch(opts(f, { command: 'continue', operation: 'review-1' }), h.invoke).idempotent, true)
  assert.equal(h.calls.length, count)
})

test('one operation cannot be reused with changed input or command', t => {
  const f = fixture(t), h = host()
  runDispatch(opts(f), h.invoke)
  assert.throws(() => runDispatch(opts(f, { command: 'continue' }), h.invoke), /different inputs/)
  writeFileSync(f.promptFile, 'changed')
  assert.throws(() => runDispatch(opts(f), h.invoke), /different inputs/)
  assert.equal(h.prompts.size, 1)
})

test('continue waits for prior terminal feedback and an idle session', t => {
  const f = fixture(t), h = host()
  const initial = runDispatch(opts(f), h.invoke)
  const next = opts(f, { command: 'continue', operation: 'review' })
  for (const state of ['accepted', 'running', 'waiting_input', 'waiting_approval', 'disconnected']) {
    h.tasks.get(initial.taskId).state = state
    assert.throws(() => runDispatch(next, h.invoke), /terminal task state/)
  }
  h.tasks.get(initial.taskId).state = 'failed'
  h.sessions.get(initial.sessionId).running = true
  assert.throws(() => runDispatch(next, h.invoke), /live turn/)
  h.sessions.get(initial.sessionId).running = false
  h.sessions.get(initial.sessionId).inbox['next-turn'] = [{ id: 'other-input' }]
  assert.throws(() => runDispatch(next, h.invoke), /pending input/)
  h.sessions.get(initial.sessionId).inbox['next-turn'] = []
  assert.equal(runDispatch(next, h.invoke).accepted, true)
  assert.equal(h.prompts.size, 2)
})

test('register failure retains the created session and retry resumes it', t => {
  const f = fixture(t), h = host()
  assert.throws(() => runDispatch(opts(f), request => {
    if (request.method === 'register') throw new Error('register refused')
    return h.invoke(request)
  }), /register refused/)
  const saved = readLedger(f).tasks['task-1']
  assert.equal(saved.operations.initial.status, 'registering')
  assert.ok(saved.sessionId)
  assert.equal(h.prompts.size, 0)
  const result = runDispatch(opts(f), h.invoke)
  assert.equal(result.sessionId, saved.sessionId)
  assert.equal(h.calls.filter(call => call.method === 'create').length, 1)
})

test('lost registration reply reuses the feedback identity before sending once', t => {
  const f = fixture(t), h = host()
  assert.throws(() => runDispatch(opts(f), request => {
    const result = h.invoke(request)
    if (request.method === 'register') throw new Error('registration reply timed out')
    return result
  }), /timed out/)
  assert.equal(h.tasks.size, 1)
  assert.equal(h.prompts.size, 0)
  const result = runDispatch(opts(f), h.invoke)
  assert.equal(h.tasks.size, 1)
  assert.equal(h.prompts.size, 1)
  assert.equal(h.tasks.get(result.taskId).state, 'accepted')
})

test('adopting an existing session refuses another active feedback task', t => {
  const f = fixture(t), h = host()
  h.sessions.set('existing', { preset: 'workspace-write', running: false, turn: null, inbox: { 'next-turn': [], 'next-step': [] } })
  h.tasks.set('other-task', { taskId: 'other-task', sessionId: 'existing', state: 'accepted' })
  assert.throws(() => runDispatch(opts(f, { command: 'continue', session: 'existing' }), h.invoke), /another task is still active/)
  assert.equal(h.prompts.size, 0)
  assert.equal(h.calls.filter(call => call.method === 'create').length, 0)
})

test('a registered operation cannot accidentally watch a different completed turn', t => {
  const f = fixture(t), h = host()
  assert.throws(() => runDispatch(opts(f), request => {
    const result = h.invoke(request)
    if (request.method === 'register') {
      h.tasks.get(request.args.request.taskId).state = 'completed'
      throw new Error('registration reply lost')
    }
    return result
  }), /reply lost/)
  assert.throws(() => runDispatch(opts(f), h.invoke), /already observed another turn/)
  assert.equal(h.prompts.size, 0)
})

test('lost creation reply retries the same explicit session identity', t => {
  const f = fixture(t), h = host()
  assert.throws(() => runDispatch(opts(f), request => {
    const result = h.invoke(request)
    if (request.method === 'create') throw new Error('reply timed out')
    return result
  }), /timed out/)
  assert.equal(readLedger(f).tasks['task-1'].operations.initial.status, 'creating')
  const result = runDispatch(opts(f), h.invoke)
  assert.equal(h.sessions.size, 1)
  assert.equal(h.calls.filter(call => call.method === 'create').length, 2)
  assert.equal(h.calls[0].args.request.sessionId, result.sessionId)
})

test('malformed creation reply never admits a prompt and remains recoverable', t => {
  const f = fixture(t), h = host()
  assert.throws(() => runDispatch(opts(f), request => {
    const result = h.invoke(request)
    return request.method === 'create' ? { value: {} } : result
  }), /ambiguous session.create/)
  assert.equal(h.prompts.size, 0)
  assert.equal(runDispatch(opts(f), h.invoke).accepted, true)
  assert.equal(h.sessions.size, 1)
})

test('lost prompt reply preserves one request identity during an active turn', t => {
  const f = fixture(t), h = host()
  assert.throws(() => runDispatch(opts(f), request => {
    const result = h.invoke(request)
    if (request.method === 'prompt') {
      h.sessions.get(request.args.request.sessionId).running = true
      throw new Error('reply timed out')
    }
    return result
  }), /timed out/)
  const first = readLedger(f).tasks['task-1'].operations.initial
  assert.equal(first.status, 'sending')
  const result = runDispatch(opts(f), h.invoke)
  assert.equal(result.requestId, first.requestId)
  assert.equal(h.prompts.size, 1)
  assert.equal(h.calls.filter(call => call.method === 'register').length, 1)
})

test('a permission mismatch sends nothing and retry never widens permission', t => {
  const f = fixture(t), h = host()
  h.sessions.set('existing', { preset: 'workspace-write', running: false, turn: null, inbox: { 'next-turn': [], 'next-step': [] } })
  const options = opts(f, { command: 'continue', session: 'existing', preset: 'danger-full-access' })
  assert.throws(() => runDispatch(options, h.invoke), /permission preset validation failed/)
  assert.equal(h.prompts.size, 0)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].method, 'permissions')
  assert.equal(h.sessions.get('existing').preset, 'workspace-write')
})

test('permission drift fails a new continuation without switching presets', t => {
  const f = fixture(t), h = host()
  const initial = runDispatch(opts(f), h.invoke)
  h.tasks.get(initial.taskId).state = 'completed'
  h.sessions.get(initial.sessionId).preset = 'danger-full-access'
  assert.throws(() => runDispatch(opts(f, { command: 'continue', operation: 'next' }), h.invoke), /expected workspace-write/)
  assert.equal(h.prompts.size, 1)
  assert.equal(h.calls.filter(call => call.method === 'selectPermissions').length, 0)
})

test('input and configuration validation precede session mutation', t => {
  const f = fixture(t), h = host()
  for (const extra of [
    { command: 'oops' }, { operation: '' }, { task: '../task' }, { provider: 'deepseek' }, { effort: 'high' }, { cwd: './relative' }, { session: 'existing', cwd: f.dir },
    { config: { ...f.config, controlCli: './relative' } }, { config: { ...f.config, pathMode: 'wsl' } },
    { config: { ...f.config, timeoutMs: -1 } }, { config: { ...f.config, targetThreadID: 'typo' } },
  ]) assert.throws(() => runDispatch(opts(f, extra), h.invoke))
  writeFileSync(f.promptFile, '   ')
  assert.throws(() => runDispatch(opts(f), h.invoke), /non-empty/)
  assert.equal(h.calls.length, 0)
  assert.equal(existsSync(f.config.ledgerDir), false)
})

test('task binding prevents redirecting a retry to a different thread or session', t => {
  const f = fixture(t), h = host()
  runDispatch(opts(f), h.invoke)
  assert.throws(() => runDispatch(opts(f, { config: { ...f.config, targetThreadId: 'other-thread' } }), h.invoke), /different desktop or target thread/)
  assert.throws(() => runDispatch(opts(f, { session: 'other-session' }), h.invoke), /session differs/)
})

test('existing dispatch and unfinished operations cannot allocate new sessions', t => {
  const f = fixture(t), h = host()
  assert.throws(() => runDispatch(opts(f), request => {
    if (request.method === 'register') throw new Error('register refused')
    return h.invoke(request)
  }), /register refused/)
  assert.throws(() => runDispatch(opts(f, { operation: 'other' }), h.invoke), /task already exists/)
  assert.throws(() => runDispatch(opts(f, { command: 'continue', operation: 'other' }), h.invoke), /unfinished operation/)
  assert.equal(h.sessions.size, 1)
})

test('incomplete or conflicting feedback registration never admits a prompt', t => {
  const f = fixture(t), h = host()
  assert.throws(() => runDispatch(opts(f), request => {
    if (request.method === 'register') return { value: { task: {} } }
    return h.invoke(request)
  }), /conflicting or incomplete task data/)
  assert.equal(h.prompts.size, 0)
})

test('malformed permission and inbox replies cannot be treated as idle', t => {
  const f = fixture(t), h = host()
  assert.throws(() => runDispatch(opts(f), request => request.method === 'permissions' ? { value: { preset: 'workspace-write' } } : h.invoke(request)), /invalid session.permissions/)
  assert.throws(() => runDispatch(opts(f), request => request.method === 'projections' ? { value: null } : h.invoke(request)), /inbox is unavailable/)
  assert.equal(h.prompts.size, 0)
})

test('an admission reply must explicitly report accepted true', t => {
  const f = fixture(t), h = host()
  assert.throws(() => runDispatch(opts(f), request => request.method === 'prompt' ? { value: { requestId: 'not-proof' } } : h.invoke(request)), /ambiguous session.prompt/)
  assert.equal(readLedger(f).tasks['task-1'].operations.initial.status, 'sending')
})

test('ledger lock rejects concurrent callers and is released after failure', t => {
  const f = fixture(t), h = host()
  assert.throws(() => runDispatch(opts(f), request => {
    assert.throws(() => runDispatch(opts(f), h.invoke), /ledger is locked/)
    throw new Error('simulated interruption')
  }), /simulated interruption/)
  assert.equal(existsSync(join(f.config.ledgerDir, '.dispatch.lock')), false)
  assert.equal(runDispatch(opts(f), h.invoke).accepted, true)
  assert.deepEqual(readdirSync(f.config.ledgerDir), ['dispatch-ledger.json'])
  if (process.platform !== 'win32') assert.equal(statSync(join(f.config.ledgerDir, 'dispatch-ledger.json')).mode & 0o777, 0o600)
})

test('invalid and legacy ledgers fail closed before any control request', t => {
  const f = fixture(t), h = host()
  runDispatch(opts(f), h.invoke)
  const file = join(f.config.ledgerDir, 'dispatch-ledger.json')
  const count = h.calls.length
  for (const data of [{ version: 1, tasks: {} }, { version: 2, tasks: null }, { version: 2, tasks: { bad: null } }]) {
    writeFileSync(file, JSON.stringify(data))
    assert.throws(() => runDispatch(opts(f), h.invoke), /invalid/)
  }
  assert.equal(h.calls.length, count)
})

test('CLI rejects duplicate, unknown, and missing operation arguments', () => {
  const base = ['dispatch', '--config', 'config.json', '--task', 'task', '--operation', 'initial', '--prompt-file', 'prompt', '--acceptance-file', 'acceptance']
  assert.throws(() => main([...base, '--operation', 'again']), /duplicate/)
  assert.throws(() => main([...base, '--operaton', 'typo']), /unknown/)
  assert.throws(() => main(base.filter((_, i) => i !== 5 && i !== 6)), /operation/)
})

test('the real CLI entry path runs from a directory with spaces and Unicode', t => {
  const f = fixture(t)
  const script = join(f.dir, 'dispatch 中文 # script.mjs')
  copyFileSync(fileURLToPath(new URL('./dispatch.mjs', import.meta.url)), script)
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /usage: dispatch\|continue/)
})

test('the real control subprocess receives private files and supports repeated admission', t => {
  const f = fixture(t)
  const home = join(f.dir, 'dsh-home')
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
  writeFileSync(join(home, 'profiles', 'desktop', 'control.json'), '{}')
  f.config.dshHome = home
  const log = join(f.dir, 'calls.jsonl')
  writeFileSync(f.config.controlCli, `import { readFileSync, appendFileSync, statSync } from 'node:fs';\nconst file = process.argv[process.argv.indexOf('--file') + 1];\nconst r = JSON.parse(readFileSync(file, 'utf8'));\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ ...r, mode: statSync(file).mode & 511, file }) + '\\n');\nconst q = r.args.request;\nconst value = r.method === 'tasks' ? [] : r.method === 'create' ? { sessionId: q.sessionId } : r.method === 'permissions' ? { sessionId: q.sessionId, preset: 'workspace-write', running: false, turn: null } : r.method === 'projections' ? { values: { inbox: { 'next-turn': [], 'next-step': [] } } } : r.method === 'register' ? { task: { ...q, state: 'accepted' } } : { accepted: true };\nconsole.log(JSON.stringify({ value }));\n`)
  const configFile = join(f.dir, 'config.json')
  writeFileSync(configFile, JSON.stringify(f.config))
  const args = ['dispatch', '--config', configFile, '--task', 'task', '--operation', 'initial', '--prompt-file', f.promptFile, '--acceptance-file', f.acceptanceFile]
  const first = main(args), second = main(args)
  assert.equal(first.requestId, second.requestId)
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(calls.filter(call => call.method === 'prompt').length, 1)
  assert.ok(calls.every(call => !existsSync(call.file)))
  if (process.platform !== 'win32') assert.ok(calls.every(call => call.mode === 0o600))
})

test('the control invoker starts DSH once when its binding is absent', t => {
  const f = fixture(t)
  const home = join(f.dir, 'dsh-home')
  const binding = join(home, 'profiles', 'desktop', 'control.json')
  writeFileSync(f.config.controlCli, `console.log(JSON.stringify({ value: { ok: true } }))\n`)
  const config = {
    ...f.config,
    dshHome: home,
    startCommand: process.execPath,
    startArgs: ['-e', `const fs=require('node:fs'); fs.mkdirSync(${JSON.stringify(join(home, 'profiles', 'desktop'))},{recursive:true}); fs.writeFileSync(${JSON.stringify(binding)}, '{}')`],
    startupTimeoutMs: 5000,
  }
  const invoke = createControlInvoker(config)
  assert.deepEqual(invoke({ namespace: 'session', method: 'list', args: {} }), { value: { ok: true } })
  assert.deepEqual(invoke({ namespace: 'session', method: 'list', args: {} }), { value: { ok: true } })
  assert.ok(existsSync(binding))
})


test('runtime thread overrides isolate identical task ids without changing legacy ledgers', t => {
  const f = fixture(t), h = host()
  f.config.ledgerPerThread = true
  const a = runDispatch(opts(f, { thread: 'codex-task-a' }), h.invoke)
  const b = runDispatch(opts(f, { thread: 'codex-task-b' }), h.invoke)
  assert.notEqual(a.sessionId, b.sessionId)
  assert.equal(readdirSync(f.config.ledgerDir).length, 2)
  const registrations = h.calls.filter(call => call.method === 'register')
  assert.equal(registrations.length, 2)
})

test('installed helper reads its own config outside the repository and requires a real thread', t => {
  const f = fixture(t)
  const scripts = join(f.dir, 'skill', 'scripts')
  mkdirSync(scripts, { recursive: true })
  const script = join(scripts, 'dispatch.mjs')
  copyFileSync(fileURLToPath(new URL('./dispatch.mjs', import.meta.url)), script)
  const config = { ...f.config, targetThreadId: undefined }
  writeFileSync(join(f.dir, 'skill', 'coordinator.json'), JSON.stringify(config))
  const args = [script, 'dispatch', '--task', 't', '--operation', 'first', '--prompt-file', f.promptFile, '--acceptance-file', f.acceptanceFile]
  const environment = { ...process.env }
  delete environment.CODEX_THREAD_ID
  const missing = spawnSync(process.execPath, args, { cwd: tmpdir(), env: environment, encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /targetThreadId/)
  const supplied = spawnSync(process.execPath, [...args, '--thread', 'actual-task-id'], { cwd: tmpdir(), env: environment, encoding: 'utf8' })
  assert.equal(supplied.status, 1)
  assert.doesNotMatch(supplied.stderr, /targetThreadId|coordinator.json/)
})

test('Electron Node mode is passed only to the control client, never to the GUI launcher', t => {
  const f = fixture(t)
  const home = join(f.dir, 'home'), envLog = join(f.dir, 'launcher-env.json')
  const bindingDir = join(home, 'profiles', 'desktop')
  const launcher = join(f.dir, 'launcher.mjs')
  writeFileSync(launcher, `import fs from 'node:fs'; fs.mkdirSync(${JSON.stringify(bindingDir)}, {recursive:true}); fs.writeFileSync(${JSON.stringify(envLog)}, JSON.stringify({nodeMode:process.env.ELECTRON_RUN_AS_NODE ?? null})); fs.writeFileSync(${JSON.stringify(join(bindingDir, 'control.json'))}, '{}')`)
  writeFileSync(f.config.controlCli, `console.log(JSON.stringify({nodeMode:process.env.ELECTRON_RUN_AS_NODE}))`)
  const prior = process.env.ELECTRON_RUN_AS_NODE
  process.env.ELECTRON_RUN_AS_NODE = '1'
  t.after(() => { if (prior === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = prior })
  const invoke = createControlInvoker({ ...f.config, node: process.execPath, electronNode: true, dshHome: home, startCommand: process.execPath, startArgs: [launcher], startupTimeoutMs: 5000 })
  assert.deepEqual(invoke({namespace:'session',method:'list',args:{}}), {nodeMode:'1'})
  assert.deepEqual(JSON.parse(readFileSync(envLog, 'utf8')), {nodeMode:null})
})
