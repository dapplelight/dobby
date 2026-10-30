// Cloudflare Pages Function body: a docs URL asked for with `Accept: text/markdown` gets the page's .md copy.
// Mount it from the product's functions/<base>/[[path]].ts. Everything else passes through, with `Vary: Accept`.

type Fetcher = { fetch(req: Request | string): Promise<Response> }

/** True when the client prefers markdown over HTML (q-values respected; no q means 1). */
export function wantsMarkdown(accept: string | null): boolean {
  const q = (type: string) => {
    for (const part of (accept ?? "").split(",")) {
      const [t, ...params] = part.trim().split(";").map((s) => s.trim())
      if (t.toLowerCase() !== type) continue
      const v = params.find((p) => p.startsWith("q="))
      return v ? Number(v.slice(2)) || 0 : 1
    }
    return 0
  }
  const md = q("text/markdown")
  return md > 0 && md >= q("text/html")
}

/** "/docs/billing/" -> "/docs/billing.md"; paths that already name a file are left alone (undefined). */
export function markdownPath(pathname: string): string | undefined {
  if (/\.[a-z0-9]+$/i.test(pathname)) return undefined
  const p = pathname.replace(/\/+$/, "")
  return p ? `${p}.md` : undefined
}

export async function negotiate(request: Request, assets: Fetcher, next: () => Promise<Response>): Promise<Response> {
  const url = new URL(request.url)
  const md = request.method === "GET" || request.method === "HEAD" ? markdownPath(url.pathname) : undefined
  if (md && wantsMarkdown(request.headers.get("Accept"))) {
    const res = await assets.fetch(new URL(md, url).href)
    if (res.ok) {
      return new Response(request.method === "HEAD" ? null : res.body, {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8", Vary: "Accept", "Cache-Control": res.headers.get("Cache-Control") ?? "public, max-age=0, must-revalidate" },
      })
    }
  }
  const res = await next()
  const out = new Response(res.body, res)
  out.headers.append("Vary", "Accept")
  return out
}
