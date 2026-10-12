/**
 * dsh-rea — REA reverse-engineering tools for the DeepSeek Harness.
 *
 * This plugin is a filtering MCP bridge. It speaks MCP to REA's stdio server
 * (the `rea-agents` npm package) and registers a CURATED subset of that
 * server's tools on `ctx.tools`, under the `rea__` namespace.
 *
 * Why not just use `@deepseek-ai/dsh-mcp-client`? That bridge registers every
 * tool a server advertises. REA advertises ~170 tools worth ~1.9 MB of JSON
 * Schema (≈540k tokens), and tool schemas are attached to every model request —
 * so a plain bridge entry would spend more than half a large context window
 * before the conversation even starts. This plugin keeps the highest-value
 * entry points and leaves the long tail to the REA CLI.
 *
 * @module
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_TOOLS, TIERS, USAGE_NOTE } from './catalog.js'

/** Model-facing namespace; keeps REA tools visually distinct from host tools. */
const NAMESPACE = 'rea'

/**
 * Plugin configuration.
 */
export const Config = Schema.object({
  /**
   * Whether the REA MCP server is started and its tools registered. Set
   * `false` to keep the plugin installed but inert in a given profile.
   */
  enabled: Schema.boolean().default(true),

  /**
   * Exact `rea-agents` npm version to run. Pinning one exact version keeps tool
   * schemas and tool names stable across restarts, matching REA's own advice for
   * persistent MCP registrations.
   */
  version: Schema.string().default('6.4.0'),

  /**
   * npm runner used to launch REA. `npx` avoids a global install and works on
   * every platform REA supports.
   */
  runner: Schema.string().default('npx'),

  /**
   * Extra environment for the REA child process, merged over the inherited env.
   * Set `REA_MCP_INPUT_SCHEMA_PROFILE: 'compact'` to shrink tool schemas
   * somewhat, at the cost of per-parameter descriptions.
   */
  env: Schema.dict(Schema.string()).default({}),

  /**
   * Which REA tools to expose.
   *
   * Accepts tier names (`'entry'`, `'navigate'`, `'analyze'`, or `'all'`), an
   * explicit array of REA tool names, or `null` for REA's entire catalog.
   *
   * The default is the `entry` tier only: enough to identify a target and learn
   * what it is, at roughly 27k tokens of tool schema. Deeper tiers are opt-in
   * because REA's full 170-tool catalog is ~540k tokens per request. The REA CLI
   * (`npx rea-agents@latest ...`) always exposes the complete catalog without
   * spending any model context.
   */
  tools: Schema.union([
    Schema.array(Schema.string()),
    Schema.string(),
  ]).default('entry'),

  /**
   * Per-call timeout in milliseconds. REA's native analysis can run long, so
   * this defaults well above the first-party bridge's 60s.
   */
  toolCallTimeoutMs: Schema.number().default(300_000),

  /**
   * Reject plugin activation when REA fails to start. Leave `false` so a missing
   * runtime or a slow first npx download degrades to "no REA tools" instead of
   * failing the whole harness boot.
   */
  failOnStartupError: Schema.boolean().default(false),
}).description('dsh-rea: REA reverse-engineering tools over a curated MCP bridge')

/**
 * Services this plugin needs. `ctx.tools` is the tool registry; `ctx.logger` is
 * used for the startup and registration diagnostics.
 */
export const inject = ['tools', 'logger']

/**
 * Concatenate an MCP content array's text parts into one model-facing string.
 * Mirrors the first-party bridge so REA output renders identically to any other
 * MCP server.
 */
function extractText(content) {
  if (!Array.isArray(content)) return '(no output)'
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
  return text.length > 0 ? text : '(no textual output)'
}

/**
 * Build the plugin's Cordis entry function.
 *
 * @param ctx - the plugin context carrying `tools` and `logger`.
 * @param config - the validated plugin config.
 */
