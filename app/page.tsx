'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'

type User = { id: number; username: string; role: string; roleName: string }
type AuthStatus = { setupRequired: boolean; setupTokenRequired: boolean; setupBlocked: boolean }
type ChatMessage = { role: 'user' | 'assistant'; content: string }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers }, cache: 'no-store' })
  const body = response.status === 204 ? null : await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || '请求失败，请稍后重试')
  return body as T
}

export default function Home() {
  const [user, setUser] = useState<User | null>(null)
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [authError, setAuthError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [authForm, setAuthForm] = useState({ username: '', password: '', confirmPassword: '', setupToken: '' })
  const [summary, setSummary] = useState({ orders: 0, pending: 0, products: 0, lowStock: 0 })
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [prompt, setPrompt] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState('')

  const loadWorkspace = useCallback(async () => {
    const [orders, products] = await Promise.all([
      request<Array<{ status: string }>>('/api/orders'),
      request<Array<{ active: boolean; stock: number; threshold: number }>>('/api/products'),
    ])
    setSummary({
      orders: orders.length,
      pending: orders.filter(order => order.status === 'processing').length,
      products: products.filter(product => product.active).length,
      lowStock: products.filter(product => product.active && product.stock <= product.threshold).length,
    })
  }, [])

  useEffect(() => {
    let active = true
    async function init() {
      try {
        const status = await request<AuthStatus>('/api/auth/setup-status')
        if (!active) return
        setAuthStatus(status)
        if (!status.setupRequired) {
          try {
            const current = await request<User>('/api/auth/me')
            if (active) {
              setUser(current)
              await loadWorkspace()
            }
          } catch { /* Login is the expected state without a valid session. */ }
        }
      } catch (error) {
        if (active) setAuthError(error instanceof Error ? error.message : '无法连接服务端')
      } finally {
        if (active) setChecking(false)
      }
    }
    void init()
    return () => { active = false }
  }, [loadWorkspace])

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAuthError('')
    if (authStatus?.setupRequired && authForm.password !== authForm.confirmPassword) {
      setAuthError('两次输入的密码不一致')
      return
    }
    setAuthBusy(true)
    try {
      const path = authStatus?.setupRequired ? '/api/auth/setup' : '/api/auth/login'
      const payload = { username: authForm.username, password: authForm.password, ...(authStatus?.setupRequired && authStatus.setupTokenRequired ? { setupToken: authForm.setupToken } : {}) }
      const nextUser = await request<User>(path, { method: 'POST', body: JSON.stringify(payload) })
      setUser(nextUser)
      setAuthForm(form => ({ ...form, password: '', confirmPassword: '', setupToken: '' }))
      await loadWorkspace()
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '登录失败')
    } finally { setAuthBusy(false) }
  }

  async function logout() {
    await request('/api/auth/logout', { method: 'POST' }).catch(() => null)
    setUser(null)
    setMessages([])
  }

  async function sendPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const content = prompt.trim()
    if (!content || aiBusy) return
    setPrompt('')
    setAiError('')
    setMessages(previous => [...previous, { role: 'user', content }])
    setAiBusy(true)
    try {
      const result = await request<{ answer: string }>('/api/ai/assistant', { method: 'POST', body: JSON.stringify({ message: content }) })
      setMessages(previous => [...previous, { role: 'assistant', content: result.answer }])
    } catch (error) {
      setAiError(error instanceof Error ? error.message : 'AI 服务暂不可用')
    } finally { setAiBusy(false) }
  }

  if (checking) return <main className="center-screen"><div className="loading-card"><span className="brand-mark">T</span><p>正在连接 TradeFlow…</p></div></main>

  if (!user) {
    const setup = Boolean(authStatus?.setupRequired)
    return <main className="center-screen"><section className="auth-card">
      <div className="brand-row"><span className="brand-mark">T</span><div><strong>TradeFlow</strong><small>ERP 工作台 · Next.js</small></div></div>
      <p className="eyebrow">{setup ? '首次设置' : '安全登录'}</p>
      <h1>{setup ? '创建管理员账号' : '欢迎回来'}</h1>
      <p className="muted">{setup ? '设置第一个管理员账户后即可开始使用。' : '登录后管理订单、商品与库存，并使用 AI 助手。'}</p>
      {authStatus?.setupBlocked && <div className="error-box">生产服务未配置 TRADEFLOW_SETUP_TOKEN，请部署管理员先完成初始化配置。</div>}
      <form className="auth-form" onSubmit={submitAuth}>
        <label>用户名<input autoComplete="username" required minLength={3} value={authForm.username} onChange={e => setAuthForm({ ...authForm, username: e.target.value })} placeholder="至少 3 位" /></label>
        {setup && authStatus?.setupTokenRequired && <label>部署初始化口令<input type="password" required value={authForm.setupToken} onChange={e => setAuthForm({ ...authForm, setupToken: e.target.value })} /></label>}
        <label>密码<input type="password" autoComplete={setup ? 'new-password' : 'current-password'} required value={authForm.password} onChange={e => setAuthForm({ ...authForm, password: e.target.value })} placeholder={setup ? '至少 12 位' : '请输入密码'} /></label>
        {setup && <label>确认密码<input type="password" autoComplete="new-password" required value={authForm.confirmPassword} onChange={e => setAuthForm({ ...authForm, confirmPassword: e.target.value })} /></label>}
        {authError && <div className="error-box">{authError}</div>}
        <button className="primary-button" disabled={authBusy || authStatus?.setupBlocked}>{authBusy ? '正在连接…' : setup ? '创建管理员并进入' : '登录'}</button>
      </form>
      <p className="security-note">账户、权限与会话仍由 TradeFlow 服务端验证</p>
    </section></main>
  }

  return <main className="app-shell">
    <header className="topbar"><a className="brand-row" href="/"><span className="brand-mark">T</span><div><strong>TradeFlow</strong><small>ERP 工作台</small></div></a><div className="topbar-actions"><span className="user-chip">{user.username} · {user.roleName}</span><button className="quiet-button" onClick={logout}>退出登录</button></div></header>
    <div className="content-wrap">
      <div className="page-heading"><div><p className="eyebrow">工作空间 · Next.js 迁移版</p><h1>你好，{user.username}</h1><p className="muted">新工作台与安全 AI 服务已就绪，原有 ERP 功能仍可继续使用。</p></div><a className="primary-button link-button" href="/classic#/dashboard">打开完整 ERP 工作区 ↗</a></div>
      <section className="stats-grid">
        <article className="stat-card"><span>订单总数</span><strong>{summary.orders}</strong><a href="/classic#/orders">查看订单 →</a></article>
        <article className="stat-card"><span>待处理订单</span><strong>{summary.pending}</strong><a href="/classic#/orders">前往处理 →</a></article>
        <article className="stat-card"><span>在售商品</span><strong>{summary.products}</strong><a href="/classic#/products">管理商品 →</a></article>
        <article className="stat-card"><span>库存预警</span><strong className={summary.lowStock ? 'warn-number' : ''}>{summary.lowStock}</strong><a href="/classic#/inventory">查看库存 →</a></article>
      </section>
      <section className="assistant-card">
        <div className="assistant-heading"><div><p className="eyebrow">服务端模型调用</p><h2>TradeFlow AI 助手</h2><p className="muted">可咨询 ERP 操作、订单处理和库存管理。当前不会读取订单/库存数据；AI 只给建议，不会直接修改业务数据。</p></div><span className="ai-orb">✳</span></div>
        <div className="chat-history" aria-live="polite">{messages.length === 0 ? <p className="chat-empty">例如：如何处理缺货订单？库存预警阈值应该怎么设置？</p> : messages.map((message, index) => <div className={`chat-message ${message.role}`} key={`${index}-${message.role}`}><b>{message.role === 'user' ? '你' : 'TradeFlow AI'}</b><p>{message.content}</p></div>)}{aiBusy && <p className="chat-empty">AI 正在整理建议…</p>}</div>
        {aiError && <div className="error-box">{aiError}{aiError.includes('AI_BASE_URL') || aiError.includes('AI_API_KEY') ? ' 请在服务端 .env 配置 AI_BASE_URL、AI_MODEL 和 AI_API_KEY 后重启 Next.js。' : ''}</div>}
        <form className="prompt-form" onSubmit={sendPrompt}><textarea maxLength={2000} rows={2} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="输入你想咨询的问题…" /><button className="primary-button" disabled={aiBusy || !prompt.trim()}>{aiBusy ? '发送中…' : '发送'}</button></form>
        <p className="security-note">API Key 仅由 Next.js 服务端读取，不发送到浏览器。请勿在问题中填写任何密码或密钥。</p>
      </section>
    </div>
  </main>
}
