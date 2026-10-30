declare module "virtual:signet-docs/config" {
  import type { SignetDocsOptions } from "./index.ts"
  const config: Required<Pick<SignetDocsOptions, "title" | "wordmark" | "repo" | "base" | "nav" | "llms">> & SignetDocsOptions
  export default config
}
declare module "virtual:signet-docs/Mark" {
  const Mark: (props: { class?: string }) => unknown
  export default Mark
}
