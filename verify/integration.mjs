import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as plugin from '../lib/index.js'

// Optional DSH module root to exercise the actual installed Host services.
// Otherwise use the devDependencies from this checkout.
const hostRequire = createRequire(process.env.DSH_REA_TEST_MODULE_ROOT
 ? pathToFileURL(`${process.env.DSH_REA_TEST_MODULE_ROOT.replace(/\\/g,'/').replace(/\/$/,'')}/noop.js`)
 : import.meta.url)
const load = async name => import(pathToFileURL(hostRequire.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await load('@deepseek-ai/dsh-tools')
const { default: Skills } = await load('@deepseek-ai/dsh-skill')
const { default: Worker } = await load('@deepseek-ai/dsh-code-runtime-worker-thread')

const report={upstream:'6.4.0',node:process.versions.node,checks:[],modes:{},limitations:[
 'Catalog parity covers 170 tools; it is not execution coverage of all 170 operations.',
 'Only deterministic JS/data-flow, one-record HAR, one-member ZIP and state/error/disposal scenarios were compared.',
 'Cancellation tested before dispatch, not during a long-running engine operation.',
 'Native external engines, live browser/Electron, ADB and image attachments were not exercised.',
 'Six upstream MCP prompts and completions exist but DSH official tools bridge has no prompt UI.',
 'PTC error contract differs from MCP: program receives a ToolCallError with upstream message.',
 'Official bridge does not preserve MCP annotations as ToolRuntime metadata; native client metadata parity is not claimed.',
 'Model reasoning/output equivalence is not established by transport tests.'
]}
async function installedVersion(name){
 let dir=dirname(hostRequire.resolve(name))
 while(true){
  try {const pkg=JSON.parse(await readFile(join(dir,'package.json'),'utf8'));if(pkg.name===name)return pkg.version} catch(error){if(error.code!=='ENOENT')throw error}
  const parent=dirname(dir);if(parent===dir)throw Error(`Package metadata not found: ${name}`);dir=parent
 }
}
report.hostServices=Object.fromEntries(await Promise.all(['@deepseek-ai/cordis','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-skill','@deepseek-ai/dsh-code-runtime-worker-thread'].map(async name=>[name,await installedVersion(name)])))
const pass=(name,details)=>{report.checks.push({name,pass:true,details});console.log('PASS',name,details??'')}
const paths=plugin.upstreamPaths()
const direct=new Client({name:'rea-reference',version:'1'}, {capabilities:{}})
const hosts=[]
const fixture=new URL('./fixture/',import.meta.url)
await mkdir(fixture,{recursive:true})
await writeFile(new URL('index.js',fixture), `import { spawn } from 'node:child_process'
export function greet(name){return 'hi '+name}
export function request(base, token){return fetch(base+'/api/account',{headers:{Authorization:token}})}
export function worker(task){const child=spawn('node',['worker.js',task],{stdio:'pipe'});child.on('exit',()=>{});return child}
export function later(callback){const timer=setTimeout(callback,100);return ()=>clearTimeout(timer)}
`)
await writeFile(new URL('package.json',fixture), JSON.stringify({name:'rea-test-fixture',type:'module',version:'1.0.0',main:'index.js'}))
await writeFile(new URL('minimal.har',fixture), JSON.stringify({log:{version:'1.2',creator:{name:'dsh-rea-test',version:'1'},entries:[{
 startedDateTime:'2026-01-01T00:00:00Z',time:12,
 request:{method:'POST',url:'https://fixture.invalid/api/account?id=2',httpVersion:'HTTP/1.1',cookies:[],headers:[{name:'Content-Type',value:'application/json'}],queryString:[{name:'id',value:'2'}],headersSize:-1,bodySize:7,postData:{mimeType:'application/json',text:'{"x":1}'}},
 response:{status:200,statusText:'OK',httpVersion:'HTTP/1.1',cookies:[],headers:[],content:{size:11,mimeType:'application/json',text:'{"ok":true}'},redirectURL:'',headersSize:-1,bodySize:11},
 cache:{},timings:{send:1,wait:10,receive:1}
}]}}))
// One stored member ZIP, written deterministically; never execute its contents.
const filename=Buffer.from('notice.txt'),payload=Buffer.from('REA transport parity fixture\n')
let crc=0xffffffff
for(const byte of payload){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
crc=(crc^0xffffffff)>>>0
const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(payload.length,18);local.writeUInt32LE(payload.length,22);local.writeUInt16LE(filename.length,26)
const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(payload.length,20);central.writeUInt32LE(payload.length,24);central.writeUInt16LE(filename.length,28)
const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+filename.length,12);end.writeUInt32LE(local.length+filename.length+payload.length,16)
await writeFile(new URL('sample.zip',fixture),Buffer.concat([local,filename,payload,central,filename,end]))
const {fileURLToPath}=await import('node:url')
const input={input_path:fileURLToPath(fixture),format:'directory'}
let sequence=0
const call=(ctx,name,args,signal=new AbortController().signal)=>ctx.tools.execute({callId:`verify-${++sequence}`,name,arguments:args,signal})
try {
 await direct.connect(new StdioClientTransport({command:process.execPath,args:[paths.launcher,'mcp'],stderr:'pipe'}))
 const upstream=[]
 let cursor
 do {
  const page=await direct.listTools(cursor?{cursor}:{})
  upstream.push(...page.tools);cursor=page.nextCursor
 } while(cursor)
 const prompts=await direct.listPrompts()
 assert.equal(prompts.prompts.length,6)
 for(const prompt of prompts.prompts) {
  const args=Object.fromEntries((prompt.arguments??[]).filter(a=>a.required).map(a=>[a.name,'verification']))
  const template=await direct.getPrompt({name:prompt.name,arguments:args})
  assert.ok(template.messages.length)
 }
 pass('reference: six original MCP prompt templates render (DSH UI not implemented)')
 assert.equal(upstream.length,170)
 const argsEqual={}; const baseline=await direct.callTool({name:'analyze_javascript_application',arguments:input},undefined,{timeout:300000})
 assert.equal(baseline.isError,undefined)
 assert.ok(baseline.structuredContent)
 const baselineEnvelope=JSON.parse(baseline.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'))
 pass('reference MCP successful Evidence',{evidence_id:baselineEnvelope.evidence_id})
 for(const mode of ['native','ptc']) {
  // close_binary intentionally clears retained Evidence. Restore the reference
  // producer before each mode, exactly as a fresh user investigation would.
  await direct.callTool({name:'analyze_javascript_application',arguments:input},undefined,{timeout:300000})
  const ctx=new Context(); hosts.push(ctx)
  await ctx.plugin(SystemPrompt,{})
  await ctx.plugin(Skills,{})
  if(mode==='ptc') await ctx.plugin(Worker,{})
  await ctx.plugin(Tools,{mode})
  const fiber=await ctx.plugin(plugin,{})
  const schemas=ctx.tools.schemas().filter(s=>s.name.startsWith('mcp__rea__'))
  assert.equal(schemas.length,170)
  for(const t of upstream) {
   const s=schemas.find(s=>s.name===`mcp__rea__${t.name}`)
   assert.ok(s,t.name); assert.deepEqual(s.parameters,t.inputSchema);assert.equal(s.description,t.description)
  }
  pass(`${mode}: 170 names / input schemas / descriptions identical`)
  const skill=await ctx.skills.get('reverse-engineer-anything')
  assert.deepEqual(skill, {...await plugin.upstreamSkill(),invocation:{modelInvocable:true,userInvocable:true}})
  pass(`${mode}: upstream Skill v37 body and reference directory unchanged`)
  const assembly=await ctx.systemPrompt.assemble()
  report.modes[mode]={wireToolCount:assembly.tools.length,toolSchemaBytes:Buffer.byteLength(JSON.stringify(assembly.tools)),sdkTextBytes:Buffer.byteLength(assembly.sections.filter(s=>s.name==='tools:sdk').map(s=>s.text).join('\n')),totalPromptBytes:Buffer.byteLength(JSON.stringify(assembly))}
  const invoke=async (name,args)=> {
   if(mode==='native') return call(ctx,`mcp__rea__${name}`,args)
   const code=`return await tools.mcp__rea__${name}(${JSON.stringify(args)});`
   const outer=await call(ctx,'run_code',{code,description:'Verify full upstream REA parity'})
   assert.equal(outer.isError,false,JSON.stringify(outer))
   // The runtime's outer canonical value is inspected below, not guessed.
   return outer
  }
  const out=await invoke('analyze_javascript_application',input)
  await writeFile(new URL(`../verification/${mode}-result.json`,import.meta.url),JSON.stringify(out,null,2))
  console.log(mode,'result keys',Object.keys(out),'value keys',Object.keys(out.value??{}))
  if(mode==='native') {
   assert.equal(out.isError,false,JSON.stringify(out))
   assert.deepEqual(out.value.content,baseline.content)
   assert.deepEqual(out.value.structuredContent,baseline.structuredContent)
   pass('native: full content and structuredContent deeply equal to direct MCP')
  } else {
   assert.deepEqual(out.value.result.content,baseline.content)
   assert.deepEqual(out.value.result.structuredContent,baseline.structuredContent)
   pass('PTC: complete canonical result deeply equal to direct MCP (no curated omissions)')
  }
  const parity=async (tool,args,expectedSuccess=true)=> {
   const raw=await direct.callTool({name:tool,arguments:args},undefined,{timeout:300000})
   const actual=await invoke(tool,args)
   if(expectedSuccess) {
    assert.ok(!raw.isError,JSON.stringify(raw))
    assert.equal(actual.isError,false,JSON.stringify(actual))
    const value=mode==='native' ? actual.value : actual.value.result
    assert.deepEqual(value.content,raw.content)
    assert.deepEqual(value.structuredContent,raw.structuredContent)
   } else {
    assert.equal(raw.isError,true)
    if(mode==='native') {
     assert.equal(actual.isError,true)
     assert.equal(actual.error.message,raw.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'))
    }
   }
   pass(`${mode}: ${tool} ${expectedSuccess?'output':'upstream error'} parity`)
   return raw
  }
  await parity('inspect_analysis_view',{source:{kind:'retained-evidence',evidence_id:baselineEnvelope.evidence_id},view:{kind:'summary'}})
  await parity('trace_javascript_semantics',{application:{kind:'retained-evidence',evidence_id:baselineEnvelope.evidence_id},query:{direction:'backward-provenance',seed:{kind:'property',name:'Authorization'}}})
  await parity('get_evidence_bundle',{detail:'summary'})
  await parity('inspect_web_network_capture',{capture_path:fileURLToPath(new URL('minimal.har',fixture)),format:'har'})
  if(mode==='native') await parity('open_binary',{path:fileURLToPath(new URL('missing.bin',fixture))},false)
  else {
   const raw=await direct.callTool({name:'open_binary',arguments:{path:fileURLToPath(new URL('missing.bin',fixture))}})
   const caught=await call(ctx,'run_code',{code:`try { await tools.mcp__rea__open_binary({path:${JSON.stringify(fileURLToPath(new URL('missing.bin',fixture)))}}); return 'unexpected success'; } catch(e) {return e.message;}`,description:'Verify upstream REA error propagation'})
   assert.equal(raw.isError,true)
   assert.ok(caught.value.result.includes(raw.content[0].text))
   pass('PTC: upstream typed error message remains available to program')
  }
  await parity('open_binary',{path:fileURLToPath(new URL('sample.zip',fixture))})
  await parity('inspect_artifact',{})
  await parity('close_binary',{})
  // A caller cancellation must not be converted into a successful empty result.
  const controller=new AbortController();controller.abort(new Error('verification cancel'))
  const cancelled=await call(ctx,mode==='native'?'mcp__rea__binary_session':'run_code',mode==='native'?{}:{code:'return await tools.mcp__rea__binary_session({});',description:'Verify caller cancellation handling'},controller.signal)
  assert.equal(cancelled.isError,true)
  pass(`${mode}: aborted caller is an error, not silent success`)
  const alive=await invoke('binary_session',{})
  assert.equal(alive.isError,false)
  pass(`${mode}: successful call after cancellation`)
  await fiber.dispose()
  assert.equal(ctx.tools.schemas().filter(s=>s.name.startsWith('mcp__rea__')).length,0)
  pass(`${mode}: owned tools removed on dispose`)
 }
 const failedHost=new Context();hosts.push(failedHost)
 await failedHost.plugin(SystemPrompt,{})
 await failedHost.plugin(Skills,{})
 await failedHost.plugin(Tools,{mode:'native'})
 let startupError
 try {
  const failedFiber=await failedHost.plugin(plugin,{nodeCommand:fileURLToPath(new URL('missing-node.exe',fixture))})
  startupError=failedFiber.error
 } catch(error){startupError=error}
 assert.ok(startupError,'Missing launcher must fail plugin activation')
 assert.equal(failedHost.tools.schemas().filter(s=>s.name.startsWith('mcp__rea__')).length,0)
 pass('startup failure is explicit and leaves no partial REA tool catalog')
} catch(error) {report.failure={message:String(error),stack:error.stack};console.error(error); process.exitCode=1}
finally {
 await direct.close()
 for(const ctx of hosts.reverse()) await ctx.fiber.dispose()
 await mkdir(new URL('../verification/',import.meta.url),{recursive:true})
 await writeFile(new URL('../verification/integration-report.json',import.meta.url),JSON.stringify(report,null,2))
 console.log('REPORT',JSON.stringify(report,null,2))
}
