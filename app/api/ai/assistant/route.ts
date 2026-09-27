import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const windowMs = 60_000
const maxRequestsPerWindow = 12
const requestsBySession = new Map<string, number[]>()
const backendBase = () => (process.env.ERP_API_INTERNAL_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '')

function rateLimit(sessionCookie: string) {
  const now = Date.now()
  const recent = (requestsBySession.get(sessionCookie) || []).filter(time => now - time < windowMs)
  if (recent.length >= maxRequestsPerWindow) return false
  recent.push(now)
  requestsBySession.set(sessionCookie, recent)
  if (requestsBySession.size > 5000) {
    for (const [key, timestamps] of requestsBySession) {
      if (!timestamps.some(time => now - time < windowMs)) requestsBySession.delete(key)
    }
  }
  return true
}

export async function POST(request: NextRequest) {
  const sessionCookie = request.cookies.get('tradeflow_session')?.value
  if (!sessionCookie) return NextResponse.json({ error: '请先登录 TradeFlow。' }, { status: 401 })

  try {
    const sessionCheck = await fetch(`${backendBase()}/api/auth/me`, {
      headers: { cookie: request.headers.get('cookie') || '' },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!sessionCheck.ok) return NextResponse.json({ error: '登录已过期，请重新登录。' }, { status: 401 })
  } catch {
    return NextResponse.json({ error: '无法验证 TradeFlow 登录状态，请检查业务服务。' }, { status: 502 })
  }

  const sessionFingerprint = createHash('sha256').update(sessionCookie).digest('hex')
  if (!rateLimit(sessionFingerprint)) return NextResponse.json({ error: 'AI 请求较频繁，请稍后再试。' }, { status: 429 })

  let payload: unknown
  try {
    const contentLength = Number(request.headers.get('content-length') || 0)
    if (contentLength > 12_000) return NextResponse.json({ error: '请求内容过长。' }, { status: 413 })
    const reader = request.body?.getReader()
    if (!reader) return NextResponse.json({ error: '请求格式无效。' }, { status: 400 })
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > 12_000) {
        await reader.cancel()
        return NextResponse.json({ error: '请求内容过长。' }, { status: 413 })
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    payload = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return NextResponse.json({ error: '请求格式无效。' }, { status: 400 })
  }

  const message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
    ? payload.message.trim()
    : ''
  if (!message || message.length > 2000) return NextResponse.json({ error: '请输入 1 到 2000 个字符的问题。' }, { status: 400 })

  const apiKey = process.env.AI_API_KEY
  const model = process.env.AI_MODEL
  const baseUrl = process.env.AI_BASE_URL?.replace(/\/+$/, '')
  if (!apiKey || !model || !baseUrl) {
    return NextResponse.json({ error: 'AI 服务尚未配置。请由部署管理员在服务端设置 AI_BASE_URL、AI_MODEL 和 AI_API_KEY。' }, { status: 503 })
  }

  try {
    const target = new URL(`${baseUrl}/chat/completions`)
    if (target.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(target.hostname)) {
      return NextResponse.json({ error: 'AI 服务地址必须使用 HTTPS。' }, { status: 503 })
    }
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 700,
        messages: [
          { role: 'system', content: '你是 TradeFlow ERP 的中文业务助手。请清楚、谨慎地回答订单、库存、商品和跨境电商运营相关问题。你只能提供建议，不得声称已经修改订单、库存、用户或其他业务数据；如需执行操作，指导用户在 ERP 工作区中完成。不要索取密码、API Key 或其他凭据。' },
          { role: 'user', content: message },
        ],
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
    if (!upstream.ok) return NextResponse.json({ error: 'AI 服务暂时不可用，请稍后重试或检查服务端模型配置。' }, { status: 502 })
    const result = await upstream.json()
    const answer = result?.choices?.[0]?.message?.content
    if (typeof answer !== 'string' || !answer.trim()) return NextResponse.json({ error: 'AI 服务返回了空内容，请稍后重试。' }, { status: 502 })
    return NextResponse.json({ answer: answer.slice(0, 8000) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch {
    return NextResponse.json({ error: 'AI 请求超时或连接失败，请检查服务端配置。' }, { status: 502 })
  }
}
