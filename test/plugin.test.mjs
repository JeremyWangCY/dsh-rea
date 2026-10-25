import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import * as plugin from '../lib/index.js'
import { ReaVisibilityGate } from '../lib/gate.js'
import { renderVendoredBridge } from '../verify/vendor-bridge.mjs'

/**
 * Concatenate the upstream compiled runtime so a prompt name can be looked up
 * wherever the bundler happened to place it.
 * @returns every shipped dist file joined.
 */
async function readAllDist() {
  const root = join(plugin.upstreamPaths().root, 'dist')
  const files = await readdir(root, { recursive: true })
  const parts = []
  for (const rel of files) {
    if (!rel.endsWith('.js')) continue
    parts.push(await readFile(join(root, rel), 'utf8'))
  }
  return parts.join('\n')
}

test('default config preserves all tools and reports startup failure', () => {
 const config=plugin.Config({})
 assert.equal(config.tools,'all')
 assert.equal(config.failOnStartupError,true)
 assert.equal(config.nodeCommand,'')
 assert.deepEqual(config.env,{})
 assert.throws(()=>plugin.Config({tools:'entry'}))
})
test('launcher uses exact dependency without network package runner', async () => {
 const paths=plugin.upstreamPaths()
 const pkg=JSON.parse(await readFile(join(paths.root,'package.json'),'utf8'))
 assert.equal(pkg.version,plugin.upstreamVersion())
 assert.match(pkg.version,/^\d+\.\d+\.\d+$/)
 const config=plugin.launcherConfig(plugin.Config({nodeCommand:process.execPath,env:{REA_TEST_VALUE:'explicit'}}))
 assert.equal(config.command,process.execPath)
 assert.deepEqual(config.args,[paths.launcher,'mcp'])
 assert.equal(config.env.REA_TEST_VALUE,'explicit')
 assert.equal(config.reconnect.enabled,false)
})
test('original skill body and all upstream references are preserved', async () => {
 const skill=await plugin.upstreamSkill()
 const raw=await readFile(skill.path,'utf8')
 const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
 const metadata=yaml.load(match[1])
 assert.equal(skill.content,match[2])
 assert.equal(skill.name,metadata.name)
 assert.deepEqual(skill.metadata,metadata.metadata)
 assert.equal(skill.resourceBase.path,plugin.upstreamPaths().skillDir)
 const refs=await readdir(join(skill.resourceBase.path,'references'))
 assert.equal(refs.filter(n=>n.endsWith('.md')).length,7)
})
test('bundle patch inserts plugin with valid id/name', async () => {
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))
 const patch=yaml.load(await readFile(new URL(`../${pkg.dsh.bundle.patch}`,import.meta.url),'utf8'))
 assert.equal(patch[0].insert[0].name,pkg.name)
 assert.equal(patch[0].insert[0].id,'dsh-rea')
})
test('vendored bridge is exactly upstream plus the documented shared-client hook', async () => {
  const { code, upstreamSha256, patches } = await renderVendoredBridge()
  assert.equal(patches, 6)
  assert.match(upstreamSha256, /^[a-f0-9]{64}$/)
  assert.equal(await readFile(new URL('../lib/vendor/mcp-bridge.js', import.meta.url), 'utf8'), code)
  // The notice and the only semantic edit are both present.
  assert.match(code, /Copyright \(c\) 2026 DeepSeek/)
  assert.equal(code.split('onClient?.(generation)').length - 1, 1)
})

