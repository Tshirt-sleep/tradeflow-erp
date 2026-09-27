const hopByHopHeaders = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
])

export default async request => {
  const backendUrl = String(process.env.TRADEFLOW_API_URL || '').replace(/\/+$/, '')
  if (!backendUrl) {
    return Response.json({ error: '尚未配置后端服务地址；请在 Netlify Functions 环境变量中设置 TRADEFLOW_API_URL。' }, { status: 503 })
  }

  const incomingUrl = new URL(request.url)
  const functionPrefix = '/.netlify/functions/api'
  const apiPath = incomingUrl.pathname.startsWith(functionPrefix)
    ? incomingUrl.pathname.slice(functionPrefix.length)
    : ''
  const destination = new URL(`${backendUrl}/api${apiPath}${incomingUrl.search}`)
  const headers = new Headers(request.headers)
  for (const header of hopByHopHeaders) headers.delete(header)

  try {
    const upstream = await fetch(destination, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
    })
    const responseHeaders = new Headers()
    upstream.headers.forEach((value, name) => {
      if (!hopByHopHeaders.has(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie') responseHeaders.append(name, value)
    })
    for (const cookie of upstream.headers.getSetCookie?.() || []) responseHeaders.append('set-cookie', cookie)
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders })
  } catch {
    return Response.json({ error: '无法连接后端服务，请检查 Netlify 中的 TRADEFLOW_API_URL。' }, { status: 502 })
  }
}
