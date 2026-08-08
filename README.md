# Gamma X — EPM Terminal

Standalone PWA + backend that reproduces the "EPM" (Expected Premium Move) column
from the roeiq.com screenshots — a per-strike score of how many points that
option's premium is likely to swing, built from real options math instead of a
guessed number. Your existing `finalultimate01` backend and other PWAs are
**not touched** — this is its own repo/service, same pattern as Expiry Special,
Gann Terminal, etc.

## What EPM actually measures

There's no single public "EPM formula" — it's a composite. Here's exactly what
this backend computes, per strike, and why:

**1. Expected spot move (the "how far can price go" baseline)**
```
expectedMove = spot × ATM_IV × sqrt(time to expiry in years)
```
Standard implied-move formula used by every options desk to size a day's range.

**2. Raw premium sensitivity** — how much that option's own premium reacts to
that expected move, decay, and a possible IV shift:
```
raw = |Delta| × expectedMove
    + 0.5 × Gamma × expectedMove²
    − |Theta| × (fraction of trading day elapsed)
    + Vega × (assumed IV drift, default 0.5 vol pts — tune in server.js)
```
Delta term = directional sensitivity. Gamma term = convexity (accelerates near
the money). Theta term = time bleed already priced in today. Vega term =
premium's exposure to IV expanding/compressing into the close.

**3. Dealer Gamma Regime (the "hidden Greek" / dealer hedge pressure)**
Net dealer GEX is computed the standard way (dealers assumed net short calls,
net short puts — the SqueezeMetrics convention):
```
netGEX = Σ over calls: −OI × Gamma × Spot² × 0.01
       + Σ over puts:  +OI × Gamma × Spot² × 0.01
```
- **Negative netGEX** → dealers are short gamma → their hedging *adds fuel* to
  moves → EPM is **amplified** (factor up to 1.5×)
- **Positive netGEX** → dealers are long gamma → hedging *fights* moves →
  EPM is **dampened** (factor down to 0.65×)

**4. OI Wall factor** — this is what makes EPM strike-specific instead of just
a smooth Greeks curve:
- A strike with OI well above its neighborhood average is a "wall"
- **Fresh writing** at that wall (ΔOI/COI positive and large) → resistance/
  support is being reinforced → EPM **suppressed** through that strike
- **Unwinding** (ΔOI negative) → the wall is breaking down → EPM **amplified**

**5. Vanna / Charm / Vomma** are computed and returned per strike (visible in
the API response and available to extend the UI) even though they don't feed
the headline EPM number yet — they're the standard "hidden Greeks" that
explain *why* dealer hedging flow shifts as spot and IV move, and they're the
next layer to wire in if you want EPM to react to IV-driven delta shifts too.

```
EPM = raw_sensitivity × gammaRegimeFactor × oiWallFactor
```

Every one of these is a real, named quantity from Black-Scholes options theory
— nothing here is invented. The composite weighting (how strongly OI walls
damp/amplify, how much IV drift to assume) is a model, and the constants live
at the top of `server.js` so you can tune them against what you observe on
actual expiry days, the same way you tuned Expiry Special's 90-min window.

## Files

```
server.js          Express backend: Angel One SmartAPI login, Black-Scholes
                    Greeks + IV inversion, GEX/dealer regime, OI walls, EPM
package.json        dependencies
.env.example         copy to .env and fill in your credentials
epm-pwa/
  index.html         the PWA — CE | STRIKE | PE table with live EPM bars
  manifest.json
  service-worker.js
  icon-192.png / icon-512.png
```

## Deploy (your usual GitHub → Render → Netlify flow)

**Backend (Render):**
1. Push everything except `epm-pwa/` to a new GitHub repo, e.g. `gamma-x-epm-backend`
2. New Render Web Service → connect repo → Build: `npm install` → Start: `npm start`
3. Add environment variables from `.env.example` (your Angel One API key,
   client code, MPIN, TOTP secret — same credentials your other backends use)
4. Free tier sleeps like your others — same manual-wake or cron-job.org ping
   pattern you already use

**Frontend (Netlify):**
1. Push `epm-pwa/` to its own repo (or same repo, separate Netlify site pointed
   at that subfolder) — e.g. `gamma-x-epm-pwa`
2. Netlify → New site from Git → publish directory `epm-pwa`
3. Open the deployed site → tap "⚙ Backend URL" → paste your Render URL
   (this is stored in `localStorage` under key `epm_backend_url`, separate
   from your other PWAs' backend-URL keys so they don't collide)

## API

