import test from 'node:test'
import assert from 'node:assert/strict'
import {
  batchUnlocks,
  installGate,
  isUserPrompt,
  mentionsReverseEngineering,
  messageText,
  ReaVisibilityGate,
} from '../lib/gate.js'

/**
 * Build a user-role message with the source kind under test.
 * @param text - model-facing text.
 * @param kind - message source kind.
 * @returns a message shaped like a dsh-llm UserMessage.
 */
function message(text, kind = 'user') {
  return {
    id: 'm-' + Math.random().toString(36).slice(2),
    role: 'user',
    source: kind === 'user' ? { kind: 'user' } : { kind },
    content: [{ type: 'text', text }],
  }
}

test('keyword gate matches reverse-engineering requests', () => {
  for (const text of [
    '\u5e2e\u6211\u628a\u8fd9\u4e2a exe \u9006\u5411\u4e00\u4e0b',
    'decompile this dll please',
    'can you reverse engineer this electron app',
    'use ghidra on the firmware',
    '\u5206\u6790\u4e00\u4e0b\u8fd9\u4e2a apk \u5728\u5e72\u4ec0\u4e48',
    'unpack this apk',
    '\u770b\u770b\u8fd9\u4e2a .dll \u5e72\u4e86\u4ec0\u4e48',
    'reverse engineering a jar',
    'what does this wasm binary do inside',
  ]) assert.equal(mentionsReverseEngineering(text), true, text)
})

test('keyword gate ignores ordinary software work', () => {
  for (const text of [
    'add a reverse proxy in front of nginx',
    'sort the list in reverse order',
    'build the .exe and ship it',
    'reverse dns lookup helper',
    'refactor the auth module',
    'run the test suite',
    '',
  ]) assert.equal(mentionsReverseEngineering(text), false, text)
})

test('only user-authored prompts can unlock the catalog', () => {
  assert.equal(isUserPrompt(message('decompile it', 'user')), true)
  assert.equal(isUserPrompt(message('decompile it', 'tool')), false)
  assert.equal(isUserPrompt(message('decompile it', 'plugin')), false)
  assert.equal(batchUnlocks([message('decompile it', 'tool')]), false)
  assert.equal(batchUnlocks([message('decompile it', 'plugin')]), false)
  assert.equal(batchUnlocks([message('decompile it', 'user')]), true)
  assert.equal(batchUnlocks([message('just chatting'), message('decompile it')]), true)
  assert.equal(batchUnlocks([]), false)
})

test('messageText reads only text blocks', () => {
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] }), 'a\nb')
  assert.equal(messageText({ content: [] }), '')
  assert.equal(messageText({}), '')
  assert.equal(messageText(undefined), '')
})

test('an unclassifiable message fails open', () => {
  const exploding = {
    role: 'user',
    get source() { return { kind: 'user' } },
    get content() { throw new Error('unreadable') },
  }
  assert.equal(batchUnlocks([exploding]), true)
})

/**
 * Minimal stand-ins for the two services the gate touches.
 * @param names - registered global tool names.
 * @returns ctx, registry bookkeeping, and the per-agent contexts created.
 */
function harness(names) {
  const state = { names: [...names], restrictions: new Map(), warnings: [] }
  const tools = {
    schemas() { return state.names.map((name) => ({ name })) },
    restrict(filter) {
      const scope = filter.scope
      // Mirror the registry: an unknown name is a hard error.
      for (const name of filter.deny ?? []) {
        if (!state.names.includes(name)) throw new Error('tools.restrict() names unknown global tool "' + name + '"')
      }
      if (filter.scope === undefined) throw new Error('tools.restrict() requires a scoped context')
      state.restrictions.set(scope, new Set(filter.deny ?? []))
      return () => state.restrictions.delete(scope)
    },
    get(name, scope) {
      const denied = scope === undefined ? undefined : state.restrictions.get(scope)
      if (denied?.has(name)) return undefined
      return state.names.includes(name) ? { name } : undefined
    },
  }
  const listeners = new Map()
  const ctx = {
    logger: {
      warn(text) { state.warnings.push(text) },
      info() {},
    },
    tools,
    agents: { list() { return [] } },
    on(name, fn) {
      const list = listeners.get(name) ?? []
      list.push(fn)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(name, current.filter((entry) => entry !== fn))
      }
    },
    emit(name, payload) { for (const fn of listeners.get(name) ?? []) fn(payload) },
  }
  return { ctx, state, listeners }
}

