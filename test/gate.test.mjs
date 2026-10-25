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
  const state = { names: [...names], restrictions: new Map(), warnings: [], live: new Set() }
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
      // A real registry returns an independent disposer per call: two live
      // restrictions on one scope both exist until both are disposed. Tracking
      // that is what makes a leaked mask observable here.
      const token = {}
      state.live.add(token)
      return () => { state.live.delete(token); state.restrictions.delete(scope) }
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
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger, undefined, { keywordUnlock: true, keywordCategories: ['all'] })
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
  const handle = installGate(h.ctx, { serverName: 'rea', keywordUnlock: true, keywordCategories: ['all'], onUnlock: (agent) => unlocked.push(agent.id) })
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

/** Build one stored /rea command record. */
function reaRun(args) {
  return { type: 'command/run', data: { name: 'rea', args: args, source: { kind: 'user' } } }
}

test('relock hides the catalog again and re-installs the mask', () => {
  const h = harness(['read', 'mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const agent = agentFor(h, 'session-1')
  gate.gate(agent)
  gate.unlock(agent)
  assert.notEqual(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
  assert.equal(gate.relock(agent), true)
  assert.equal(gate.isGated(agent), true)
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
  assert.notEqual(h.ctx.tools.get('read', agent.scope), undefined)
})

test('relock then unlock again leaves exactly one live mask', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const agent = agentFor(h, 'session-1')
  gate.gate(agent)
  for (let round = 0; round < 3; round += 1) {
    gate.unlock(agent)
    gate.relock(agent)
  }
  // Every relock re-installs a mask; none of the previous ones may survive.
  assert.equal(h.state.restrictions.size, 1)
  assert.equal(h.state.live.size, 1)
  assert.equal(gate.maskedCount, 1)
  assert.equal(gate.unlockedCount, 0)
  gate.unlock(agent)
  assert.equal(h.state.restrictions.size, 0)
  assert.equal(h.state.live.size, 0)
})

test('relock on an ungated agent reports gated state without a mask', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const agent = agentFor(h, 'session-1')
  gate.gate(agent)
  assert.equal(gate.unlockedCount, 0)
  assert.equal(gate.relock(agent), true)
  assert.equal(gate.isGated(agent), true)
})

test('relock runs the onRelock hook and contains a throwing hook', () => {
  const h = harness(['mcp__rea__a'])
  const seen = []
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger, undefined, {
    onRelock: (agent) => { seen.push(agent.id); throw new Error('hook exploded') },
  })
  const agent = agentFor(h, 'session-1')
  gate.gate(agent)
  gate.unlock(agent)
  assert.equal(gate.relock(agent), true)
  assert.deepEqual(seen, ['session-1'])
  assert.equal(h.state.warnings.some((text) => text.includes('relock hook failed')), true)
})

test('unlockedCount tracks how many agents have the catalog revealed', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const one = agentFor(h, 'session-1')
  const two = agentFor(h, 'session-2')
  gate.gate(one)
  gate.gate(two)
  assert.equal(gate.unlockedCount, 0)
  gate.unlock(one)
  assert.equal(gate.unlockedCount, 1)
  gate.unlock(two)
  assert.equal(gate.unlockedCount, 2)
  gate.relock(one)
  assert.equal(gate.unlockedCount, 1)
})

test('relock during the install sweep does not read a half-built handle', () => {
  // installGate sweeps live agents synchronously and can unlock one from its
  // history before installGate has returned. The plugin's onRelock hook must not
  // dereference the not-yet-assigned handle in that window; the gate itself must
  // still relock correctly and run the hook.
  const h = harness(['mcp__rea__a'])
  let handle
  const seen = []
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger, undefined, {
    onRelock: (agent) => { seen.push(agent.id); assert.equal(handle, undefined, 'handle is still unset during the sweep') },
  })
  const agent = agentFor(h, 'session-1', [reaRun('')])
  // Mirrors installGate's sweep: gateOrRestore() unlocks from history first.
  gate.gateOrRestore(agent)
  assert.equal(gate.unlockedCount, 1)
  gate.relock(agent)
  assert.deepEqual(seen, ['session-1'])
  handle = { gate }
  assert.equal(gate.unlockedCount, 0)
})

