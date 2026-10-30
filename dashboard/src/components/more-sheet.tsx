import { ResponsiveSheet } from "@nimit9/signet-ui/components/responsive-sheet"
import { Link } from "@tanstack/react-router"

export function MoreSheet({ pages, onClose }: { pages: readonly { to: string; label: string }[]; onClose: () => void }) {
  return (
    <ResponsiveSheet title="More" onClose={onClose}>
      <nav aria-label="More pages" className="flex flex-col">
        {pages.map((p) => <Link key={p.to} to={p.to} onClick={onClose} className="flex h-12 items-center border-t border-line text-base text-ink no-underline first:border-t-0">{p.label}</Link>)}
      </nav>
    </ResponsiveSheet>
  )
}
