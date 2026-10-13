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

/**
 * Register the read-only prompt endpoint on the Host's own HTTP server.
 *
 * Deliberately NOT `ctx.connection.rpc.handle(...)`: that method registers its
 * route through the Connection service's own Context (`owner.webServer`), which
 * a third-party plugin cannot provide, so it throws during activation. The
 * shared `/api` interceptor is unavailable too — the Typert gateway already
 * owns it and the registry rejects a second one. A plain webServer route plus
 * the Connection trust fence is the public equivalent.
 *
 * @param webServer - Host HTTP carrier.
 * @param connection - optional Connection service, used only for its public request fence.
 * @param access - prompt facade over the shared REA client.
 * @param serverName - advertised server name.
 * @returns route disposer.
 */
export function registerPromptRoute(webServer, connection, access, serverName) {
  const BASE = '/dsh-rea-prompts'
  const METHODS = ['list', 'get', 'complete']
  const MAX_BODY_BYTES = 1024 * 1024
  const send = (res, status, body, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'cache-control': 'no-store', 'content-type': type })
    res.end(body)
  }
  const envelope = (res, rpcId, result) => {
    send(res, 200, JSON.stringify({ type: 'server-response', rpcId, result }), 'application/json')
  }
  const failure = (res, rpcId, code, message) => envelope(res, rpcId, { ok: false, error: { code, message, details: {} } })
  return webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: async (req, res) => {
      // Same fence the Connection applies to its own channels: Host/Origin
      // policy first, then the browser session. A plugin-owned route must not
      // be looser than the transport it replaces.
      const rejection = connection?.requestRejection?.(req)
      if (rejection !== undefined) return send(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
      if (req.method !== 'POST') return send(res, 405, 'method not allowed')
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      if (contentType !== 'application/json') return send(res, 415, 'content type must be application/json')
      let body = ''
      for await (const chunk of req) {
        body += chunk
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) return send(res, 413, 'request body too large')
      }
      let message
      try { message = JSON.parse(body) } catch { return send(res, 400, 'body is not JSON') }
      const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
      if (message?.type !== 'client-request' || typeof message?.rpcId !== 'string' || typeof message?.method !== 'string') {
        return failure(res, rpcId, 'gateway/bad-request', 'invalid client-request message')
      }
      const endpoint = new URL(req.url ?? '/', 'http://dsh.invalid').pathname.slice(BASE.length).replace(/^\//, '')
      if (endpoint === '' || !METHODS.includes(endpoint)) return send(res, 404, 'not found')
      if (message.method !== endpoint) {
        return failure(res, message.rpcId, 'gateway/bad-request', `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`)
      }
      // Cancelling the browser request cancels the upstream MCP call; no answer
      // from an abandoned request can be replayed.
      const abort = new AbortController()
      res.on('close', () => abort.abort())
      try {
        const value = await access[endpoint](...(endpoint === 'list' ? [abort.signal] : [message.payload, abort.signal]))
        envelope(res, message.rpcId, { ok: true, value: endpoint === 'list' ? { ...value, serverName } : value })
      } catch (error) {
        failure(res, message.rpcId, 'rea-prompt-error', String(error?.message ?? error))
      }
    },
  })
}