/**
 * Build a fake agent whose scope registers real restrictions.
 * @param h - the harness owning the registry.
 * @param id - agent identity.
 * @param history - stored session events for restore tests.
 * @returns the agent stand-in.
 */
function agentFor(h, id, history = []) {
  const scope = { id }
  return {
    id,
    scope,
    session: { snapshotEvents() { return history } },
    ctx: {
      tools: {
        restrict(filter) { return h.ctx.tools.restrict({ ...filter, scope }) },
      },
    },
  }
}

test('gate hides the catalog and unlock reveals it again', () => {
  const h = harness(['read', 'mcp__rea__decompile', 'mcp__rea__xrefs'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger, undefined, { keywordUnlock: true })
  const agent = agentFor(h, 'session-1')
  assert.equal(gate.gate(agent), true)
  assert.equal(h.state.restrictions.get(agent.scope).size, 2)
  assert.equal(h.ctx.tools.get('mcp__rea__decompile', agent.scope), undefined)
  assert.notEqual(h.ctx.tools.get('read', agent.scope), undefined)
  assert.equal(gate.isGated(agent), true)
  assert.equal(gate.unlock(agent), true)
  assert.equal(h.state.restrictions.has(agent.scope), false)
  assert.notEqual(h.ctx.tools.get('mcp__rea__decompile', agent.scope), undefined)
  assert.equal(gate.isGated(agent), false)
})

test('gating is idempotent and does not re-mask an unlocked agent', () => {
  const h = harness(['mcp__rea__decompile'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const agent = agentFor(h, 'session-1')
  assert.equal(gate.gate(agent), true)
  assert.equal(gate.gate(agent), true)
  gate.unlock(agent)
  assert.equal(gate.gate(agent), false) // stays unlocked
  assert.equal(gate.maskedCount, 0)
})

test('resync re-masks against a new tool generation', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const agent = agentFor(h, 'session-1')
  gate.gate(agent)
  // The bridge swaps generations: the old name is gone, a new one appeared.
  h.state.names = ['mcp__rea__b', 'mcp__rea__c']
  assert.equal(gate.resync(), 1)
  const denied = h.state.restrictions.get(agent.scope)
  assert.deepEqual([...denied].sort(), ['mcp__rea__b', 'mcp__rea__c'])
  // An unlocked agent is absent from the gated set, so it keeps its tools.
  gate.unlock(agent)
  assert.equal(gate.resync(), 0)
})

test('an agent gated before the first sync is masked once names arrive', () => {
  const h = harness([])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const agent = agentFor(h, 'session-1')
  assert.equal(gate.gate(agent), false) // nothing to deny yet
  assert.equal(gate.isGated(agent), true) // but still gated
  h.state.names = ['mcp__rea__a']
  assert.equal(gate.resync(), 1)
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
})

test('a restored session that already asked stays unlocked (keyword unlocking on)', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger, undefined, { keywordUnlock: true })
  const history = [{ type: 'user/message', data: message('decompile this dll') }]
  const agent = agentFor(h, 'session-1', history)
  assert.equal(gate.gateOrRestore(agent), false)
  assert.equal(gate.isGated(agent), false)
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope) !== undefined, true)
})

test('a restored session with no request stays gated', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const history = [{ type: 'user/message', data: message('write the release notes') }]
  const agent = agentFor(h, 'session-1', history)
  assert.equal(gate.gateOrRestore(agent), true)
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
})

