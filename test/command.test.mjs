import assert from 'node:assert/strict'
import test from 'node:test'
import { COMMAND_NAME, createPromptMessage, parseReaInput, registerReaCommand } from '../lib/command.js'
import { ReaVisibilityGate } from '../lib/gate.js'

test('the command name is the plain greppable one', () => {
  assert.equal(COMMAND_NAME, 'rea')
})

test('a bare /rea reveals without inventing a request', () => {
  assert.deepEqual(parseReaInput(''), { directive: 'enable', categories: null, request: '' })
  assert.deepEqual(parseReaInput('   '), { directive: 'enable', categories: null, request: '' })
})

test('exact single words are directives', () => {
  for (const word of ['status', 'STATUS', 'Status']) assert.deepEqual(parseReaInput(word), { directive: 'status', categories: null, request: '' })
  assert.deepEqual(parseReaInput(' off '), { directive: 'off', categories: null, request: '' })
  assert.deepEqual(parseReaInput('on'), { directive: 'enable', categories: null, request: '' })
})

test('a request is forwarded verbatim, never read as a directive', () => {
  const request = 'status of this dll: it keeps writing to temp'
  assert.deepEqual(parseReaInput(request), { directive: 'enable', categories: null, request })
  assert.deepEqual(parseReaInput('  decompile the .so  '), { directive: 'enable', categories: null, request: 'decompile the .so' })
  assert.deepEqual(parseReaInput('status of the app'), { directive: 'enable', categories: null, request: 'status of the app' })
})

