# Paying for Claude: plan or API key

Dobby runs Claude Code for every role. It can pay in one of two ways, set in `~/.config/dobby/config.json`.

## Plan (default)

A Claude Pro or Max sign-in (`claude`, then `/login`). Runs count against the plan's 5-hour and weekly windows, and
Dobby paces itself so the last 5% of the week stays yours. Best value if you already pay for Max.

## API key

No plan needed: every run, builders included, pays by the token.

```json
{ "billing": { "mode": "apiKey", "dailyUsd": 20, "weeklyUsd": 100 } }
```

1. Create a key at console.anthropic.com and add the line `DOBBY_API_KEY=<key>` to Dobby's secrets file in `~/.config/dobby`.
2. Set `billing` as above. `dailyUsd` caps spend over the last 24 hours (default $20); `weeklyUsd` over 7 days (optional).
3. Run `dobby doctor`: the "API key" row replaces "Claude sign-in".

When a cap is reached, builds wait until older runs fall out of the window. Spend is the cost Claude Code reports for each
run (`dobby usage` lists it). The key goes to Claude Code only; with the sandbox on, the commands a builder runs can't read it.

Dobby reads `DOBBY_API_KEY`, never `ANTHROPIC_API_KEY`: a stray `ANTHROPIC_API_KEY` in your shell would otherwise move
your own Claude Code sessions off your plan.

## Which one?

- Already on Max: plan. Dobby uses the room you don't.
- No plan, or Dobby runs on a server: API key, with a daily cap you're comfortable with.

Other providers (OpenAI, Codex and the rest) go through provider routing, off by default: see `providers` in the config.
