import {readFile,writeFile} from 'node:fs/promises'
const list=JSON.parse(await readFile(new URL('../verification/upstream-tools.json',import.meta.url),'utf8'))
const names=['open_binary','inspect_artifact','binary_session','close_binary','export_evidence_bundle','get_evidence_bundle','inspect_analysis_view','trace_javascript_semantics','inspect_web_network_capture','list_procedures','record_unknown']
await writeFile(new URL('../verification/selected-inputs.json',import.meta.url),JSON.stringify(list.filter(t=>names.includes(t.name)).map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema})),null,2))