test('/rea status in the history does NOT restore the reveal', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const agent = agentFor(h, 'session-1', [reaRun('status')])
  assert.equal(gate.gateOrRestore(agent), true)
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
})

test('/rea off in the history does NOT restore the reveal', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const agent = agentFor(h, 'session-1', [reaRun('off')])
  assert.equal(gate.gateOrRestore(agent), true)
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
})

test('the last /rea record in the history wins', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  // reveal, hide, then reveal again.
  const revealLast = agentFor(h, 's1', [reaRun(''), reaRun('off'), reaRun('on')])
  assert.equal(gate.gateOrRestore(revealLast), false)
  assert.notEqual(h.ctx.tools.get('mcp__rea__a', revealLast.scope), undefined)
  const hideLast = agentFor(h, 's2', [reaRun(''), reaRun('decompile it'), reaRun('off')])
  assert.equal(gate.gateOrRestore(hideLast), true)
  assert.equal(h.ctx.tools.get('mcp__rea__a', hideLast.scope), undefined)
})

test('a /rea that carried a request still restores the reveal', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const agent = agentFor(h, 'session-1', [reaRun('look at this dll')])
  assert.equal(gate.gateOrRestore(agent), false)
  assert.notEqual(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
})

test('an unreadable history fails closed and keeps the catalog hidden', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger)
  const agent = agentFor(h, 'session-1')
  agent.session.snapshotEvents = () => { throw new Error('history unavailable') }
  assert.equal(gate.gateOrRestore(agent), true)
  assert.equal(h.ctx.tools.get('mcp__rea__a', agent.scope), undefined)
  assert.equal(h.state.warnings.some((text) => text.includes('keeping the catalog hidden')), true)
})

test('a history that only ever ran /rea status stays hidden but keyword hits still count', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger, undefined, { keywordUnlock: true, keywordCategories: ['all'] })
  const keyword = agentFor(h, 's2', [reaRun('status'), { type: 'user/message', data: message('decompile this dll') }])
  assert.equal(gate.gateOrRestore(keyword), false)
})
test('an async unlock hook that rejects is contained, never an unhandled rejection', async () => {
  const h = harness(['mcp__rea__a'])
  const unhandled = []
  const onUnhandled = (error) => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger, async () => {
      throw new Error('cannot get property "skills" without inject')
    })
    const agent = agentFor(h, 'session-1')
    gate.gate(agent)
    assert.equal(gate.unlock(agent), true)
    // The host aborts on an unhandled rejection, so the guard must settle it.
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(unhandled, [])
    assert.equal(h.state.warnings.length, 1)
    assert.match(h.state.warnings[0], /unlock hook failed/u)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('a synchronous unlock hook failure is logged and does not abort the unlock', () => {
  const h = harness(['mcp__rea__a'])
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger, () => {
    throw new Error('boom')
  })
  const agent = agentFor(h, 'session-1')
  gate.gate(agent)
  assert.equal(gate.unlock(agent), true)
  assert.equal(h.state.warnings.length, 1)
  assert.match(h.state.warnings[0], /unlock hook failed/u)
})

// ---------------------------------------------------------------------------
// Category-scoped reveal
// ---------------------------------------------------------------------------

/** Names spread over four categories; the stub keeps these tests off the real rule map. */
const SPREAD = ['mcp__rea__n1', 'mcp__rea__n2', 'mcp__rea__a1', 'mcp__rea__w1', 'mcp__rea__c1']
const STUB_CATEGORY = { n1: 'native', n2: 'native', a1: 'android', w1: 'web', c1: 'capture' }
const stubCategoryOf = (name) => STUB_CATEGORY[name] ?? 'other'

/**
 * Build a gate over the spread names with the stub category map.
 * @param extra - constructor options layered over the stub.
 * @param names - registered global tool names.
 * @returns the harness, gate and a log of hook calls.
 */
function spreadGate(extra = {}, names = SPREAD) {
  const h = harness(names)
  const hooks = []
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger, (agent) => hooks.push('unlock:' + agent.id), {
    onRelock: (agent) => hooks.push('relock:' + agent.id),
    categoryOf: stubCategoryOf,
    ...extra,
  })
  return { h, gate, hooks }
}

/** The names currently denied to one agent, sorted. */
function denied(h, agent) {
  return [...(h.state.restrictions.get(agent.scope) ?? [])].sort()
}

