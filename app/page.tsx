'use client'
import dynamic from 'next/dynamic'
import Image from 'next/image'

const FreeDrawMap = dynamic(
  () => import('../components/map/drawonmap'),
  { ssr: false }
)

export default function Home() {
  return (
    <div className="h-screen flex flex-col bg-white">
      {/* Top bar */}
      <header className="h-14 border-b border-zinc-200 flex items-center justify-between px-5 shrink-0">
        <div className="flex items-center gap-3">
          <Image
            src="/tropenbos-logo.svg"
            alt="Tropenbos Ghana"
            width={32}
            height={32}
            priority
            className="shrink-0"
          />
          <span className="text-sm font-medium tracking-tight text-zinc-900">
            Tropenbos Ghana Monitoring Dashboard
          </span>
        </div>
      </header>

      {/* App body */}
      <div className="flex-1 min-h-0">
        <FreeDrawMap />
      </div>
    </div>
  )
}