test('localized prompt titles key the real upstream prompt names', async () => {
  // The '/' menu labels each prompt with titles[name] ?? title ?? name, so a key
  // that does not match `prompts/list` degrades to raw English with no error.
  // Upstream renamed this one to `compare_application_versions`; pin the keys to
  // the names the installed package actually serves.
  const client=await readFile(new URL('../lib/client.js', import.meta.url),'utf8')
  const literal=/const titles = \{([^}]*)\}/.exec(client)
  assert.ok(literal,'client.js no longer declares a titles map')
  const keys=[...literal[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(m=>m[1])
  assert.equal(keys.length,6)
  assert.ok(keys.includes('compare_application_versions'))
  assert.ok(!keys.includes('compare_versions'))
  const source=await readAllDist()
  for(const key of keys) assert.ok(source.includes(key),`upstream does not serve prompt ${key}`)
})

test('disabled plugin never mounts a server or skill', async () => {
 await plugin.apply({skills:{register(){throw Error('unexpected registration')}},plugin(){throw Error('unexpected launch')}},plugin.Config({enabled:false}))
})

/** Skills service double that records registrations and disposals. */
function skillsDouble() {
  const state = { registered: 0, disposed: 0, skill: undefined }
  return {
    state,
    register(skill) { state.registered += 1; state.skill = skill; return () => { state.disposed += 1 } },
  }
}

test('the skill registers once no matter how many agents unlock', () => {
  const skills = skillsDouble()
  const lifespan = plugin.createSkillLifespan(skills, { name: 'reverse-engineer-anything' })
  lifespan.onUnlock()
  lifespan.onUnlock()
  lifespan.onUnlock()
  assert.equal(skills.state.registered, 1)
  assert.equal(lifespan.isRegistered, true)
  assert.equal(skills.state.skill.name, 'reverse-engineer-anything')
})

test('the skill is released when the last agent relocks', () => {
  const skills = skillsDouble()
  const lifespan = plugin.createSkillLifespan(skills, { name: 'x' })
  lifespan.onUnlock()
  // One agent still has the catalog revealed: the skill must stay.
  lifespan.onRelock({ unlockedCount: 1 })
  assert.equal(skills.state.disposed, 0)
  assert.equal(lifespan.isRegistered, true)
  lifespan.onRelock({ unlockedCount: 0 })
  assert.equal(skills.state.disposed, 1)
  assert.equal(lifespan.isRegistered, false)
})

test('a relock with no gate yet still releases the skill', () => {
  // installGate can run the hook before the handle is assigned, so the hook must
  // treat an absent gate as "no agent revealed" rather than throwing.
  const skills = skillsDouble()
  const lifespan = plugin.createSkillLifespan(skills, { name: 'x' })
  lifespan.onUnlock()
  lifespan.onRelock(undefined)
  assert.equal(skills.state.disposed, 1)
})

test('unlock after a release registers the skill again', () => {
  const skills = skillsDouble()
  const lifespan = plugin.createSkillLifespan(skills, { name: 'x' })
  lifespan.onUnlock()
  lifespan.onRelock({ unlockedCount: 0 })
  lifespan.onUnlock()
  assert.equal(skills.state.registered, 2)
  assert.equal(lifespan.isRegistered, true)
})

test('a throwing disposer does not wedge the skill lifespan', () => {
  const skills = {
    register() { return () => { throw new Error('skills registry gone') } },
  }
  const lifespan = plugin.createSkillLifespan(skills, { name: 'x' })
  lifespan.onUnlock()
  lifespan.onRelock({ unlockedCount: 0 })
  assert.equal(lifespan.isRegistered, false)
  // Re-registering must still work after the failed release.
  lifespan.onUnlock()
  assert.equal(lifespan.isRegistered, true)
})

test('a skill service returning a disposer object is handled', () => {
  let disposed = 0
  const lifespan = plugin.createSkillLifespan({ register: () => ({ dispose() { disposed += 1 } }) }, { name: 'x' })
  lifespan.onUnlock()
  lifespan.onRelock({ unlockedCount: 0 })
  assert.equal(disposed, 1)
  assert.equal(lifespan.isRegistered, false)
})

test('category config defaults keep upstream behavior', () => {
  const config = plugin.Config({})
  assert.deepEqual(config.defaultCategories, ['all'])
  assert.deepEqual(config.keywordCategories, ['native'])
  assert.equal(config.modelLoader, true)
  assert.equal(config.loaderMaxPerCall, 3)
  assert.deepEqual(config.alwaysDeny, [])
  assert.throws(() => plugin.Config({ loaderMaxPerCall: 0 }))
})

/** A plugin context just rich enough for apply() under lazy exposure. */
function applyCtx() {
  const state = { tools: [], logs: [], plugins: 0, skills: 0 }
  const ctx = {
    skills: { register() { state.skills += 1; return () => {} } },
    logger: { info(text) { state.logs.push(text) }, warn() {} },
    tools: {
      schemas: () => [],
      register(definition) { state.tools.push(definition.name); return () => {} },
      restrict: () => () => {},
    },
    agents: { list: () => [] },
    on: () => () => {},
    plugin() { state.plugins += 1; return Promise.resolve() },
    inject() {},
    effect(fn) { return fn() },
  }
  return { ctx, state }
}

test('an unknown category in any list stops activation, naming the field, before any side effect', async () => {
  for (const field of ['defaultCategories', 'keywordCategories', 'alwaysDeny']) {
    const { ctx, state } = applyCtx()
    await assert.rejects(
      plugin.apply(ctx, plugin.Config({ [field]: ['native', 'nativ'] })),
      (error) => error.message.includes(field) && error.message.includes('"nativ"') && error.message.includes('Known: native'),
      field,
    )
    assert.equal(state.plugins, 0, field + ': nothing was mounted')
  }
})

test('defaultCategories must not be empty and alwaysDeny must not hide everything', async () => {
  const { ctx } = applyCtx()
  await assert.rejects(plugin.apply(ctx, plugin.Config({ defaultCategories: [] })), /defaultCategories must name at least one/u)
  await assert.rejects(plugin.apply(ctx, plugin.Config({ alwaysDeny: ['all'] })), /alwaysDeny cannot contain "all"/u)
  // Case does not hide a bad id from validation.
  await assert.rejects(plugin.apply(ctx, plugin.Config({ defaultCategories: ['Native', 'FOO'] })), /defaultCategories/u)
  await plugin.apply(applyCtx().ctx, plugin.Config({ defaultCategories: ['Native'], keywordCategories: [], alwaysDeny: ['capture'] }))
})

test('lazy exposure registers the loader tools and names the default categories', async () => {
  const { ctx, state } = applyCtx()
  await plugin.apply(ctx, plugin.Config({ defaultCategories: ['native', 'android'] }))
  assert.deepEqual(state.tools.sort(), ['rea_load', 'rea_unload'])
  assert.ok(state.logs.some((line) => line.includes('reveals native, android')), state.logs.join('\n'))
})

test('modelLoader false and exposure always register no loader tools', async () => {
  const off = applyCtx()
  await plugin.apply(off.ctx, plugin.Config({ modelLoader: false }))
  assert.deepEqual(off.state.tools, [])
  const always = applyCtx()
  await plugin.apply(always.ctx, plugin.Config({ exposure: 'always' }))
  assert.deepEqual(always.state.tools, [])
})

test('the skill follows partial reveals: registered on the first, released after the last relock', () => {
  const skills = skillsDouble()
  const lifespan = plugin.createSkillLifespan(skills, { name: 'x' })
  const registry = new Map()
  const ctx = {
    tools: {
      schemas: () => [{ name: 'mcp__rea__n1' }, { name: 'mcp__rea__w1' }],
      restrict: (filter) => { const token = {}; registry.set(token, filter); return () => registry.delete(token) },
    },
  }
  const holder = {}
  const gate = new ReaVisibilityGate(ctx, 'rea', { warn() {} }, () => lifespan.onUnlock(), {
    onRelock: () => lifespan.onRelock(holder.gate),
    categoryOf: (name) => (name === 'n1' ? 'native' : 'web'),
  })
  holder.gate = gate
  const agent = (id) => ({ id, ctx: { tools: { restrict: (filter) => ctx.tools.restrict(filter) } }, session: { snapshotEvents: () => [] } })
  const one = agent('one')
  const two = agent('two')
  gate.reveal(one, ['native'])
  gate.reveal(two, ['web'])
  assert.equal(skills.state.registered, 1, 'registered once for two partial agents')
  gate.reveal(one, ['all'])
  assert.equal(skills.state.registered, 1, 'partial -> all is not a new unlock')
  gate.relock(one)
  assert.equal(lifespan.isRegistered, true, 'the other agent still sees REA tools')
  gate.setCategories(two, [])
  assert.equal(skills.state.disposed, 1)
  assert.equal(lifespan.isRegistered, false)
})
