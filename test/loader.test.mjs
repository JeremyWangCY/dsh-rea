import test from 'node:test'
import assert from 'node:assert/strict'
import { ReaVisibilityGate } from '../lib/gate.js'
import { LOAD_TOOL, loadDescription, registerLoaderTools, UNLOAD_TOOL } from '../lib/loader.js'

const NAMES = ['mcp__rea__n1', 'mcp__rea__n2', 'mcp__rea__a1', 'mcp__rea__w1', 'mcp__rea__c1']
const KINDS = { n1: 'native', n2: 'native', a1: 'android', w1: 'web', c1: 'capture' }

/**
 * A real gate over a minimal registry, plus the fake tool registry the loader
 * registers into. Executions are called directly with an `exec.agent`.
 * @param options - gate options layered over the stub category map.
 * @returns the gate, the captured definitions and a fake-agent factory.
 */
function setup(options = {}) {
  const restrictions = new Map()
  const registered = new Map()
  const disposed = []
  const ctx = {
    tools: {
      schemas: () => NAMES.map((name) => ({ name, description: 'd'.repeat(1024), parameters: {} })),
      restrict: (filter) => { restrictions.set(filter.scope, new Set(filter.deny)); return () => restrictions.delete(filter.scope) },
      register(definition) {
        registered.set(definition.name, definition)
        return () => { registered.delete(definition.name); disposed.push(definition.name) }
      },
    },
  }
  const logger = { warn() {} }
  const gate = new ReaVisibilityGate(ctx, 'rea', logger, undefined, { categoryOf: (name) => KINDS[name] ?? 'other', ...options })
  const agentFor = (id) => {
    const scope = { id }
    return { id, scope, session: { snapshotEvents: () => [] }, ctx: { tools: { restrict: (filter) => ctx.tools.restrict({ ...filter, scope }) } } }
  }
  const dispose = registerLoaderTools(ctx, { gate, ...options })
  const run = (name, args, agent) => registered.get(name).execute(args, { agent })
  return { gate, registered, disposed, dispose, agentFor, restrictions, run }
}

test('the loader registers rea_load and rea_unload, and disposes both', () => {
  const { registered, dispose, disposed } = setup()
  assert.deepEqual([...registered.keys()].sort(), [LOAD_TOOL, UNLOAD_TOOL].sort())
  dispose()
  assert.equal(registered.size, 0)
  assert.deepEqual([...disposed].sort(), [LOAD_TOOL, UNLOAD_TOOL].sort())
})

test('the loader names do not start with the REA prefix, so the gate cannot mask them', () => {
  const { registered, gate } = setup()
  for (const name of registered.keys()) assert.equal(name.startsWith(gate.prefix), false, name)
})

test('the rea_load description stays small and omits other', () => {
  const { registered } = setup()
  const text = registered.get(LOAD_TOOL).description
  assert.ok(text.length <= 1200, 'description is ' + text.length + ' chars')
  assert.match(text, /- native: /u)
  assert.match(text, /cache miss/u)
  assert.doesNotMatch(text, /- other: /u)
  assert.doesNotMatch(text, /\ball\b: /u, 'the all pseudo-id is accepted but not advertised')
})

test('a denied category is left out of the description', () => {
  assert.match(loadDescription([]), /- capture: /u)
  assert.doesNotMatch(loadDescription(['capture']), /- capture: /u)
  assert.ok(loadDescription([]).length <= 1200)
})

test('rea_load reveals for the calling agent only and reports the cost', async () => {
  const { gate, run, agentFor } = setup()
  const a = agentFor('a')
  const b = agentFor('b')
  gate.gate(b)
  const result = await run(LOAD_TOOL, { categories: ['native'] }, a)
  assert.equal(result.state, 'partial')
  assert.deepEqual(result.loaded, ['native'])
  assert.deepEqual(result.added, ['native'])
  assert.equal(result.toolsAdded, 2)
  assert.ok(result.kbAdded > 1.5 && result.kbAdded < 2.5, String(result.kbAdded))
  assert.equal(result.note, 'available from your next step')
  assert.deepEqual(gate.visibility(a), { state: 'partial', categories: ['native'] })
  assert.equal(gate.visibility(b).state, 'hidden')
})

test('rea_load joins what is already loaded', async () => {
  const { gate, run, agentFor } = setup()
  const agent = agentFor('a')
  await run(LOAD_TOOL, { categories: ['native'] }, agent)
  const result = await run(LOAD_TOOL, { categories: ['web'] }, agent)
  assert.deepEqual(result.loaded, ['native', 'web'])
  assert.deepEqual(result.added, ['web'])
  assert.deepEqual(gate.visibility(agent).categories, ['native', 'web'])
})

