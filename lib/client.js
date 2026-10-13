// DSH closure-factory bundle. React is supplied by the existing module loader.
window.__ModuleLoader__.load({ id: 'dsh-rea', factory(require) {
  const React = require('react')
  const h = React.createElement
  const titles = { investigate_feature: '调查功能', compare_versions: '比较版本', verify_reconstruction: '验证重建', trace_crash: '追踪崩溃', audit_residual_unknowns: '审计未知项', prepare_bounded_process_capture: '准备进程采集' }
  const css = `.dsh-rea-backdrop{position:fixed;inset:0;z-index:1000;background:#0007;display:flex;align-items:center;justify-content:center}.dsh-rea-panel{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:22px;width:min(820px,94vw);max-height:90vh;overflow:auto;box-shadow:0 16px 70px #0005}.dsh-rea-panel label{display:block;margin-top:12px;font-size:13px}.dsh-rea-panel input,.dsh-rea-panel select,.dsh-rea-panel textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:inherit;border-radius:7px;padding:9px;margin:5px 0}.dsh-rea-panel small,.dsh-rea-panel p{color:var(--dsw-alias-label-secondary)}.dsh-rea-panel button,.dsh-rea-launch{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:7px 12px;cursor:pointer}.dsh-rea-panel button:disabled{opacity:.45;cursor:default}.dsh-rea-footer{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}.dsh-rea-error{color:var(--dsw-alias-state-error-primary)}.dsh-rea-preview{font-family:monospace;min-height:220px}.dsh-rea-suggestions{display:flex;gap:6px;flex-wrap:wrap}.dsh-rea-suggestions button{font-size:12px;max-width:100%;overflow-wrap:anywhere}`
  function PromptPanel({ rpc, inputActions, useInput, sessionId }) {
    const draft = useInput(state => state.draft)
    const [open, setOpen] = React.useState(false)
    const [catalog, setCatalog] = React.useState([])
    const [name, setName] = React.useState('')
    const [values, setValues] = React.useState({})
    const [focus, setFocus] = React.useState('')
    const [suggestions, setSuggestions] = React.useState([])
    const [preview, setPreview] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const [server, setServer] = React.useState('')
    const prompt = catalog.find(p => p.name === name)
    const valid = !!prompt && (prompt.arguments ?? []).every(a => !a.required || (values[a.name] ?? '').trim())
    const call = async (method, args, signal) => {
      const result = await rpc.call('/dsh-rea-prompts', method, args, signal)
      if (!result.ok) throw Error(result.error.message)
      return result.value
    }
    // A missing channel is almost always a Host that mounted the previous
    // version and cached it as host-only: say so instead of showing a bare
    // transport status.
    const explain = error => {
      const message = String(error?.message ?? error)
      return /transport failure[^]*HTTP (401|403|404|405)/.test(message)
        ? `REA 模板通道不可用（${message}）。如果刚升级过本插件，请重启一次 DSH，让新的客户端 bundle 与宿主端通道生效。`
        : message
    }
    React.useEffect(() => {
      setOpen(false); setPreview(null); setValues({}); setFocus(''); setError('')
    }, [sessionId])
    React.useEffect(() => {
      if (!open) return
      const abort = new AbortController()
      setBusy(true); setError('')
      call('list', {}, abort.signal).then(result => {
        setCatalog(result.prompts); setServer(result.serverName)
        setName(result.prompts[0]?.name ?? ''); setValues({}); setPreview(null)
      }).catch(e => { if (!abort.signal.aborted) setError(explain(e)) })
        .finally(() => { if (!abort.signal.aborted) setBusy(false) })
      return () => abort.abort()
    }, [open])
    React.useEffect(() => {
      setSuggestions([])
      if (!open || !focus || !name) return
      const abort = new AbortController()
      const timer = setTimeout(() => {
        call('complete', { name, argument: focus, value: values[focus] ?? '', arguments: values }, abort.signal)
          .then(result => { if (!abort.signal.aborted) setSuggestions(result.completion.values) })
          .catch(e => { if (!abort.signal.aborted) setError(explain(e)) })
      }, 220)
      return () => { clearTimeout(timer); abort.abort() }
    }, [open, name, focus, values])
    const change = (key, value) => { setValues(prev => ({ ...prev, [key]: value })); setPreview(null); setError('') }
    const render = async () => {
      setBusy(true); setError('')
      const requestedName = name, requestedValues = values
      try {
        const result = await call('get', { name, arguments: values })
        // Only textual USER prompts can be faithfully inserted as a user draft.
        if (result.messages.some(m => m.role !== 'user' || m.content.type !== 'text')) throw Error('此模板不是纯文本 user 消息，不能无损插入输入框。')
        setPreview({ text: result.messages.map(m => m.content.text).join('\n\n'), name: requestedName, values: requestedValues })
      } catch(e) { setError(explain(e)) } finally { setBusy(false) }
    }
    const fresh = preview && preview.name === name && preview.values === values
    const insert = () => {
      if (!fresh || busy) return
      inputActions.setDraft(draft ? `${draft}\n\n${preview.text}` : preview.text)
      setOpen(false)
    }
    return h(React.Fragment, null,
      h('button', { type: 'button', className: 'dsh-rea-launch', title: 'REA 原版任务模板（不自动发送）', onClick: () => setOpen(true) }, 'REA 模板'),
      open && h('div', { className: 'dsh-rea-backdrop', onKeyDown: e => { if (e.key === 'Escape') setOpen(false) } },
        h('section', { className: 'dsh-rea-panel', role: 'dialog', 'aria-modal': true, 'aria-label': 'REA 原版任务模板' },
          h('h2', null, 'REA 原版任务模板'),
          h('p', null, `直接调用原版 prompts/completions，与 ${server || 'REA'} 工具共用会话。预览不会运行分析，插入不会发送。`),
          h('label', null, '任务模板', h('select', { value: name, disabled: busy, onChange: e => { setName(e.target.value); setValues({}); setFocus(''); setPreview(null); setError('') } },
            catalog.map(p => h('option', { key: p.name, value: p.name }, `${titles[p.name] ?? p.title ?? p.name} · ${p.name}`)))),
          prompt && h('small', null, prompt.description),
          ...(prompt?.arguments ?? []).map(a => h('label', { key: a.name }, `${a.name}${a.required ? ' *' : '（可选）'}`,
            h('input', { value: values[a.name] ?? '', disabled: busy, 'aria-label': a.name, onFocus: () => setFocus(a.name), onChange: e => change(a.name, e.target.value) }),
            h('small', null, a.description),
            focus === a.name && suggestions.length > 0 && h('div', { className: 'dsh-rea-suggestions', 'aria-label': `${a.name} 补全` }, suggestions.map(s => h('button', { key: s, type: 'button', onClick: () => change(a.name, s) }, s))))),
          error && h('div', { className: 'dsh-rea-error', role: 'alert' }, error),
          fresh && h('label', null, '原版文本预览', h('textarea', { className: 'dsh-rea-preview', readOnly: true, value: preview.text, 'aria-label': '原版文本预览' })),
          h('div', { className: 'dsh-rea-footer' },
            h('button', { type: 'button', onClick: () => setOpen(false) }, '关闭'),
            h('button', { type: 'button', disabled: busy || !valid, onClick: render }, busy ? '正在读取…' : '生成预览'),
            h('button', { type: 'button', disabled: busy || !fresh, onClick: insert }, '插入输入框（不发送）')))))
  }
  return {
    inject: ['slots', 'connection'],
    apply(ctx) {
      const style = document.createElement('style'); style.dataset.plugin = 'dsh-rea'; style.textContent = css
      ctx.effect(() => { document.head.append(style); return () => style.remove() }, 'dsh-rea: styles')
      const rpc = ctx.get('connection').rpc
      ctx.get('slots').inject('conversation.input.left', () => ctx.get('slots').register({ name: 'conversation.input.left', id: 'dsh-rea-prompts', order: 50 }, props => h(PromptPanel, { ...props, rpc })))
    },
  }
} })
