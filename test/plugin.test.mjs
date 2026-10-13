import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import * as plugin from '../lib/index.js'
import { renderVendoredBridge } from '../verify/vendor-bridge.mjs'

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
 assert.equal(pkg.version,'6.4.0')
 const config=plugin.launcherConfig(plugin.Config({nodeCommand:process.execPath,env:{REA_TEST_VALUE:'explicit'}}))
 assert.equal(config.command,process.execPath)
 assert.deepEqual(config.args,[paths.launcher,'mcp'])
 assert.equal(config.env.REA_TEST_VALUE,'explicit')
 assert.equal(config.reconnect.enabled,false)
})
test('original skill body and all six references are preserved', async () => {
 const skill=await plugin.upstreamSkill()
 const raw=await readFile(skill.path,'utf8')
 const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw)
 const metadata=yaml.load(match[1])
 assert.equal(skill.content,match[2])
 assert.equal(skill.name,metadata.name)
 assert.deepEqual(skill.metadata,metadata.metadata)
 assert.equal(skill.resourceBase.path,plugin.upstreamPaths().skillDir)
 const refs=await readdir(join(skill.resourceBase.path,'references'))
 assert.equal(refs.filter(n=>n.endsWith('.md')).length,6)
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

test('disabled plugin never mounts a server or skill', async () => {
 await plugin.apply({skills:{register(){throw Error('unexpected registration')}},plugin(){throw Error('unexpected launch')}},plugin.Config({enabled:false}))
})