test('the command re-exports the shared parser, with the category directives', () => {
  assert.deepEqual(parseReaInput('on native,android'), { directive: 'set', categories: ['native', 'android'], request: '' })
  assert.deepEqual(parseReaInput('add web'), { directive: 'add', categories: ['web'], request: '' })
  assert.deepEqual(parseReaInput('on this binary'), { directive: 'enable', categories: null, request: 'on this binary' })
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

/**
 * A gate double that records calls without touching any registry.
 * @param gated - whether the agent starts hidden.
 * @param extra - overrides for the gate surface.
 */
function gateDouble(gated, extra = {}) {
  const calls = { unlocked: [], relocked: [], gated: gated, revealed: [], set: [] }
  const view = () => (calls.gated ? { state: 'hidden', categories: [] } : { state: 'all', categories: ['native'] })
  return {
    calls,
    defaultCategories: ['all'],
    alwaysDeny: [],
    visibility: view,
    categoryBytes: () => new Map(),
    isGated: () => calls.gated,
    unlock(agent) { calls.unlocked.push(agent); calls.gated = false; return true },
    reveal(agent, categories) {
      calls.revealed.push({ agent, categories })
      calls.unlocked.push(agent)
      calls.gated = false
      return { state: 'all', categories: ['native'], added: [], denied: [] }
    },
    setCategories(agent, categories) {
      calls.set.push({ agent, categories })
      calls.gated = false
      return { state: 'partial', categories: [...categories], added: [], denied: [] }
    },
    relock(agent) { calls.relocked.push(agent); calls.gated = true; return true },
    ...extra,
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
  const gate = gateDouble(true, { reveal() { throw new Error('registry exploded') } })
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

test('/rea reveals the gate default categories', () => {
  const { ctx, state } = harness()
  const gate = gateDouble(true, { defaultCategories: ['native'] })
  registerReaCommand(ctx, { gate })
  state.definition.handler({ agent: { id: 'a' }, rawInput: '', attachments: [] })
  assert.deepEqual(gate.calls.revealed.map((entry) => entry.categories), [['native']])
})

test('/rea on <cats> replaces the revealed set', () => {
  const { ctx, state } = harness()
  const gate = gateDouble(true)
  registerReaCommand(ctx, { gate })
  const agent = { id: 'a' }
  const result = state.definition.handler({ agent, rawInput: ' on native,android', attachments: [] })
  assert.equal(result.kind, 'success')
  assert.deepEqual(gate.calls.set, [{ agent, categories: ['native', 'android'] }])
  assert.deepEqual(gate.calls.revealed, [])
  assert.match(result.text, /native, android/u)
})

test('/rea add <cats> widens the revealed set', () => {
  const { ctx, state } = harness()
  const gate = gateDouble(false)
  registerReaCommand(ctx, { gate })
  const agent = { id: 'a' }
  const result = state.definition.handler({ agent, rawInput: 'add web', attachments: [] })
  assert.equal(result.kind, 'success')
  assert.deepEqual(gate.calls.revealed, [{ agent, categories: ['web'] }])
  assert.deepEqual(gate.calls.set, [])
})

test('an unknown category is an error and applies nothing', () => {
  const { ctx, state } = harness()
  const gate = gateDouble(true)
  registerReaCommand(ctx, { gate })
  for (const rawInput of ['add web,foo', 'on native, nativ']) {
    const result = state.definition.handler({ agent: { id: 'a' }, rawInput, attachments: [] })
    assert.equal(result.kind, 'error', rawInput)
    assert.match(result.text, /Unknown REA category: (foo|nativ)\./u)
    assert.match(result.text, /Known: native, android/u)
    assert.match(result.text, /all\.$/u)
  }
  assert.deepEqual(gate.calls.revealed, [])
  assert.deepEqual(gate.calls.set, [])
  assert.equal(gate.calls.gated, true)
})

test('a request that merely starts with on or add is forwarded, not parsed as categories', () => {
  const { ctx, state } = harness()
  const gate = gateDouble(true)
  registerReaCommand(ctx, { gate })
  const queued = []
  const agent = { id: 'a', followup: (message) => queued.push(message) }
  state.definition.handler({ agent, rawInput: ' on this binary', attachments: [] })
  assert.equal(queued[0].content[0].text, 'on this binary')
  assert.deepEqual(gate.calls.set, [])
})

test('the command hint documents the category syntax', () => {
  const { ctx, state } = harness()
  registerReaCommand(ctx, { gate: gateDouble(true) })
  assert.equal(state.definition.input.hint, '[on [cats]|add <cats>|off|status] [request]')
})

/** A real gate over a minimal registry, for status text and default-category behaviour. */
function realGate(options) {
  const names = ['mcp__rea__n1', 'mcp__rea__n2', 'mcp__rea__w1', 'mcp__rea__c1']
  const kinds = { n1: 'native', n2: 'native', w1: 'web', c1: 'capture' }
  const restrictions = new Map()
  const ctx = {
    tools: {
      schemas: () => names.map((name) => ({ name, description: 'x'.repeat(name === 'mcp__rea__w1' ? 4096 : 1024), parameters: {} })),
      restrict: (filter) => { restrictions.set(filter.scope, filter.deny); return () => restrictions.delete(filter.scope) },
    },
  }
  const logger = { warn() {} }
  const gate = new ReaVisibilityGate(ctx, 'rea', logger, undefined, { categoryOf: (name) => kinds[name] ?? 'other', ...options })
  const agent = { id: 'a', scope: {}, session: { snapshotEvents: () => [] }, ctx: { tools: { restrict: (filter) => ctx.tools.restrict({ ...filter, scope: agent.scope }) } }, followup() {} }
  return { gate, agent, restrictions }
}

test('/rea <request> with defaultCategories [native] reveals only native and forwards the request', () => {
  const { ctx, state } = harness()
  const { gate, agent, restrictions } = realGate({ defaultCategories: ['native'] })
  const queued = []
  agent.followup = (message) => queued.push(message)
  registerReaCommand(ctx, { gate })
  const result = state.definition.handler({ agent, rawInput: ' look at this binary', attachments: [] })
  assert.equal(result.kind, 'success')
  assert.deepEqual(gate.visibility(agent), { state: 'partial', categories: ['native'] })
  assert.deepEqual([...restrictions.get(agent.scope)].sort(), ['mcp__rea__c1', 'mcp__rea__w1'])
  assert.equal(queued.length, 1)
  assert.match(result.text, /native/u)
})

test('/rea status shows state, loaded categories, tools and size, and what else is available', () => {
  const { ctx, state } = harness()
  const { gate, agent } = realGate({ alwaysDeny: ['capture'] })
  registerReaCommand(ctx, { gate })
  const hidden = state.definition.handler({ agent, rawInput: 'status', attachments: [] })
  assert.match(hidden.text, /^REA catalog: hidden/u)
  assert.match(hidden.text, /Available: web 4 KB \u00b7 native 2 KB/u)
  assert.doesNotMatch(hidden.text, /capture \d/u, 'a masked category is not offered')
  gate.reveal(agent, ['native'])
  const partial = state.definition.handler({ agent, rawInput: 'status', attachments: [] })
  assert.match(partial.text, /^REA catalog: partial \(native\) \u2014 2 tools, 2 KB/u)
  assert.match(partial.text, /Available: web 4 KB\n/u)
  assert.match(partial.text, /Use \/rea add <category> or \/rea on all\./u)
  assert.match(partial.text, /alwaysDeny\): capture/u)
  gate.reveal(agent, ['all'])
  const all = state.definition.handler({ agent, rawInput: 'status', attachments: [] })
  assert.match(all.text, /^REA catalog: revealed, all categories \u2014 3 tools/u)
  assert.doesNotMatch(all.text, /Available/u)
})

test('revealing only a denied category says so', () => {
  const { ctx, state } = harness()
  const { gate, agent } = realGate({ alwaysDeny: ['capture'] })
  registerReaCommand(ctx, { gate })
  const result = state.definition.handler({ agent, rawInput: 'add capture', attachments: [] })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /No REA tools were revealed\./u)
  assert.match(result.text, /alwaysDeny\): capture/u)
})
