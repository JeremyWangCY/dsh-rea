import assert from 'node:assert/strict'
import test from 'node:test'
import { COMMAND_NAME, createPromptMessage, parseReaInput, registerReaCommand } from '../lib/command.js'

test('the command name is the plain greppable one', () => {
  assert.equal(COMMAND_NAME, 'rea')
})

test('a bare /rea reveals without inventing a request', () => {
  assert.deepEqual(parseReaInput(''), { directive: 'enable', request: '' })
  assert.deepEqual(parseReaInput('   '), { directive: 'enable', request: '' })
})

test('exact single words are directives', () => {
  for (const word of ['status', 'STATUS', 'Status']) assert.deepEqual(parseReaInput(word), { directive: 'status', request: '' })
  assert.deepEqual(parseReaInput(' off '), { directive: 'off', request: '' })
  assert.deepEqual(parseReaInput('on'), { directive: 'enable', request: '' })
})

test('a request is forwarded verbatim, never read as a directive', () => {
  const request = 'status of this dll: it keeps writing to temp'
  assert.deepEqual(parseReaInput(request), { directive: 'enable', request })
  assert.deepEqual(parseReaInput('  decompile the .so  '), { directive: 'enable', request: 'decompile the .so' })
  assert.deepEqual(parseReaInput('status of the app'), { directive: 'enable', request: 'status of the app' })
})

test('the forwarded message is a plain user-sourced prompt', () => {
  const message = createPromptMessage('look at this apk', () => 'fixed-id')
  assert.equal(message.id, 'fixed-id')
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, { kind: 'user' })
  assert.deepEqual(message.content, [{ type: 'text', text: 'look at this apk' }])
  assert.ok(Object.isFrozen(message))
})

test('the forwarded message is what unlocks the catalog', async () => {
  // Reuse the real classifier: the forwarded prompt must satisfy it, otherwise
  // /rea would reveal the tools for one turn and then lose them again.
  const { mentionsReverseEngineering } = await import('../lib/gate.js')
  assert.equal(mentionsReverseEngineering(createPromptMessage('看看这个 exe').content[0].text), true)
})

/** Minimal command registry stand-in that captures the registered definition. */
function harness() {
  const state = { definition: undefined, registered: 0, disposed: 0 }
  const ctx = {
    logger: { warn() {} },
    commands: {
      register(definition) {
        state.definition = definition
        state.registered += 1
        return () => { state.disposed += 1 }
      },
    },
  }
  return { ctx, state }
}

/** A gate double that records calls without touching any registry. */
function gateDouble(gated) {
  const calls = { unlocked: [], relocked: [], gated: gated }
  return {
    calls,
    isGated: () => calls.gated,
    unlock(agent) { calls.unlocked.push(agent); calls.gated = false; return true },
    relock(agent) { calls.relocked.push(agent); calls.gated = true; return true },
  }
}

test('registering /rea registers exactly one command and disposes it', () => {
  const { ctx, state } = harness()
  const dispose = registerReaCommand(ctx, { gate: gateDouble(true) })
  assert.equal(state.registered, 1)
  assert.equal(state.definition.name, 'rea')
  assert.equal(typeof state.definition.handler, 'function')
  assert.equal(typeof state.definition.description, 'string')
  dispose()
  assert.equal(state.disposed, 1)
})

test('/rea status reports state without unlocking anything', () => {
  const { ctx, state } = harness()
  const gate = gateDouble(true)
  registerReaCommand(ctx, { gate })
  const result = state.definition.handler({ agent: { id: 'a' }, rawInput: ' status', attachments: [] })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /hidden/u)
  assert.deepEqual(gate.calls.unlocked, [])
})

test('/rea reveals for the invoking agent only, and reports it', () => {
  const { ctx, state } = harness()
  const gate = gateDouble(true)
  registerReaCommand(ctx, { gate })
  const agent = { id: 'agent-1' }
  const result = state.definition.handler({ agent, rawInput: '', attachments: [] })
  assert.equal(result.kind, 'success')
  assert.deepEqual(gate.calls.unlocked, [agent])
})

test('/rea forwards the request as one user message on the same agent', () => {
  const { ctx, state } = harness()
  const gate = gateDouble(true)
  registerReaCommand(ctx, { gate })
  const queued = []
  const agent = { id: 'agent-1', followup: (message) => queued.push(message) }
  const result = state.definition.handler({ agent, rawInput: ' decompile this dll', attachments: [] })
  assert.equal(result.kind, 'success')
  assert.equal(queued.length, 1)
  assert.equal(queued[0].role, 'user')
  assert.equal(queued[0].content[0].text, 'decompile this dll')
  assert.deepEqual(gate.calls.unlocked, [agent])
})

test('/rea off hides the catalog again for this session', () => {
  const { ctx, state } = harness()
  const gate = gateDouble(false)
  registerReaCommand(ctx, { gate })
  const agent = { id: 'a' }
  const result = state.definition.handler({ agent, rawInput: 'off', attachments: [] })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /hidden for this session/u)
  assert.deepEqual(gate.calls.relocked, [agent])
  assert.deepEqual(gate.calls.unlocked, [])
})

test('/rea off on an already-hidden catalog is a no-op, not an error', () => {
  const { ctx, state } = harness()
  const gate = gateDouble(true)
  registerReaCommand(ctx, { gate })
  const result = state.definition.handler({ agent: { id: 'a' }, rawInput: 'off', attachments: [] })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /already hidden/u)
  assert.deepEqual(gate.calls.relocked, [])
})

test('/rea reveals again after /rea off', () => {
  const { ctx, state } = harness()
  const gate = gateDouble(false)
  registerReaCommand(ctx, { gate })
  const agent = { id: 'a' }
  state.definition.handler({ agent, rawInput: 'off', attachments: [] })
  assert.equal(gate.calls.gated, true)
  const result = state.definition.handler({ agent, rawInput: '', attachments: [] })
  assert.equal(result.kind, 'success')
  assert.equal(gate.calls.gated, false)
  assert.deepEqual(gate.calls.relocked, [agent])
  assert.deepEqual(gate.calls.unlocked, [agent])
})

test('/rea status reports hidden again after /rea off', () => {
  const { ctx, state } = harness()
  registerReaCommand(ctx, { gate: gateDouble(false) })
  state.definition.handler({ agent: { id: 'a' }, rawInput: 'off', attachments: [] })
  const result = state.definition.handler({ agent: { id: 'a' }, rawInput: 'status', attachments: [] })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /hidden/u)
})

test('a failing reveal reports an error instead of throwing at the composer', () => {
  const { ctx, state } = harness()
  const gate = { isGated: () => true, unlock() { throw new Error('registry exploded') }, calls: {} }
  registerReaCommand(ctx, { gate })
  const result = state.definition.handler({ agent: { id: 'a' }, rawInput: '', attachments: [] })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /registry exploded/u)
})

test('a queued message that fails to enqueue reports an error', () => {
  const { ctx, state } = harness()
  registerReaCommand(ctx, { gate: gateDouble(true) })
  const agent = { id: 'a', followup() { throw new Error('inbox closed') } }
  const result = state.definition.handler({ agent, rawInput: 'do work', attachments: [] })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /inbox closed/u)
})