test('installGate unmasks on a real user prompt when keyword unlocking is on', () => {
  const h = harness(['mcp__rea__a'])
  const unlocked = []
  const handle = installGate(h.ctx, { serverName: 'rea', keywordUnlock: true, onUnlock: (agent) => unlocked.push(agent.id) })
  const agent = agentFor(h, 'session-1')
  h.ctx.emit('agent/created', { agent })
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
  h.ctx.emit('agent/inbox/inserted', { agent, message: message('what does this service do') })
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined, 'non-RE prompt must not unlock')
  h.ctx.emit('agent/inbox/inserted', { agent, message: message('decompile this dll') })
  assert.notEqual(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined, 'unlock is synchronous')
  assert.deepEqual(unlocked, ['session-1'])
  handle.dispose()
})

test('installGate ignores tool results and context injections', () => {
  const h = harness(['mcp__rea__a'])
  const handle = installGate(h.ctx, { serverName: 'rea' })
  const agent = agentFor(h, 'session-1')
  h.ctx.emit('agent/created', { agent })
  h.ctx.emit('agent/inbox/inserted', { agent, message: message('decompile this dll', 'tool') })
  h.ctx.emit('agent/inbox/inserted', { agent, message: message('decompile this dll', 'plugin') })
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
  handle.dispose()
})

test('installGate re-masks on tools/change and forgets disposed agents', () => {
  const h = harness(['mcp__rea__a'])
  const handle = installGate(h.ctx, { serverName: 'rea' })
  const agent = agentFor(h, 'session-1')
  h.ctx.emit('agent/created', { agent })
  h.state.names = ['mcp__rea__a', 'mcp__rea__b']
  h.ctx.emit('tools/change')
  assert.equal(h.state.restrictions.get(agent.scope).size, 2)
  h.ctx.emit('agent/disposed', { agent })
  assert.equal(handle.gate.gatedCount, 0)
  handle.dispose()
})

test('installGate gates agents that already exist', () => {
  const h = harness(['mcp__rea__a'])
  const agent = agentFor(h, 'session-1')
  h.ctx.agents = { list: () => [agent] }
  const handle = installGate(h.ctx, { serverName: 'rea' })
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
  handle.dispose()
})

test('by default a keyword does NOT unlock: /rea is the switch', () => {
  const h = harness(['mcp__rea__a'])
  const handle = installGate(h.ctx, { serverName: 'rea' })
  const agent = agentFor(h, 'session-1')
  h.ctx.emit('agent/created', { agent })
  h.ctx.emit('agent/inbox/inserted', { agent, message: message('decompile this dll') })
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
  assert.equal(handle.gate.isGated(agent), true)
  handle.dispose()
})

test('discussing the gate does not reveal the catalog', () => {
  // The exact sentence that revealed it during development.
  const h = harness(['mcp__rea__a'])
  const handle = installGate(h.ctx, { serverName: 'rea' })
  const agent = agentFor(h, 'session-1')
  h.ctx.emit('agent/created', { agent })
  h.ctx.emit('agent/inbox/inserted', { agent, message: message('\u4f60\u80fd\u4e0d\u80fd\u628a dsh-rea \u7684\u52a0\u8f7d\u6539\u6210\u5fc5\u987b\u7528\u6237\u8bf4\u5230\u9006\u5411\u518d\u5f00\u7684\u63d2\u4ef6') })
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
  handle.dispose()
})

test('a stored /rea command restores the reveal on reload', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const history = [{ type: 'command/run', data: { name: 'rea', args: '', source: { kind: 'user' } } }]
  const agent = agentFor(h, 'session-1', history)
  assert.equal(gate.gateOrRestore(agent), false)
  assert.notEqual(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
})

test('a stored command with a different name does not restore the reveal', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const history = [{ type: 'command/run', data: { name: 'goal', args: 'build it', source: { kind: 'user' } } }]
  const agent = agentFor(h, 'session-1', history)
  assert.equal(gate.gateOrRestore(agent), true)
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
})
