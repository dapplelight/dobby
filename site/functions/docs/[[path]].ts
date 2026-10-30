// /docs/*: `Accept: text/markdown` returns the page's .md copy (see theme/functions/negotiate.ts).
import { negotiate } from "../../theme/functions/negotiate.ts"

type Ctx = { request: Request; env: { ASSETS: { fetch(req: Request | string): Promise<Response> } }; next(): Promise<Response> }
export const onRequest = (ctx: Ctx) => negotiate(ctx.request, ctx.env.ASSETS, () => ctx.next())
