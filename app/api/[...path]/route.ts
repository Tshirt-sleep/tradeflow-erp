import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ path: string[] }> }
const backendBase = () => (process.env.ERP_API_INTERNAL_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '')

async function proxy(request: NextRequest, context: RouteContext) {
  const { path } = await context.params
  const destination = new URL(`/api/${path.map(segment => encodeURIComponent(segment)).join('/')}${request.nextUrl.search}`, backendBase())
  const headers = new Headers()
  for (const name of ['accept', 'content-type', 'cookie', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }

  try {
    const upstream = await fetch(destination, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    })
    const responseHeaders = new Headers()
    for (const name of ['content-type', 'cache-control']) {
      const value = upstream.headers.get(name)
      if (value) responseHeaders.set(name, value)
    }
    const cookies = upstream.headers.getSetCookie()
    for (const cookie of cookies) responseHeaders.append('set-cookie', cookie)
    return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders })
  } catch {
    return NextResponse.json({ error: '无法连接 TradeFlow 业务服务，请检查 ERP_API_INTERNAL_URL 和后端状态。' }, { status: 502 })
  }
}

export const GET = proxy
export const POST = proxy
export const PATCH = proxy
export const PUT = proxy
export const DELETE = proxy
