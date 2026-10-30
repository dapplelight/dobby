# The dashboard on your phone

The dashboard listens on `127.0.0.1:4710`, so only this machine can open it. To open it from your phone, put an HTTPS tunnel
in front of it and start the dashboard with `--tunnel`. Behind a tunnel every visitor reaches the dashboard from 127.0.0.1, so
`--tunnel` makes every request show the token, exactly as on a network address.

## Tailscale (recommended: only your own devices)

1. Install Tailscale on this machine and on your phone, signed in to the same account.
2. Start a tunnel copy of the dashboard: `dobby dashboard --tunnel --port 4711`. Port 4710 belongs to the dashboard job
   (`dobby add dashboard`), which does not run with `--tunnel`, so the tunnel copy takes its own port. Leave it running.
3. Serve it over HTTPS on your tailnet: `tailscale serve --bg --https=443 http://127.0.0.1:4711`.
4. Run `dobby dashboard link --host <machine>.<tailnet>.ts.net` and open the link it prints on your phone. The phone keeps an
   HttpOnly cookie after that. Dobby prints the link only when you ask for it. It prints no QR code.

Only devices on your tailnet can reach the address.

## Cloudflare Tunnel (reachable from anywhere)

`cloudflared tunnel --url http://127.0.0.1:4711` gives a public `https://...trycloudflare.com` address, which changes every run.
Run `dobby dashboard link --host <that address>` each time to get a sign-in link for it. Anyone can load the
login page, so the token is the only lock: keep `--tunnel` on, and put Cloudflare Access (email login) in front for a
second lock.

## What not to do

- Never put a tunnel in front of a dashboard started without `--tunnel`: on loopback it serves reading without the token.
  (Its Host check refuses tunnel names, so it fails closed, but don't rely on that.)
- Never use `--host 0.0.0.0` on a shared network: that is plain HTTP, so the token crosses the network readable.
