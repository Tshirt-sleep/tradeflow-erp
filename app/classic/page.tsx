'use client'

import { useEffect, useState } from 'react'

function legacyAddress(hash: string) {
  const route = hash || '#/dashboard'
  return process.env.NODE_ENV === 'development'
    ? `http://127.0.0.1:5180/${route}`
    : `/legacy/${route}`
}

export default function ClassicWorkspace() {
  const [src, setSrc] = useState('about:blank')

  useEffect(() => {
    const sync = () => setSrc(legacyAddress(window.location.hash))
    sync()
    window.addEventListener('hashchange', sync)
    return () => window.removeEventListener('hashchange', sync)
  }, [])

  return <iframe className="classic-workspace-frame" title="TradeFlow ERP 完整工作区" src={src} />
}