export function apply(ctx, config) {
  if (!config.enabled) {
    ctx.logger.info('dsh-rea: disabled by config; no REA tools registered')
    return
  }

  const disposers = new Map()
  let client = null

  /** Build the child argv for the pinned REA version. */
  const args = ['-y', `rea-agents@${config.version}`, 'mcp']
  const commandLabel = `${config.runner} ${args.join(' ')}`

  /**
   * Resolve the allow-list into a concrete set of REA tool names.
   *
   * `'all'` and `null` mean "bridge everything REA advertises" (expensive).
   * Tier names and explicit arrays are filtered against what REA actually
   * advertises, so a pinned-version rename degrades to a warning, not a crash.
   */
  const resolveAllowed = (advertised) => {
    const advertisedSet = new Set(advertised)
    const selector = config.tools
    if (selector === null || selector === 'all') return advertisedSet

    const requested =
      typeof selector === 'string'
        ? selector === 'all'
          ? advertised
          : (TIERS[selector] ?? [])
        : selector

    const unknown = requested.filter((name) => !advertisedSet.has(name))
    if (unknown.length > 0) {
      ctx.logger.warn(
        `dsh-rea: ${unknown.length} configured tool(s) not advertised by REA ` +
          `${config.version} and will be skipped: ${unknown.slice(0, 5).join(', ')}`,
      )
    }
    return new Set(requested.filter((name) => advertisedSet.has(name)))
  }

  /** Register one curated tool from its MCP description. */
  const registerTool = (tool) => {
    const publicName = `${NAMESPACE}__${tool.name}`
    const definition = {
      name: publicName,
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      output: {
        schema: {
          type: 'object',
          properties: { content: { type: 'array', items: {} } },
          required: ['content'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [{ type: 'text', text: extractText(value?.content) }]
        },
      },
      timeoutMs: config.toolCallTimeoutMs,
      async execute(args, exec) {
        // `callTool` owns result validation; a tool-advertised outputSchema is
        // validated by the SDK, and REA's Evidence content arrives as-is.
        const result = await client.callTool(
          { name: tool.name, arguments: args ?? {} },
          undefined,
          { signal: exec?.signal, timeout: config.toolCallTimeoutMs },
        )
        if (result?.isError === true) throw new Error(extractText(result.content))
        return { content: Array.isArray(result?.content) ? result.content : [] }
      },
    }
    disposers.set(publicName, ctx.tools.register(definition))
  }

  /** Discover REA's catalog and register the curated subset. */
  const syncTools = async () => {
    const { tools } = await client.listTools()
    const allowed = resolveAllowed(tools.map((tool) => tool.name))
    const selected = tools.filter((tool) => allowed.has(tool.name))

    for (const dispose of disposers.values()) dispose()
    disposers.clear()
    for (const tool of selected) registerTool(tool)

    const schemaKb = Math.round(JSON.stringify(selected).length / 1000)
    const share = tools.length > 0 ? Math.round((selected.length / tools.length) * 100) : 0
    ctx.logger.info(
      `dsh-rea: registered ${selected.length}/${tools.length} REA tools ` +
        `(${share}%, ~${schemaKb}k schema bytes)`,
    )
  }
  const connect = async () => {
    const transport = new StdioClientTransport({
      command: config.runner,
      args,
      env: { ...process.env, ...config.env },
    })
    client = new Client({ name: `dsh-rea (${NAMESPACE})`, version: '0.1.0' }, { capabilities: {} })
    await client.connect(transport)
    await syncTools()
    ctx.logger.info(`dsh-rea: REA workflow guidance registered —\n${USAGE_NOTE}`)
  }

  connect().catch((error) => {
    const message = `dsh-rea: could not start REA via "${commandLabel}": ${String(error)}`
    if (config.failOnStartupError) throw new Error(message)
    ctx.logger.error(`${message} — continuing without REA tools`)
  })

  ctx.on('dispose', () => {
    for (const dispose of disposers.values()) dispose()
    disposers.clear()
    void client?.close().catch(() => {})
    client = null
  })
}

export { DEFAULT_TOOLS, TIERS, USAGE_NOTE }
