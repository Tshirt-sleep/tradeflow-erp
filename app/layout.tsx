import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'TradeFlow ERP · 工作台',
  description: 'TradeFlow ERP 跨境电商管理工作台',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>
}
