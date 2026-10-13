/** Thin protocol facade: no prompt rewriting, cached suggestions or analysis calls. */
export function createPromptAccess(timeout = 300000) {
  let client
  let generation = 0
  const connected = next => { client = next; generation++ }
  const active = () => {
    if (!client) throw Error('REA connection unavailable; reload plugin to reconnect. No request was replayed.')
    return client
  }
  const opts = signal => ({ timeout, signal })
  return {
    connected,
    async list(signal) {
      const current = active(), revision = generation
      const prompts = [], cursors = new Set()
      let cursor
      do {
        const page = await current.listPrompts(cursor ? { cursor } : {}, opts(signal))
        prompts.push(...page.prompts)
        cursor = page.nextCursor
        if (cursor && cursors.has(cursor)) throw Error('Repeated MCP prompts cursor')
        if (cursor) cursors.add(cursor)
      } while (cursor)
      if (revision !== generation) throw Error('REA session changed while listing prompts')
      return { prompts, generation: revision }
    },
    async get(params, signal) {
      const current = active(), revision = generation
      if (!params || typeof params.name !== 'string') throw Error('Prompt name required')
      const arguments_ = params.arguments ?? {}
      if (!arguments_ || Array.isArray(arguments_) || typeof arguments_ !== 'object' || Object.values(arguments_).some(x => typeof x !== 'string')) throw Error('Prompt arguments must be strings')
      const result = await current.getPrompt({ name: params.name, arguments: arguments_ }, opts(signal))
      if (revision !== generation) throw Error('REA session changed while rendering prompt')
      return result
    },
    async complete(params, signal) {
      if (!params || typeof params.name !== 'string' || typeof params.argument !== 'string' || typeof params.value !== 'string') throw Error('Completion name/argument/value required')
      return active().complete({ ref: { type: 'ref/prompt', name: params.name }, argument: { name: params.argument, value: params.value }, context: { arguments: params.arguments ?? {} } }, opts(signal))
    },
  }
}

/** Authenticated Connection channel; only original read-only prompt operations. */
export function registerPromptRpc(connection, access, serverName) {
  // Newer DSH builds require an explicit channel trust policy in a third
  // argument and reject an omitted one; the installed 2-argument form ignores
  // the extra value, so one call site serves both. Loopback-only is the least
  // privilege this local prompt reader needs.
  const options = { authority: 'loopback' }
  return connection.rpc.handle('/dsh-rea-prompts', async (method, payload, signal) => {
    try {
      if (!['list', 'get', 'complete'].includes(method)) throw Error('Unknown REA prompt operation')
      const value = await access[method](...(method === 'list' ? [signal] : [payload, signal]))
      return { ok: true, value: method === 'list' ? { ...value, serverName } : value }
    } catch (error) {
      return { ok: false, error: { code: 'rea-prompt-error', message: String(error?.message ?? error), details: {} } }
    }
  }, options)
}