/** One stored tool/call event the way DSH records it (arguments is a JSON string). */
function toolCall(callId, name, args) {
  return { type: 'tool/call', data: { callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }
}

/** One stored tool/result event. */
function toolResult(callId, isError = false) {
  return { type: 'tool/result', data: { message: { toolCallId: callId, isError } } }
}

test('reveal hidden -> partial denies exactly the other categories and fires onUnlock once', () => {
  const { h, gate, hooks } = spreadGate()
  const agent = agentFor(h, 's1')
  const result = gate.reveal(agent, ['native'])
  assert.deepEqual(denied(h, agent), ['mcp__rea__a1', 'mcp__rea__c1', 'mcp__rea__w1'])
  assert.deepEqual(result, { state: 'partial', categories: ['native'], added: ['native'], denied: [] })
  assert.deepEqual(hooks, ['unlock:s1'])
  assert.equal(gate.isGated(agent), true)
  assert.equal(gate.unlockedCount, 1)
  assert.equal(gate.partialCount, 1)
  assert.notEqual(h.ctx.tools.get('mcp__rea__n1', agent.scope), undefined)
  assert.equal(h.ctx.tools.get('mcp__rea__w1', agent.scope), undefined)
})

test('reveal on top of a partial view rebuilds one mask and does not fire onUnlock again', () => {
  const { h, gate, hooks } = spreadGate()
  const agent = agentFor(h, 's1')
  gate.reveal(agent, ['native'])
  const result = gate.reveal(agent, ['web', 'native'])
  assert.deepEqual(denied(h, agent), ['mcp__rea__a1', 'mcp__rea__c1'])
  assert.equal(h.state.live.size, 1, 'the superseded mask is released')
  assert.deepEqual(result.added, ['web'])
  assert.deepEqual(result.categories, ['native', 'web'])
  assert.deepEqual(hooks, ['unlock:s1'])
})

test('revealing categories that are already visible is a no-op', () => {
  const { h, gate } = spreadGate()
  const agent = agentFor(h, 's1')
  gate.reveal(agent, ['native', 'web'])
  const before = h.state.restrictions.get(agent.scope)
  const result = gate.reveal(agent, ['native'])
  assert.deepEqual(result.added, [])
  assert.equal(h.state.restrictions.get(agent.scope), before, 'the mask object is untouched')
  assert.equal(h.state.live.size, 1)
})

test('reveal(all) installs no mask and counts as fully revealed', () => {
  const { h, gate, hooks } = spreadGate()
  const agent = agentFor(h, 's1')
  const result = gate.reveal(agent, ['all'])
  assert.equal(h.state.restrictions.has(agent.scope), false)
  assert.equal(h.state.live.size, 0)
  assert.equal(result.state, 'all')
  assert.equal(gate.isGated(agent), false)
  assert.deepEqual(hooks, ['unlock:s1'])
  assert.equal(gate.partialCount, 0)
  assert.equal(gate.unlockedCount, 1)
})

test('partial -> all drops the mask without a second onUnlock', () => {
  const { h, gate, hooks } = spreadGate()
  const agent = agentFor(h, 's1')
  gate.reveal(agent, ['native'])
  gate.reveal(agent, ['all'])
  assert.equal(h.state.live.size, 0)
  assert.deepEqual(hooks, ['unlock:s1'])
  assert.equal(gate.unlockedCount, 1)
  assert.equal(gate.partialCount, 0)
})

test('unlock() on a partial agent is a full reveal', () => {
  const { h, gate, hooks } = spreadGate()
  const agent = agentFor(h, 's1')
  gate.reveal(agent, ['native'])
  assert.equal(gate.unlock(agent), true)
  assert.equal(h.state.live.size, 0)
  assert.equal(gate.visibility(agent).state, 'all')
  assert.deepEqual(hooks, ['unlock:s1'])
})

test('setCategories replaces the set and an empty set relocks', () => {
  const { h, gate, hooks } = spreadGate()
  const agent = agentFor(h, 's1')
  gate.reveal(agent, ['native', 'web'])
  const replaced = gate.setCategories(agent, ['android'])
  assert.deepEqual(replaced.categories, ['android'])
  assert.deepEqual(denied(h, agent), ['mcp__rea__c1', 'mcp__rea__n1', 'mcp__rea__n2', 'mcp__rea__w1'])
  assert.equal(h.state.live.size, 1)
  const emptied = gate.setCategories(agent, [])
  assert.equal(emptied.state, 'hidden')
  assert.equal(denied(h, agent).length, SPREAD.length)
  assert.deepEqual(hooks, ['unlock:s1', 'relock:s1'])
  assert.equal(gate.unlockedCount, 0)
})

test('relock from a partial view restores the full mask, fires onRelock and uncounts the agent', () => {
  const { h, gate, hooks } = spreadGate()
  const agent = agentFor(h, 's1')
  gate.reveal(agent, ['native'])
  assert.equal(gate.relock(agent), true)
  assert.equal(denied(h, agent).length, SPREAD.length)
  assert.equal(h.state.live.size, 1)
  assert.deepEqual(hooks, ['unlock:s1', 'relock:s1'])
  assert.equal(gate.unlockedCount, 0)
  assert.equal(gate.partialCount, 0)
  assert.equal(gate.visibility(agent).state, 'hidden')
  // A second relock of a hidden agent is not a transition.
  gate.relock(agent)
  assert.deepEqual(hooks, ['unlock:s1', 'relock:s1'])
})

test('alwaysDeny is never revealed and is reported', () => {
  const { h, gate } = spreadGate({ alwaysDeny: ['capture'] })
  const agent = agentFor(h, 's1')
  const result = gate.reveal(agent, ['capture', 'native'])
  assert.deepEqual(result.denied, ['capture'])
  assert.deepEqual(result.categories, ['native'])
  assert.equal(h.ctx.tools.get('mcp__rea__c1', agent.scope), undefined)
  // Asking only for the denied category leaves the agent hidden.
  const other = agentFor(h, 's2')
  const none = gate.reveal(other, ['capture'])
  assert.equal(none.state, 'hidden')
  assert.deepEqual(none.denied, ['capture'])
  assert.equal(gate.unlockedCount, 1)
})

test('a fully revealed agent still has alwaysDeny masked, across generations', () => {
  const { h, gate } = spreadGate({ alwaysDeny: ['capture'] })
  const agent = agentFor(h, 's1')
  const result = gate.reveal(agent, ['all'])
  assert.equal(result.state, 'all')
  assert.deepEqual(result.denied, ['capture'])
  assert.deepEqual(denied(h, agent), ['mcp__rea__c1'])
  assert.equal(gate.visibility(agent).categories.includes('capture'), false)
  // The bridge swaps generations: the capture tool is renamed.
  h.state.names = ['mcp__rea__n1', 'mcp__rea__c2']
  STUB_CATEGORY.c2 = 'capture'
  try {
    assert.equal(gate.resync(), 1)
    assert.deepEqual(denied(h, agent), ['mcp__rea__c2'])
  } finally {
    delete STUB_CATEGORY.c2
  }
})

test('a new generation recomputes a partial agent against the new names', () => {
  const { h, gate } = spreadGate()
  const agent = agentFor(h, 's1')
  gate.reveal(agent, ['native'])
  STUB_CATEGORY.n3 = 'native'
  STUB_CATEGORY.w2 = 'web'
  try {
    h.state.names = ['mcp__rea__n3', 'mcp__rea__w2', 'mcp__rea__a1']
    assert.equal(gate.resync(), 1)
    assert.deepEqual(denied(h, agent), ['mcp__rea__a1', 'mcp__rea__w2'])
    assert.equal(h.state.live.size, 1)
  } finally {
    delete STUB_CATEGORY.n3
    delete STUB_CATEGORY.w2
  }
})

test('revealing for one agent leaves a concurrent hidden agent fully masked', () => {
  const { h, gate } = spreadGate()
  const a = agentFor(h, 'a')
  const b = agentFor(h, 'b')
  gate.gate(b)
  gate.reveal(a, ['native'])
  assert.equal(denied(h, b).length, SPREAD.length)
  assert.equal(gate.visibility(b).state, 'hidden')
  assert.equal(gate.visibility(a).state, 'partial')
  assert.equal(gate.unlockedCount, 1)
})

test('revealing for an agent the gate has not seen gates it first', () => {
  const { h, gate } = spreadGate()
  const agent = agentFor(h, 'fresh')
  assert.equal(gate.isGated(agent), false)
  gate.reveal(agent, ['web'])
  assert.equal(gate.isGated(agent), true)
  assert.equal(h.state.live.size, 1)
})

test('forget removes a partial agent from every table', () => {
  const { h, gate } = spreadGate()
  const agent = agentFor(h, 's1')
  gate.reveal(agent, ['native'])
  gate.forget(agent)
  assert.equal(gate.partialCount, 0)
  assert.equal(gate.unlockedCount, 0)
  assert.equal(gate.gatedCount, 0)
  assert.equal(gate.visibility(agent).state, 'hidden')
})

test('visibility reports hidden, partial and all', () => {
  const { h, gate } = spreadGate({ alwaysDeny: ['capture'] })
  const agent = agentFor(h, 's1')
  assert.deepEqual(gate.visibility(agent), { state: 'hidden', categories: [] })
  gate.gate(agent)
  assert.deepEqual(gate.visibility(agent), { state: 'hidden', categories: [] })
  gate.reveal(agent, ['web', 'native'])
  assert.deepEqual(gate.visibility(agent), { state: 'partial', categories: ['native', 'web'] })
  gate.reveal(agent, ['all'])
  const full = gate.visibility(agent)
  assert.equal(full.state, 'all')
  assert.equal(full.categories.includes('native') && full.categories.includes('other'), true)
  assert.equal(full.categories.includes('capture'), false)
})

test('categoryBytes totals the live catalog per category in the measured projection', () => {
  const h = harness([])
  h.ctx.tools.schemas = () => [
    { name: 'mcp__rea__n1', description: 'one', parameters: { type: 'object' } },
    { name: 'mcp__rea__n2', description: 'two', parameters: { type: 'object' } },
    { name: 'mcp__rea__w1', description: 'web', parameters: {} },
    { name: 'read' },
  ]
  const gate = new ReaVisibilityGate(h.ctx, 'rea', h.ctx.logger, undefined, { categoryOf: stubCategoryOf })
  const sizes = gate.categoryBytes()
  assert.deepEqual([...sizes.keys()], ['native', 'web'])
  const native = Buffer.byteLength(JSON.stringify({ name: 'mcp__rea__n1', description: 'one', parameters: { type: 'object' } }))
    + Buffer.byteLength(JSON.stringify({ name: 'mcp__rea__n2', description: 'two', parameters: { type: 'object' } }))
  assert.deepEqual(sizes.get('native'), { tools: 2, bytes: native })
  assert.equal(sizes.get('web').tools, 1)
})

test('a keyword unlock reveals keywordCategories only', () => {
  const h = harness(SPREAD)
  const handle = installGate(h.ctx, { serverName: 'rea', keywordUnlock: true, keywordCategories: ['native'], categoryOf: stubCategoryOf })
  const agent = agentFor(h, 's1')
  h.ctx.emit('agent/created', { agent })
  h.ctx.emit('agent/inbox/inserted', { agent, message: message('decompile this dll') })
  assert.deepEqual(handle.gate.visibility(agent), { state: 'partial', categories: ['native'] })
  assert.equal(h.ctx.tools.get('mcp__rea__w1', agent.scope), undefined)
  handle.dispose()
})

// --- Replay (historyState) -------------------------------------------------

/** Replay one history through a fresh gate. */
function replay(history, options = {}) {
  const { h, gate } = spreadGate(options)
  return gate.historyState(agentFor(h, 's1', history))
}

test('replay: /rea and /rea on reveal defaultCategories, /rea <request> too', () => {
  for (const args of ['', ' on', ' look at this binary', ' on this binary']) {
    assert.deepEqual(replay([reaRun(args)], { defaultCategories: ['native'] }), { state: 'partial', categories: ['native'] }, JSON.stringify(args))
  }
  assert.equal(replay([reaRun('')]).state, 'all', 'the default default is every category')
})

test('replay: /rea on <cats> replaces, /rea add <cats> joins', () => {
  assert.deepEqual(replay([reaRun(' on native,android')]), { state: 'partial', categories: ['native', 'android'] })
  assert.deepEqual(replay([reaRun(' on native'), reaRun(' on web')]), { state: 'partial', categories: ['web'] })
  assert.deepEqual(replay([reaRun(' on native'), reaRun(' add web android')]), { state: 'partial', categories: ['native', 'android', 'web'] })
  assert.equal(replay([reaRun(' on all')]).state, 'all')
})

test('replay: off hides and status is ignored', () => {
  assert.equal(replay([reaRun(' on native'), reaRun(' off')]).state, 'hidden')
  assert.deepEqual(replay([reaRun(' on native'), reaRun(' status')]), { state: 'partial', categories: ['native'] })
  assert.equal(replay([reaRun(' status')]).state, 'hidden')
})

test('replay: order decides - on native, add web, off, add android leaves android', () => {
  const history = [reaRun(' on native'), reaRun(' add web'), reaRun(' off'), reaRun(' add android')]
  assert.deepEqual(replay(history), { state: 'partial', categories: ['android'] })
})

test('replay: a list with an unknown category was refused live, so it is skipped', () => {
  assert.deepEqual(replay([reaRun(' on native'), reaRun(' add web,bogus')]), { state: 'partial', categories: ['native'] })
})

test('replay: a successful rea_load joins its categories', () => {
  const history = [reaRun(' on native'), toolCall('c1', 'rea_load', { categories: ['web'] }), toolResult('c1')]
  assert.deepEqual(replay(history), { state: 'partial', categories: ['native', 'web'] })
})

test('replay: a failed rea_load and a call with no result are ignored', () => {
  const history = [
    toolCall('c1', 'rea_load', { categories: ['web'] }), toolResult('c1', true),
    toolCall('c2', 'rea_load', { categories: ['android'] }),
  ]
  assert.equal(replay(history).state, 'hidden')
})

test('replay: a result is paired by call id, not by position', () => {
  const history = [
    toolCall('a', 'rea_load', { categories: ['web'] }),
    toolCall('b', 'rea_load', { categories: ['android'] }),
    toolResult('b'),
  ]
  assert.deepEqual(replay(history), { state: 'partial', categories: ['android'] })
})

test('replay: malformed rea_load arguments are ignored with a warning', () => {
  const { h, gate } = spreadGate()
  const history = [reaRun(' on native'), toolCall('c1', 'rea_load', '{not json'), toolResult('c1')]
  assert.deepEqual(gate.historyState(agentFor(h, 's1', history)), { state: 'partial', categories: ['native'] })
  assert.equal(h.state.warnings.some((text) => text.includes('unreadable arguments')), true)
})

test('replay: a successful rea_unload hides, and a later load starts over', () => {
  const history = [
    reaRun(' on native'),
    toolCall('u', 'rea_unload', '{}'), toolResult('u'),
    toolCall('l', 'rea_load', { categories: ['web'] }), toolResult('l'),
  ]
  assert.deepEqual(replay(history), { state: 'partial', categories: ['web'] })
  assert.equal(replay([reaRun(' on native'), toolCall('u', 'rea_unload', '{}'), toolResult('u')]).state, 'hidden')
})

test('replay: other tools and other commands are not REA state', () => {
  const history = [
    toolCall('x', 'read', { categories: ['web'] }), toolResult('x'),
    { type: 'command/run', data: { name: 'goal', args: ' on native', source: { kind: 'user' } } },
  ]
  assert.equal(replay(history).state, 'hidden')
})

test('replay: a keyword message reveals keywordCategories only when keyword unlock is on', () => {
  const history = [{ type: 'user/message', data: message('decompile this dll') }]
  assert.deepEqual(replay(history, { keywordUnlock: true, keywordCategories: ['web'] }), { state: 'partial', categories: ['web'] })
  assert.equal(replay(history, { keywordCategories: ['web'] }).state, 'hidden')
})

test('replay: alwaysDeny categories are dropped from the replayed view', () => {
  assert.deepEqual(replay([reaRun(' on native,capture')], { alwaysDeny: ['capture'] }), { state: 'partial', categories: ['native'] })
  assert.equal(replay([reaRun(' on capture')], { alwaysDeny: ['capture'] }).state, 'hidden')
})

test('replay: unreadable history is hidden', () => {
  const { h, gate } = spreadGate()
  const agent = agentFor(h, 's1')
  agent.session.snapshotEvents = () => { throw new Error('boom') }
  assert.deepEqual(gate.historyState(agent), { state: 'hidden', categories: [] })
})

test('historyUnlocks stays a thin wrapper over historyState', () => {
  const { h, gate } = spreadGate()
  assert.equal(gate.historyUnlocks(agentFor(h, 'a', [reaRun(' on native')])), true)
  assert.equal(gate.historyUnlocks(agentFor(h, 'b', [reaRun(' off')])), false)
})

test('gateOrRestore restores a partial view with one mask and one onUnlock', () => {
  const { h, gate, hooks } = spreadGate()
  const agent = agentFor(h, 's1', [reaRun(' on native'), reaRun(' add web')])
  assert.equal(gate.gateOrRestore(agent), true)
  assert.deepEqual(denied(h, agent), ['mcp__rea__a1', 'mcp__rea__c1'])
  assert.equal(h.state.live.size, 1)
  assert.deepEqual(hooks, ['unlock:s1'])
  assert.equal(gate.partialCount, 1)
})

test('gateOrRestore of a full-reveal history under alwaysDeny keeps that category masked', () => {
  const { h, gate } = spreadGate({ alwaysDeny: ['capture'] })
  const agent = agentFor(h, 's1', [reaRun(' on all')])
  assert.equal(gate.gateOrRestore(agent), false)
  assert.deepEqual(denied(h, agent), ['mcp__rea__c1'])
  assert.equal(gate.visibility(agent).state, 'all')
})

test('a mask swap leaks nothing when the registry emits tools/change on restrict and dispose', () => {
  // The real registry emits 'tools/change' synchronously from restrict() and
  // from its disposer. Releasing the old mask used to run OUTSIDE the
  // re-entrancy guard, so that event re-masked the agent from inside the
  // release, and the outer call then installed a second mask on top of it: the
  // first was leaked, still denying categories the agent had since revealed.
  const h = harness(SPREAD)
  const restrict = h.ctx.tools.restrict
  h.ctx.tools.restrict = (filter) => {
    const dispose = restrict(filter)
    h.ctx.emit('tools/change')
    return () => { dispose(); h.ctx.emit('tools/change') }
  }
  const handle = installGate(h.ctx, { serverName: 'rea', categoryOf: stubCategoryOf })
  const agent = agentFor(h, 's1')
  handle.gate.gate(agent)
  handle.gate.reveal(agent, ['native'])
  assert.equal(h.state.live.size, 1)
  handle.gate.reveal(agent, ['web'])
  assert.equal(h.state.live.size, 1, 'the superseded mask is released, not shadowed')
  assert.deepEqual(denied(h, agent), ['mcp__rea__a1', 'mcp__rea__c1'])
  handle.gate.reveal(agent, ['all'])
  assert.equal(h.state.live.size, 0)
  handle.gate.relock(agent)
  assert.equal(h.state.live.size, 1)
  handle.dispose()
})

/** One stored PTC sub-dispatch record: run_code settles a nested tool call as tool/ptc-dispatch. */
function ptcDispatch(name, args, isError = false) {
  return { type: 'tool/ptc-dispatch', data: { rootCallId: 'root', parentCallId: 'root', subCallId: 'root:ptc:0', name, arguments: args, isError, content: [] } }
}

test('replay: a rea_load made through run_code (PTC) is replayed', () => {
  const history = [reaRun(' on native'), ptcDispatch('rea_load', { categories: ['web'] })]
  assert.deepEqual(replay(history), { state: 'partial', categories: ['native', 'web'] })
  // The logged arguments may also be the JSON text.
  assert.deepEqual(replay([ptcDispatch('rea_load', '{"categories":["android"]}')]), { state: 'partial', categories: ['android'] })
})

test('replay: a PTC rea_unload hides, and a failed PTC call is ignored', () => {
  assert.equal(replay([reaRun(' on native'), ptcDispatch('rea_unload', {})]).state, 'hidden')
  assert.deepEqual(replay([reaRun(' on native'), ptcDispatch('rea_load', { categories: ['web'] }, true)]), { state: 'partial', categories: ['native'] })
  assert.deepEqual(replay([reaRun(' on native'), ptcDispatch('read', { categories: ['web'] })]), { state: 'partial', categories: ['native'] })
})

test('replay: /rea list changes nothing, like status', () => {
  assert.deepEqual(replay([reaRun(' on native'), reaRun(' list')]), { state: 'partial', categories: ['native'] })
  assert.equal(replay([reaRun(' list')]).state, 'hidden')
})