`GET /expiries?symbol=NIFTY`
Returns upcoming expiries for that symbol straight from Angel One's public
scrip master (`nearest` is the one the frontend auto-selects — no manual
date entry needed anymore).

`GET /epm-chain?symbol=NIFTY&expiry=11AUG2026`
`expiry` is now optional — if omitted, the backend auto-resolves the nearest
one the same way `/expiries` does. Returns spot, net dealer GEX + regime,
call/put wall strikes, and the full chain with `epm`, `iv`,
`delta/gamma/theta/vega/vanna/charm/vomma`, `oi`, `coi` per strike.

`GET /health` and `GET /` both return a quick status JSON — useful for
pinging the service awake on Render's free tier (cron-job.org, same as your
other backends).

## What changed in this version

- **Auto expiry detection** — no more typing a date. The backend reads
  Angel One's public scrip master, filters for that index's option
  contracts, and returns the nearest upcoming expiry.
- **Crash-proofed** — added `unhandledRejection`/`uncaughtException`
  handlers and timeouts on every outbound broker call, so a flaky broker
  response can't take the whole Node process down (that's what was showing
  up as an HTTP 502 — the process was likely dying mid-request rather than
  just being slow).
- **Always-on auto-refresh** — the PWA starts refreshing every 15s the
  moment a backend URL is saved; no toggle to remember to switch on.
- **Live status dot** in the header: grey = no backend set, orange-pulsing
  = loading, green-pulsing = live data flowing, red = last fetch failed.
- **Installable** — added `beforeinstallprompt` handling with a visible
  "⬇ Install App" button (Android Chrome will show it; iOS Safari still
  needs Share → Add to Home Screen, that's an Apple platform limit, not a
  bug in this app) plus a more complete manifest (`id`, `scope`, maskable
  icons) for reliable "Add to Home Screen" behavior everywhere.

## Direction Lean & Entry Focus (new)

Beyond per-strike EPM, `/epm-chain` now also returns a `direction` object — a
composite BULLISH / BEARISH / NEUTRAL lean with a confidence score and a
suggested strike to watch. This is a heuristic scoring model, not a
guaranteed signal — every input is disclosed in `reasons` so you can see
exactly why it leans the way it does:

1. **Spot momentum** — % change in spot over the last ~12 minutes of polling
   (this backend samples spot on every `/epm-chain` call, which the PWA
   already does every 15s, so momentum builds up automatically as you keep
   the app open — it needs a few refresh cycles before this input kicks in)
2. **OI flow** — total fresh CALL writing vs fresh PUT writing (ΔOI/COI
   summed across the chain). More call writing than put writing → resistance
   building above spot → bearish. More put writing → support building below
   → bullish.
3. **PCR** (put OI ÷ call OI) — above 1.2 is treated as a bearish tilt, below
   0.8 bullish, same convention used across your other Gamma X terminals.
4. **Dealer gamma regime** doesn't set direction by itself — it modulates
   confidence. Short gamma (dealers amplifying) boosts confidence in
   whatever lean the other three inputs already found; long gamma
   (dealers dampening, mean-reverting) reduces it.

Each of bullish/bearish scoring above ±2 combined moves the lean off
NEUTRAL; below that threshold it stays NEUTRAL ("wait, no edge yet") rather
than forcing a call. The suggested strike is the highest-EPM strike on the
leaning side within 2 strikes of ATM — pairing "which side" with "which
specific option has the most expected premium movement right now."

The exit plan attached to every verdict (SL -35% of entry premium, book
half at 2x, trail the rest with a 30% giveback from peak) matches the fixed
exit convention you've used across Blast Terminal, Wall Sniper, and
Playbook Terminal — kept identical here for consistency, not re-derived.

**Tuning knobs** (top of `server.js`): `MOMENTUM_THRESHOLD_PCT` (0.04%) and
`OI_FLOW_THRESHOLD` (50,000 contracts) decide how big a move/flow counts as
signal vs noise — treat day one's calls as "does the lean look sane," then
tighten or loosen against what you actually see.

## Honest caveats
- The `optionGreek` endpoint path used for the chain fetch matches Angel One's
  documented SmartAPI structure, but broker APIs shift occasionally — if your
  existing `finalultimate01` backend already has working chain-fetch/token-
  resolution logic, swap `fetchOptionChainRaw()` for that instead of trusting
  mine blind.
- `EXPECTED_IV_DRIFT` (0.5 vol points) and the OI-wall damp/amplify constants
  are reasonable starting values, not calibrated against your actual market
  data — treat day one's numbers as "does the ranking look sane" not "trust
  the exact points figure."
