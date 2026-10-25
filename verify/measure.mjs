import { createRequire } from 'node:module'
import { writeFile, mkdir } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { CATEGORY_IDS, categoryOf } from '../lib/categories.js'
const require = createRequire(import.meta.url)
const rea = require.resolve('rea-agents/package.json').replace(/package\.json$/, 'scripts/rea.mjs')
const client = new Client({name:'dsh-rea-audit',version:'1'}, {capabilities:{}})
try {
 await client.connect(new StdioClientTransport({command:process.execPath,args:[rea,'mcp'],stderr:'pipe'}))
 const tools=[]; let cursor
 do { const page=await client.listTools(cursor ? {cursor}:undefined); tools.push(...page.tools); cursor=page.nextCursor } while(cursor)
 const projected=tools.map(t=>({name:`mcp__rea__${t.name}`,description:t.description??'',parameters:t.inputSchema}))
 const bytes=x=>Buffer.byteLength(JSON.stringify(x))
 const byCategory=Object.fromEntries(CATEGORY_IDS.map(id=>[id,{tools:0,bytes:0}]))
 for(const [i,t] of tools.entries()){const c=byCategory[categoryOf(t.name)];c.tools++;c.bytes+=bytes(projected[i])}
 const report={version:client.getServerVersion(),capabilities:client.getServerCapabilities(),toolCount:tools.length,fullCatalogBytes:bytes(tools),modelInputBytes:bytes(projected),inputSchemaBytes:bytes(tools.map(t=>t.inputSchema)),outputSchemaBytes:bytes(tools.map(t=>t.outputSchema)),descriptionBytes:bytes(tools.map(t=>t.description)),maxPublicNameLength:Math.max(...projected.map(t=>t.name.length)),byCategory}
 await mkdir(new URL('../verification/',import.meta.url),{recursive:true})
 await writeFile(new URL('../verification/upstream-tools.json',import.meta.url),JSON.stringify(tools,null,2))
 await writeFile(new URL('../verification/schema-measurement.json',import.meta.url),JSON.stringify(report,null,2))
 console.log(JSON.stringify(report,null,2))
} finally {await client.close()}
