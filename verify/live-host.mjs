// Mint the browser-session cookie for the RUNNING Host from its own stored
// signing secret, then exercise the live prompt endpoint exactly as the
// browser bundle does. Read-only against the Host; it never mutates config.
import { readFile } from 'node:fs/promises'
import { createHash, createHmac } from 'node:crypto'

const PORT = 19387
const AUTHORITY = `127.0.0.1:${PORT}`
const credentials = await readFile('C:\\Users\\Laptop\\.dsh\\.credentials.yaml', 'utf8')
const stored = /client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/.exec(credentials)?.[1]
if (!stored) throw new Error('browser-session secret not found')
// The record stores base64url text; BrowserAuth decodes it (canonicalSecret)
// and signs with the RAW bytes, so the HMAC key is the decoded buffer.
const secret = Buffer.from(stored.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
if (secret.byteLength !== 32) throw new Error(`unexpected secret length ${secret.byteLength}`)

const base64url = value => Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const cookieName = `dsh-auth-${base64url(createHash('sha256').update(AUTHORITY).digest())}`
const now = Date.now()
const body = base64url(Buffer.from(JSON.stringify({ version: 1, authority: AUTHORITY, issuedAt: now, expiresAt: now + 86400000 }), 'utf8'))
const value = `v1.${body}.${base64url(createHmac('sha256', secret).update(body).digest())}`
const cookie = `${cookieName}=${value}`

const call = async (method, payload = {}, extraHeaders = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}/dsh-rea-prompts/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, ...extraHeaders },
    body: JSON.stringify({ type: 'client-request', rpcId: `live-${method}`, method, payload }),
  })
  const text = await response.text()
  return { status: response.status, text, json: (() => { try { return JSON.parse(text) } catch { return undefined } })() }
}

const checks = []
const pass = (name, details) => { checks.push({ name, pass: true, details }); console.log('PASS', name, details ? JSON.stringify(details) : '') }
const fail = (name, details) => { checks.push({ name, pass: false, details }); console.log('FAIL', name, details) }

try {
  const anonymous = await fetch(`http://127.0.0.1:${PORT}/dsh-rea-prompts/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  if (anonymous.status === 401) pass('live Host: unauthenticated request is 401')
  else fail('live Host: unauthenticated request is 401', `got ${anonymous.status}`)

  const listed = await call('list')
  if (listed.status === 200 && listed.json?.result?.ok) {
    const prompts = listed.json.result.value.prompts
    pass('live Host: prompts/list over the real socket', { serverName: listed.json.result.value.serverName, count: prompts.length, names: prompts.map(p => p.name) })
    const required = Object.fromEntries((prompts.find(p => p.name === 'investigate_feature')?.arguments ?? []).filter(a => a.required).map(a => [a.name, 'login']))
    const rendered = await call('get', { name: 'investigate_feature', arguments: required })
    const text = rendered.json?.result?.value?.messages?.[0]?.content?.text ?? ''
    if (rendered.json?.result?.ok && text.includes('# Investigate a feature')) pass('live Host: prompts/get renders the original template', { bytes: text.length })
    else fail('live Host: prompts/get renders the original template', JSON.stringify(rendered).slice(0, 300))
    const completed = await call('complete', { name: 'investigate_feature', argument: 'provider_id', value: '', arguments: {} })
    if (completed.json?.result?.ok) pass('live Host: completion/complete answered', { values: completed.json.result.value.completion?.values })
    else fail('live Host: completion/complete answered', JSON.stringify(completed).slice(0, 300))
  } else {
    fail('live Host: prompts/list over the real socket', `${listed.status} ${listed.text.slice(0, 300)}`)
  }

  const unknown = await call('nope')
  if (unknown.status === 404) pass('live Host: unknown endpoint is 404')
  else fail('live Host: unknown endpoint is 404', `got ${unknown.status}`)
} catch (error) {
  fail('live-probe', String(error?.message ?? error))
}
console.log('REPORT', JSON.stringify({ failed: checks.filter(c => !c.pass).length, checks }))
