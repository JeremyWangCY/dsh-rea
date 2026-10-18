// Real-registry verification of lazy catalog exposure.
//
// Boots the ACTUAL dsh-system-prompt / dsh-tools / dsh-skill services, mounts
// this plugin's gate against a synthetic `mcp__rea__` generation, and measures
// what a plain agent's prompt assembly carries. No REA process is started: the
// subject under test is the registry and the prompt view, not the upstream
// server.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// Resolve against the installed DSH Host when DSH_REA_TEST_MODULE_ROOT is set,
// so the measurement exercises the exact services this deployment runs.
const hostRequire = createRequire(process.env.DSH_REA_TEST_MODULE_ROOT
  ? pathToFileURL(process.env.DSH_REA_TEST_MODULE_ROOT.replaceAll('\\', '/').replace(/\/$/u, '') + '/noop.js')
  : import.meta.url)
const load = async (name) => import(pathToFileURL(hostRequire.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await load('@deepseek-ai/dsh-tools')
const { default: Skills } = await load('@deepseek-ai/dsh-skill')
const { default: Commands } = await load('@deepseek-ai/dsh-commands')
const { createScope } = await load('@deepseek-ai/dsh-scope')
const { installGate } = await import('../lib/gate.js')
const { COMMAND_NAME, registerReaCommand } = await import('../lib/command.js')

const report = { checks: [], measurements: {} }
const pass = (name, details) => { report.checks.push({ name, pass: true, details }); console.log('PASS', name, details === undefined ? '' : JSON.stringify(details)) }

/**
 * Register a synthetic REA-sized generation through the real registry.
 * @param ctx - host context.
 * @param count - number of tools to register.
 * @param generation - generation tag, so a re-sync is observable.
 * @returns the disposer map for that generation.
 */
async function registerGeneration(ctx, count, generation) {
  const disposers = new Map()
  for (let index = 0; index < count; index += 1) {
    const name = 'mcp__rea__tool_' + index
    disposers.set(name, ctx.tools.register({
      name,
      description: 'Synthetic REA tool ' + index + ' (' + generation + ') with a realistically verbose description that would ride along with every request.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', description: 'Analysis target reference, session-scoped and retained across calls.' },
          provider: { type: 'string', description: 'Selected analysis provider id for this operation.' },
          view: { type: 'object', description: 'Requested projection of the retained evidence bundle.' },
        },
      },
      output: { schema: { type: 'object', properties: { content: { type: 'array', items: {} } }, required: ['content'], additionalProperties: false }, render: () => [{ type: 'text', text: 'ok' }] },
      async execute() { return { content: [] } },
    }))
  }
  return disposers
}

/**
 * The REA schema names one agent's assembly carries.
 * @param ctx - host context.
 * @param agent - scope key the assembly is for.
 * @returns the visible REA schema names.
 */
async function reaToolsFor(ctx, agent) {
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent })
  return assembly.tools.filter((tool) => tool.name.startsWith('mcp__rea__')).map((tool) => tool.name)
}

const ctx = new Context()
await ctx.plugin(SystemPrompt, {})
await ctx.plugin(Skills, {})
await ctx.plugin(Tools, {})
await ctx.plugin(Commands, {})

const generation = await registerGeneration(ctx, 12, 'gen-1')
pass('synthetic REA generation registered through the real registry', { tools: generation.size })

// A command execution logs command/run + command/done on the live session, so
// the stand-in session must accept appends the way a real one does.
const fakeSession = () => ({ snapshotEvents: () => [], append: () => 0 })
const plain = { id: 'session-plain', session: fakeSession(), followup: () => {} }
const rea = { id: 'session-rea', session: fakeSession(), followup: () => {} }
const agentScopes = new Map()
// A real agent scope is minted by the loop plugin, whose context injects the
// services the loop uses; a scope minted from an uninjected fiber cannot even
// read `tools`. Mirror that composition here.
const agentHost = {
  name: 'lazy-exposure-agent-host',
  inject: ['tools', 'skills', 'systemPrompt'],
  apply(hostCtx) {
    for (const agent of [plain, rea]) {
      const scope = createScope(hostCtx, agent)
      agentScopes.set(agent, scope)
      agent.ctx = scope.ctx
    }
  },
}
await ctx.plugin(agentHost)
await ctx.plugin(agentHost)
assert.ok(plain.ctx !== undefined && rea.ctx !== undefined)

