/**
 * Full upstream REA, using DSH's maintained MCP bridge.
 *
 * The catalog is lazy by default (see ./gate.js): every upstream tool schema
 * stays out of every request until a real user message asks for reverse
 * engineering or the user runs `/rea`, which is where their per-request cost
 * comes from.
 *
 * Nothing here hardcodes the upstream version or the size of its catalog. Both
 * are read from the installed `rea-agents` dependency at runtime, because a
 * literal "6.4.0"/"170" is exactly what went stale the last time REA shipped a
 * release: the plugin must describe whatever version it is actually running.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
import * as mcp from './vendor/mcp-bridge.js'
import { createPromptAccess, registerPromptRoute } from './prompts.js'
import { installGate } from './gate.js'
import { registerReaCommand } from './command.js'
import yaml from 'js-yaml'
import semver from 'semver'

const require = createRequire(import.meta.url)
export const name = 'dsh-rea'
export const inject = ['tools', 'skills']
/** `commands` is optional: a headless profile may compose no command adapter. */
const OPTIONAL_COMMANDS = ['commands']
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  serverName: Schema.string().default('rea'),
  // Compatibility check: previous versions silently hid 161 tools.
  tools: Schema.const('all').default('all'),
  nodeCommand: Schema.string().default(''),
  env: Schema.dict(Schema.string()).default({}),
  toolCallTimeoutMs: Schema.number().min(1).default(300000),
  failOnStartupError: Schema.boolean().default(true),
  // 'lazy' keeps the catalog out of every request until a user message asks for
  // reverse engineering; 'always' restores the unconditional v0.3 behavior.
  exposure: Schema.union(['lazy', 'always']).default('lazy'),
  // Whether a user message may also reveal the catalog by mentioning reverse
  // engineering. Off by default: talking about the gate names its own trigger
  // words, so inference is wrong exactly where it is most expensive.
  keywordUnlock: Schema.boolean().default(false),
})

export function upstreamPaths() {
  const root = dirname(require.resolve('rea-agents/package.json'))
  return {
    root,
    launcher: join(root, 'scripts', 'rea.mjs'),
    skillDir: join(root, 'skills', 'reverse-engineer-anything'),
  }
}

/**
 * The exact upstream REA version this plugin is running.
 *
 * Read from the installed dependency rather than a literal so log lines, error
 * messages and test assertions cannot drift from the package actually bridged.
 * @returns the upstream `rea-agents` version.
 */
export function upstreamVersion() {
  return JSON.parse(require('fs').readFileSync(join(upstreamPaths().root, 'package.json'), 'utf8')).version
}

