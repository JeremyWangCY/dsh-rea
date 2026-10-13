const res = await fetch('http://127.0.0.1:19387/plugins/events', { signal: AbortSignal.timeout(3000) })
const reader = res.body.getReader(); const dec = new TextDecoder(); let text = ''
while (true) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value, {stream:true}); if (text.includes('\n\n')) break }
const frame = JSON.parse(text.split('\n').find(l => l.startsWith('data: ')).slice(6))
const row = (frame.graph?.entries ?? []).find(r => r.id === 'dsh-rea')
console.log('dsh-rea rev:', row?.rev)
const bundle = await fetch(`http://127.0.0.1:19387/${row.url}`)
const body = await bundle.text()
console.log('bundle status:', bundle.status, 'bytes:', body.length)
console.log('has prefix-key filter:', body.includes('keyOf(p.name).toLowerCase().includes(needle)'))
console.log('still has old filter   :', body.includes('.filter(p => p.name.includes(needle)'))
process.exit(0)