const unlocked = []
const handle = installGate(ctx, { serverName: 'rea', onUnlock: (agent) => unlocked.push(agent) })
registerReaCommand(ctx, { gate: handle.gate })
handle.gate.gateOrRestore(plain)
handle.gate.gateOrRestore(rea)

const globalTools = (await ctx.systemPrompt.assemble()).tools.filter((tool) => tool.name.startsWith('mcp__rea__'))
report.measurements.globalSchemaBytes = Buffer.byteLength(JSON.stringify(globalTools))
assert.equal(globalTools.length, 12)
pass('the bridge generation stays registered globally (prompts/completions unaffected)', { tools: globalTools.length, schemaBytes: report.measurements.globalSchemaBytes })

assert.deepEqual(await reaToolsFor(ctx, plain), [])
assert.deepEqual(await reaToolsFor(ctx, rea), [])
report.measurements.gatedSchemaBytes = Buffer.byteLength(JSON.stringify((await ctx.systemPrompt.assemble({ agent: plain, scope: plain })).tools))
pass('before any reverse-engineering prompt, a gated agent carries zero REA schemas', report.measurements)

// Drive the real command service: /rea must be discoverable and must reveal.
const descriptor = ctx.commands.list(rea).find((entry) => entry.name === COMMAND_NAME)
assert.ok(descriptor, '/rea is not registered')
pass('the /rea command is registered and discoverable by the real command service', { description: descriptor.description })
const executed = await ctx.commands.execute(rea, '/rea', [], new AbortController().signal)
assert.equal(executed.result.kind, 'success', JSON.stringify(executed.result))
assert.equal(handle.gate.isGated(rea), false)
assert.equal((await reaToolsFor(ctx, rea)).length, 12)
assert.deepEqual(await reaToolsFor(ctx, plain), [])
report.measurements.unlockedSchemaBytes = Buffer.byteLength(JSON.stringify((await ctx.systemPrompt.assemble({ agent: rea, scope: rea })).tools))
assert.ok(report.measurements.unlockedSchemaBytes > report.measurements.gatedSchemaBytes)
assert.deepEqual(unlocked, [rea])
pass('the requesting agent gains all 12 schemas; a concurrent session stays gated', {
  unlockedSchemaBytes: report.measurements.unlockedSchemaBytes,
  siblingSchemaBytes: report.measurements.gatedSchemaBytes,
})

// The registry view feeds dispatch, so proving the view is what proves the call
// path; the full execute pipeline needs a composed agent loop and is covered by
// the plugin's own unit tests instead.
assert.equal(ctx.tools.get('mcp__rea__tool_0', plain), undefined)
assert.notEqual(ctx.tools.get('mcp__rea__tool_0', rea), undefined)
pass('scope lookup mirrors the assembly: gated agent resolves no REA tool, unlocked agent does')
// A re-sync swaps the generation; gated agents must follow it.
for (const dispose of generation.values()) dispose()
const next = await registerGeneration(ctx, 12, 'gen-2')
handle.resync()
assert.deepEqual(await reaToolsFor(ctx, plain), [])
assert.equal((await reaToolsFor(ctx, rea)).length, 12)
pass('a re-sync re-masks gated agents and leaves unlocked agents alone')

handle.dispose()
for (const dispose of next.values()) dispose()
for (const scope of agentScopes.values()) await scope.dispose()

console.log('REPORT', JSON.stringify(report))
