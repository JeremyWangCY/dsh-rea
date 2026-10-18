/**
 * Full upstream REA, using DSH's maintained MCP bridge.
 *
 * The catalog is lazy by default (see ./gate.js): the 170 upstream tool schemas
 * stay out of every request until a real user message asks for reverse
 * engineering or the user runs `/rea`, which is where their ~437 KB per-request
 * cost comes from.
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

export function launcherConfig(config) {
  const paths = upstreamPaths()
  const electron = !!process.versions.electron
  if (!config.nodeCommand && !semver.satisfies(process.versions.node, '^22.19.0 || ^24.11.0 || >=26.0.0')) {
    throw new Error(`REA 6.4.0 does not support Node ${process.versions.node}; configure nodeCommand with a supported Node executable. No Node installation or upgrade was attempted.`)
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
    ctx.logger.info('dsh-rea: upstream REA 6.4.0 full-catalog bridge + original skill + shared-session prompts/completions ready (exposure: always)')
    return
  }
  // Lazy exposure: the connection above is already live and owns the single REA
  // process, so prompts/completions keep working. Only the model-facing catalog
  // is conditional now. Registering the per-agent skill needs the skills service
  // on this context, which the plugin already injects.
  const gateHandle = installGate(ctx, {
    serverName: config.serverName,
    keywordUnlock: config.keywordUnlock,
    async onUnlock(agent) {
      // Per-agent skill registration: agent.ctx outranks the global layer, so
      // it appears in that agent's catalog only and unwinds with the agent.
      agent.ctx.skills.register(skill)
    },
  })
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
  ctx.logger.info('dsh-rea: upstream REA 6.4.0 bridge is live; the 170-tool catalog and skill stay out of requests until `/rea` is run (exposure: lazy)')
}
