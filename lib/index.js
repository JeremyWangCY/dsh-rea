/** Full upstream REA, using DSH's maintained MCP bridge (no tool filtering). */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import Schema from '@deepseek-ai/schemastery'
import * as mcp from '@deepseek-ai/dsh-mcp-client'
import yaml from 'js-yaml'
import semver from 'semver'

const require = createRequire(import.meta.url)
export const name = 'dsh-rea'
export const inject = ['tools', 'skills']
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  serverName: Schema.string().default('rea'),
  // Compatibility check: previous versions silently hid 161 tools.
  tools: Schema.const('all').default('all'),
  nodeCommand: Schema.string().default(''),
  env: Schema.dict(Schema.string()).default({}),
  toolCallTimeoutMs: Schema.number().min(1).default(300000),
  failOnStartupError: Schema.boolean().default(true),
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
  ctx.skills.register(await upstreamSkill())
  const bridge = ctx.plugin(mcp, launcherConfig(config))
  await bridge
  ctx.logger.info('dsh-rea: upstream REA 6.4.0 mounted through the official full-catalog MCP bridge; original skill registered')
}
