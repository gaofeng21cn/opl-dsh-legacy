import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDispatch } from './dispatch.mjs'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'opl-dispatch-test-'))
  const promptFile = join(dir, 'prompt.txt')
  const acceptanceFile = join(dir, 'acceptance.txt')
  writeFileSync(promptFile, 'do the work')
  writeFileSync(acceptanceFile, 'tests pass')
  const config = { controlCli: '/unused/control.mjs', ledgerDir: join(dir, 'ledger'), targetThreadId: 'thread-1' }
  return { dir, promptFile, acceptanceFile, config }
}
function opts(f, extra = {}) { return { ...f, ...extra, command: extra.command ?? 'dispatch', task: extra.task ?? 'task-1', promptFile: f.promptFile, acceptanceFile: f.acceptanceFile } }

test('register failure does not send prompt', () => {
  const f = fixture(); const calls = []
  assert.throws(() => runDispatch(opts(f), request => { calls.push(request); if (request.method === 'create') return { value: { sessionId: 's1' } }; throw new Error('register refused') }), /register refused/)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].namespace, 'taskFeedback')
})

test('repeated execution is idempotent', () => {
  const f = fixture(); const calls = []
  const invoke = request => { calls.push(request); if (request.method === 'create') return { value: { sessionId: 's1' } }; if (request.method === 'register') return { value: { task: { taskId: 'task-1' } } }; return { value: { accepted: true, requestId: 'x' } } }
  const first = runDispatch(opts(f), invoke); const second = runDispatch(opts(f), invoke)
  assert.equal(first.requestId, second.requestId); assert.equal(second.idempotent, true)
  assert.equal(calls.filter(x => x.method === 'prompt').length, 1)
})

test('conflicting task inputs are rejected', () => {
  const f = fixture(); const invoke = request => request.method === 'create' ? { value: { sessionId: 's1' } } : request.method === 'register' ? { value: { task: {} } } : { value: { accepted: true } }
  runDispatch(opts(f), invoke)
  writeFileSync(f.promptFile, 'different')
  assert.throws(() => runDispatch(opts(f), invoke), /different inputs/)
})

test('ambiguous create response is never retried', () => {
  const f = fixture(); let creates = 0
  assert.throws(() => runDispatch(opts(f), request => { if (request.method === 'create') { creates++; return { value: {} } }; throw new Error('unexpected') }), /ambiguous session.create/)
  assert.equal(creates, 1)
})

test('an interrupted create is persisted and requires reconciliation', () => {
  const f = fixture(); let creates = 0
  const interrupted = request => {
    if (request.method === 'create') { creates++; return { value: { sessionId: 's-created' } } }
    throw new Error('control process interrupted after create')
  }
  assert.throws(() => runDispatch(opts(f), interrupted), /interrupted after create/)
  assert.throws(() => runDispatch(opts(f), request => { if (request.method === 'create') creates++; throw new Error('must not run') }), /unfinished session.create/)
  assert.equal(creates, 1)
})

test('unsupported WSL path mode is rejected explicitly', () => {
  const f = fixture()
  assert.throws(() => runDispatch(opts(f, { config: { ...f.config, pathMode: 'wsl', wslDistro: 'Ubuntu' } }), () => { throw new Error('must not call control') }), /unsupported pathMode wsl/)
})

test('ambiguous prompt may retry with the same request id', () => {
  const f = fixture(); const prompts = []
  const invoke = request => {
    if (request.method === 'create') return { value: { sessionId: 's1' } }
    if (request.method === 'register') return { value: { task: {} } }
    prompts.push(request.args.request)
    if (prompts.length === 1) throw new Error('request timed out; ambiguous')
    return { value: { accepted: true, requestId: prompts[0].requestId } }
  }
  const result = runDispatch(opts(f), invoke)
  assert.equal(prompts.length, 2); assert.equal(prompts[0].requestId, prompts[1].requestId); assert.equal(result.accepted, true)
})