test('rea_load rejects more than the cap of new categories', async () => {
  const { gate, run, agentFor } = setup()
  const agent = agentFor('a')
  await assert.rejects(run(LOAD_TOOL, { categories: ['native', 'android', 'web', 'apple'] }, agent), /at most 3 new categories/u)
  assert.equal(gate.visibility(agent).state, 'hidden', 'a refused call reveals nothing')
})

test('the cap counts only new categories: two new plus two already loaded is fine', async () => {
  const { gate, run, agentFor } = setup()
  const agent = agentFor('a')
  await run(LOAD_TOOL, { categories: ['native', 'android'] }, agent)
  const result = await run(LOAD_TOOL, { categories: ['native', 'android', 'web', 'apple'] }, agent)
  assert.deepEqual(result.added, ['apple', 'web'])
  assert.equal(gate.visibility(agent).categories.length, 4)
})

test('the cap is configurable and also bounds the all pseudo-id', async () => {
  const { run, agentFor } = setup({ maxPerCall: 1 })
  const agent = agentFor('a')
  await assert.rejects(run(LOAD_TOOL, { categories: ['native', 'web'] }, agent), /at most 1 new categories/u)
  await assert.rejects(run(LOAD_TOOL, { categories: ['all'] }, agent), /at most 1 new categories/u)
  const ok = await run(LOAD_TOOL, { categories: ['web'] }, agent)
  assert.equal(ok.state, 'partial')
})

test('an unknown category is an error naming the known ones', async () => {
  const { run, agentFor, gate } = setup({ alwaysDeny: ['capture'] })
  const agent = agentFor('a')
  await assert.rejects(run(LOAD_TOOL, { categories: ['native', 'bogus'] }, agent), (error) => {
    assert.match(error.message, /Unknown REA category: bogus\./u)
    assert.match(error.message, /Known: native, android/u)
    assert.doesNotMatch(error.message, /capture/u, 'a denied category is not offered')
    return true
  })
  assert.equal(gate.visibility(agent).state, 'hidden')
})

test('an empty request is an error', async () => {
  const { run, agentFor } = setup()
  await assert.rejects(run(LOAD_TOOL, { categories: [] }, agentFor('a')), /at least one category/u)
})

test('a fully revealed agent gets a no-op result', async () => {
  const { gate, run, agentFor } = setup()
  const agent = agentFor('a')
  gate.reveal(agent, ['all'])
  const result = await run(LOAD_TOOL, { categories: ['web'] }, agent)
  assert.equal(result.state, 'all')
  assert.deepEqual(result.added, [])
  assert.equal(result.toolsAdded, 0)
  assert.match(result.note, /already loaded/u)
})

test('loading what is already loaded changes nothing and says so', async () => {
  const { run, agentFor } = setup()
  const agent = agentFor('a')
  await run(LOAD_TOOL, { categories: ['native'] }, agent)
  const again = await run(LOAD_TOOL, { categories: ['native'] }, agent)
  assert.deepEqual(again.added, [])
  assert.match(again.note, /nothing changed/u)
})

test('a denied category is reported, not loaded, and not counted against the cap', async () => {
  const { gate, run, agentFor } = setup({ alwaysDeny: ['capture'], maxPerCall: 1 })
  const agent = agentFor('a')
  const result = await run(LOAD_TOOL, { categories: ['capture', 'native'] }, agent)
  assert.deepEqual(result.denied, ['capture'])
  assert.deepEqual(result.loaded, ['native'])
  assert.equal(gate.visibility(agent).categories.includes('capture'), false)
})

test('a missing calling agent is an error, not a crash', async () => {
  const { run } = setup()
  await assert.rejects(run(LOAD_TOOL, { categories: ['native'] }, undefined), /needs a calling agent/u)
  await assert.rejects(run(UNLOAD_TOOL, {}, undefined), /needs a calling agent/u)
})

test('rea_unload hides the catalog for the calling agent only', async () => {
  const { gate, run, agentFor } = setup()
  const a = agentFor('a')
  const b = agentFor('b')
  await run(LOAD_TOOL, { categories: ['native'] }, a)
  await run(LOAD_TOOL, { categories: ['web'] }, b)
  const result = await run(UNLOAD_TOOL, {}, a)
  assert.deepEqual(result, { state: 'hidden' })
  assert.equal(gate.visibility(a).state, 'hidden')
  assert.equal(gate.visibility(b).state, 'partial')
})

test('the result renders as one JSON text block', async () => {
  const { registered } = setup()
  const blocks = registered.get(LOAD_TOOL).output.render({}, { state: 'partial', loaded: ['native'] })
  assert.deepEqual(blocks, [{ type: 'text', text: '{"state":"partial","loaded":["native"]}' }])
})

test('the registry-facing definition validates its arguments', async () => {
  const { registered } = setup()
  const schema = registered.get(LOAD_TOOL).parameters
  assert.deepEqual(schema.required, ['categories'])
  assert.equal(schema.properties.categories.type, 'array')
})