export function launcherConfig(config) {
  const paths = upstreamPaths()
  const electron = !!process.versions.electron
  if (!config.nodeCommand && !semver.satisfies(process.versions.node, '^22.19.0 || ^24.11.0 || >=26.0.0')) {
    throw new Error(`REA ${upstreamVersion()} does not support Node ${process.versions.node}; configure nodeCommand with a supported Node executable. No Node installation or upgrade was attempted.`)
  }
  return mcp.Config({
    transport: 'stdio',
    serverName: config.serverName,
    command: config.nodeCommand || process.execPath,
    args: [paths.launcher, 'mcp'],
    env: { ...(!config.nodeCommand && electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ...config.env },
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    failOnStartupError: config.failOnStartupError,
    // REA is a stateful MCP server. Do not silently lose target/ledger state
    // by reconnecting and replaying into a fresh process after a disconnect.
    reconnect: { enabled: false },
  })
}

export async function upstreamSkill() {
  const { skillDir } = upstreamPaths()
  const path = join(skillDir, 'SKILL.md')
  const raw = await readFile(path, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
  if (!match) throw new Error('Invalid upstream REA skill frontmatter')
  const metadata = yaml.load(match[1])
  return {
    name: metadata.name,
    description: metadata.description,
    content: match[2],
    metadata: metadata.metadata,
    source: 'runtime',
    provider: 'dsh-rea',
    path,
    resourceBase: { kind: 'directory', path: skillDir },
  }
}

/**
 * Own the REA skill's registration across the gate's unlock/relock cycle.
 *
 * The skill must be registered once, not once per agent, and must be released
 * again as soon as no agent has the catalog revealed - otherwise a session that
 * ran `/rea` and then `/rea off` keeps paying for the skill line in every
 * request. Registration goes through the plugin context, not the agent's:
 * `agent.ctx` has no `skills` inject on DSH 0.2.1-rc.2, where reading it threw
 * "cannot get property skills without inject" and took the host down on `/rea`.
 *
 * @param skills - the plugin context's skills service.
 * @param skill - the upstream skill description to register.
 * @returns the unlock/relock handlers plus a read-only registration probe.
 */
export function createSkillLifespan(skills, skill) {
  let registered = false
  let dispose
  const release = function () {
    if (dispose === undefined) return false
    try {
      dispose()
    } catch {
      // A throwing disposer must not wedge the gate; the bookkeeping below is
      // what decides whether the next unlock registers again.
    }
    dispose = undefined
    registered = false
    return true
  }
  return {
    /** Register the skill once, if an agent just revealed the catalog. */
    onUnlock() {
      if (registered) return
      registered = true
      const result = skills.register(skill)
      dispose = typeof result === 'function'
        ? result
        : (typeof result?.dispose === 'function' ? () => result.dispose() : undefined)
    },
    /**
     * Release the skill once no agent has the catalog revealed.
     * @param gate - the live gate, read for its unlocked count.
     */
    onRelock(gate) {
      if (gate !== undefined && gate.unlockedCount > 0) return
      release()
    },
    /** Whether the skill is currently registered. */
    get isRegistered() {
      return registered
    },
  }
}

export async function apply(ctx, config) {
  if (!config.enabled) return
  // Same body and references as the installed upstream package. No shortened
  // replacement workflow; no writes to ~/.agents or Codex's configuration.
  const skill = await upstreamSkill()
  const lazy = config.exposure === 'lazy'
  // 'always' registers the skill globally, exactly as v0.3 did. Under 'lazy'
  // it is registered per agent from the gate's unlock hook, so a session that
  // never mentions reverse engineering does not pay for its catalog line either.
  if (!lazy) ctx.skills.register(skill)
  const access = createPromptAccess(config.toolCallTimeoutMs)
  const sharedBridge = {
    name: 'dsh-rea-shared-mcp', inject: mcp.inject,
    async apply(bridgeCtx, bridgeConfig) { await mcp.apply(bridgeCtx, bridgeConfig, access.connected) },
  }
  const bridge = ctx.plugin(sharedBridge, launcherConfig(config))
  await bridge
  // The prompt endpoint is optional and web-only: `ctx.inject` keeps a
  // CLI/headless profile (no webServer) on the full tool catalog instead of
  // failing activation. It rides the Host's own HTTP carrier behind the
  // Connection trust fence; the Connection service's plugin-private `handle()`
  // path cannot be used by a third-party plugin.
  ctx.inject(['webServer'], webCtx => webCtx.effect(
    () => registerPromptRoute(webCtx.webServer, webCtx.get('connection'), access, config.serverName),
    'dsh-rea: prompts route',
  ))
  if (!lazy) {
    ctx.logger.info(`dsh-rea: upstream REA ${upstreamVersion()} full-catalog bridge + original skill + shared-session prompts/completions ready (exposure: always)`)
    return
  }
  // Lazy exposure: the connection above is already live and owns the single REA
  // process, so prompts/completions keep working. Only the model-facing catalog
  // is conditional now. Registering the per-agent skill needs the skills service
  // on this context, which the plugin already injects.
  // Held in a box rather than read through the `gateHandle` binding: installGate
  // already calls gateOrRestore() on live agents before it returns, so a hook
  // that reached for `gateHandle` could run while that binding is still in its
  // temporal dead zone.
  const gateRef = { current: undefined }
  const lifespan = createSkillLifespan(ctx.skills, skill)
  const gateHandle = installGate(ctx, {
    serverName: config.serverName,
    keywordUnlock: config.keywordUnlock,
    onUnlock: () => lifespan.onUnlock(),
    // Drop the global skill again once no agent has REA revealed, so `/rea off`
    // stops costing the skill line too. Reads through gateRef because the sweep
    // above can run this before `gateHandle` is assigned.
    onRelock: () => lifespan.onRelock(gateRef.current),
  })
  gateRef.current = gateHandle.gate
  // The explicit switch. Registered through ctx.inject because a profile may
  // compose no command adapter at all, and its absence is not an activation error.
  ctx.inject(OPTIONAL_COMMANDS, commandCtx => commandCtx.effect(
    () => registerReaCommand(commandCtx, { gate: gateHandle.gate }),
    'dsh-rea: /rea command',
  ))
  ctx.effect(() => () => gateHandle.dispose(), 'dsh-rea: lazy catalog gate')
  // The initial sync above already ran, but a Host can mount this plugin before
  // the bridge's first generation lands; resync once now so masks cover it.
  gateHandle.resync()
  ctx.logger.info(`dsh-rea: upstream REA ${upstreamVersion()} bridge is live; the full tool catalog and skill stay out of requests until \`/rea\` is run (exposure: lazy)`)
}
