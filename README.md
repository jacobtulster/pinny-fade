# Pinny Fade — MLB / NFL / WNBA Open to Close

Fade high ZCode public ratios when Bet105 (Pinnacle clone) line movement goes the other way.

## Setup (once)

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Add / re-paste [`userscript/pinny-fade-mlb.user.js`](userscript/pinny-fade-mlb.user.js) (**v1.6.1+**).
3. Allow the script to open tabs / connect to bookmakersreview.com (and GitHub / score APIs) when prompted.

### Critical if you open `index.html` by double‑click (`file://`)

Chrome/Edge blocks Tampermonkey on local files by default. Without this, **Refresh** and the slate do nothing.

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Find **Tampermonkey** → **Details**.
3. Turn **ON** “Allow access to file URLs”.
4. Hard-refresh the dashboard (`Ctrl+Shift+R`).

You should see a green **TM companion connected** badge bottom-right. If not, the companion is not running.

### Easier: serve over localhost (recommended)

In VS Code/Cursor: install **Live Server**, right‑click `index.html` → **Open with Live Server**  
(or run `npx --yes serve .` in this folder and open the printed `http://localhost:…` URL).

### GitHub history backup (continual)

1. Create a classic Personal Access Token with **`repo`** scope.
2. On the dashboard tab: Tampermonkey menu → **Set GitHub token** → **Set GitHub repo / branch** (`owner/repo`, usually `main`).
3. Keep the live dashboard open. History backups run **automatically** whenever the slate updates (debounced ~2.5s) and at least every minute. The script overwrites `history/YYYY-MM-DD.json` (America/New_York date). The **last export of the day** is the permanent record.
4. Finals are filled periodically (MLB Stats API + ESPN). **Take** pick is graded **W / P / L**.
5. Open [`history.html`](history.html) (or after GitHub Pages deploy) to browse past days.

Optional: **Export today** downloads a local JSON copy. Menu → **Backup history now** / **Update recent W/P/L results**.

## Run

1. Open the **dashboard** with the userscript enabled (green TM badge).
2. Click **Open ZCode tabs** — opens [BMR odds-scores](https://www.bookmakersreview.com/odds-scores/) plus MLB / NFL / WNBA Line Reversals (stay logged in on ZCode).
3. On ZCode: enable **Tickets Public Rankings** / Public Bets **Show All**.
4. Keep the dashboard tab open — slate fills from fresh polls; history backups run in the background when GitHub is configured.

## Notes

- Odds source: [Bookmakers Review odds-scores](https://www.bookmakersreview.com/odds-scores/) + Bet105 GraphQL open/current (`paid=130`). MLB moneyline; NFL/WNBA point spread.
- No persistent dashboard cache — only live TM pushes. GM storage is live IPC between open tabs.
- History grades **Take** only: MLB = ML vs final; NFL/WNBA = ATS vs snapshot current spread.
- Move: MLB = American ¢ on current fav; NFL/WNBA = spread points on current fav.
- **Not respected** = public side’s money not followed by Bet105 move.
