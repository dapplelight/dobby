import { ThemeProvider } from "@nimit9/signet-ui/components/theme-provider"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./app.css"
import { router } from "./router"

// networkMode "always": the browser reporting itself offline must not pause a request silently; it fails, and the page says so.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 5_000, networkMode: "always" }, mutations: { networkMode: "always" } } })

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="dobby-theme">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
