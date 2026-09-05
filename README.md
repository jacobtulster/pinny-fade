# Pinny Fade — MLB / NFL / NCAAF / WNBA Open to Close

Fade high ZCode public ratios when Bet105 (Pinnacle clone) line movement goes the other way.

## Live site (public)

- Dashboard: https://jacobtulster.github.io/pinny-fade/
- History: https://jacobtulster.github.io/pinny-fade/history.html
- Kalshi Liq + Ratio: https://jacobtulster.github.io/pinny-fade/kalshi-liq-ratio.html
- Repo: https://github.com/jacobtulster/pinny-fade

## Setup (once)

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Add / re-paste [`userscript/pinny-fade-mlb.user.js`](userscript/pinny-fade-mlb.user.js) (**v1.8.0+**).
3. Allow the script to open tabs / connect to bookmakersreview.com (and GitHub / score APIs) when prompted.
4. Open the **live** dashboard URL above (not only localhost) so backups and the companion run on GitHub Pages.

### GitHub history backup (continual)

1. Create a classic Personal Access Token with **`repo`** scope (or a fine-grained token with **Contents: Read and write** on `jacobtulster/pinny-fade`).
2. On the dashboard tab: Tampermonkey icon → **Set GitHub token**. Repo defaults to `jacobtulster/pinny-fade` / `main` (optional: **Set GitHub repo / branch**).
3. Keep the live dashboard open. Archives always save **locally in Tampermonkey** (so History works on localhost). When a token is set, they also commit to `history/YYYY-MM-DD.json` on GitHub. Backups run when the slate updates (~2.5s debounce) and at least every minute. Finished games are **merge-preserved** so ZCode dropping them does not wipe the day file. Finals + coordinated slams are stored on the same day file.
4. Live/final scores: MLB Stats API + ESPN (NFL/NCAAF/WNBA). Dashboard score under `#` updates ~75s. **Take** is graded **W / P / L** after finals.
5. Coordinated slams (≥2 of Bet105 / BetCRIS / BetOnline, same direction within 2 min, ≥6¢ ML or ≥0.5pt spread line) appear below the live slate and in History.
6. History page reads: Tampermonkey local archive → local `history/*.json` → public GitHub Pages / raw.

Optional: **Export today** downloads a JSON copy. Menu → **Backup history now** / **Update recent W/P/L results**.

Status bar tip: if you see **Saved locally — GitHub token missing**, history still works in this browser via TM; set the token to publish to the public History site.

### Local / file:// (optional)

Chrome/Edge blocks Tampermonkey on local files unless **Allow access to file URLs** is on. Live Server / localhost also works; prefer the GitHub Pages URL for the public history site.

## Run

1. Open https://jacobtulster.github.io/pinny-fade/ with the userscript enabled (green TM badge).
2. Click **Open ZCode tabs** — opens [BMR odds-scores](https://www.bookmakersreview.com/odds-scores/) plus MLB / NFL / NCAAF / WNBA Line Reversals (stay logged in on ZCode).
3. On ZCode: enable **Tickets Public Rankings** / Public Bets **Show All**.
4. Keep the dashboard tab open — slate fills; scores + slams refresh; history commits land in this repo and show on the History page.

## Notes

- Odds source: [Bookmakers Review odds-scores](https://www.bookmakersreview.com/odds-scores/) + Bet105 GraphQL open/current (`paid=130`). Slam books: Bet105=130, BetCRIS=10, BetOnline=8 via `lineHistory`.
- MLB moneyline; NFL/NCAAF/WNBA point spread.
- **Kalshi leans** (`kalshi.html`): paste teams Kalshi thinks cover; ranked by lean-side public ratio (lowest = highest urgency).
- **Kalshi Liquidity** (`kalshi-liq.html`): per-side **unfilled** (resting book) + **filled** (lifetime volume × last/mid) + **total**. Split/sort use the combined $. Soccer filter still needs ≥ $10k unfilled.
- **Kalshi Liq + Ratio** (`kalshi-liq-ratio.html`): ZCode × vs Kalshi **unfilled + filled $**. Default rank = most $ on the dog + highest fav ×. Click Fav $ to rank most $ on the fav + lowest fav ×.
- No persistent dashboard cache — only live TM pushes. GM storage is live IPC between open tabs.
- History grades **Take** only: MLB = ML vs final; NFL/NCAAF/WNBA = ATS vs snapshot current spread.
- Move: MLB = American ¢ on current fav; NFL/NCAAF/WNBA = spread points on current fav.
- **Not respected** = public side’s money not followed by Bet105 move.

## Discord Kalshi book alerts (existing server)

You do **not** invite a bot. Add a **webhook** to a channel in the Discord server you already have. The Railway process posts into that channel. **No @mentions** unless you later set `DISCORD_USER_IDS`.

### 1. Webhook in your server

1. Open Discord → your server → the channel you want alerts in (make one like `#kalshi-alerts` if you want).
2. Channel settings (gear) → **Integrations** → **Webhooks** → **New Webhook**.
   - Or: Server Settings → **Integrations** → **Webhooks** → **New Webhook**, then set the channel.
3. Name it whatever (`Kalshi watch` is fine).
4. **Copy Webhook URL**. That URL is the secret — do not paste it in chat or commit it.

If you do not see Integrations, you need **Manage Webhooks** on that channel (owner / admin usually has it).

### 2. Put the watcher on Railway (always on)

The watcher is [`alerts/kalshi-watch.js`](alerts/kalshi-watch.js). It polls Kalshi every ~45s and posts when a side’s **unfilled $** jumps or drops by **$100k** (default). Spread alerts name the **favorite** (`DUKE -9.5`) and each side’s own number (`DUKE -9.5` vs `TULN +9.5`). A drop means that side’s resting bids shrank — if hit, someone took the other side; cancelled bids look the same. **Pregame only** — start time is the ticker clock (first pitch / kickoff), not Kalshi’s `occurrence_datetime` (that is often estimated game end). Once that start has passed, the game is ignored. First cycle is silent (seed).

1. Push this repo to GitHub (the `alerts/` folder must be on the branch Railway uses).
2. [Railway](https://railway.app) → New Project → Deploy from GitHub repo → this repo.
3. Service settings:
   - **Root Directory:** `alerts`
   - **Start Command:** `npm start` (or leave default; `package.json` already has it)
4. Variables (same names as [`alerts/.env.example`](alerts/.env.example)):

| Variable | Example |
|---|---|
| `DISCORD_WEBHOOK_URL` | the webhook URL from step 1 |
| `ALERT_DELTA_USD` | `100000` (optional) |
| `KALSHI_SPORTS` | `NFL,NCAAF,MLB,WNBA` (optional) |
| `PREGAME_ONLY` | `1` (default; skip live games) |
| `DISCORD_USER_IDS` | leave unset (optional `@` later) |

5. Deploy. You should get one **“watcher is up”** message in the channel (no ping). After that, only $100k appear/drop moves.

To test the webhook without waiting for a real wall: leave Railway running and change `ALERT_DELTA_USD` to `1000` for a few minutes, then set it back.

Local test (optional): `cd alerts` → copy `.env.example` to `.env` → `npm install` → `npm start`.
