# Pinny Fade — MLB / NFL / WNBA Open to Close

Fade high ZCode public ratios when Bet105 (Pinnacle clone) line movement goes the other way.

## Live site (public)

- Dashboard: https://jacobtulster.github.io/pinny-fade/
- History: https://jacobtulster.github.io/pinny-fade/history.html
- Repo: https://github.com/jacobtulster/pinny-fade

## Setup (once)

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Add / re-paste [`userscript/pinny-fade-mlb.user.js`](userscript/pinny-fade-mlb.user.js) (**v1.7.0+**).
3. Allow the script to open tabs / connect to bookmakersreview.com (and GitHub / score APIs) when prompted.
4. Open the **live** dashboard URL above (not only localhost) so backups and the companion run on GitHub Pages.

### GitHub history backup (continual)

1. Create a classic Personal Access Token with **`repo`** scope.
2. On the dashboard tab: Tampermonkey menu → **Set GitHub token** → **Set GitHub repo / branch** → `jacobtulster/pinny-fade` / `main`.
3. Keep the live dashboard open. History backups run **automatically** whenever the slate updates (debounced ~2.5s) and at least every minute. The script **merge-preserves** finished games into `history/YYYY-MM-DD.json` (America/New_York date) so they are not wiped when ZCode drops them. Finals + coordinated slams are stored on the same day file.
4. Live/final scores: MLB Stats API + ESPN (NFL/WNBA). Dashboard **Score** column updates ~75s. **Take** is graded **W / P / L** after finals.
5. Coordinated slams (≥2 of Bet105 / BetCRIS / BetOnline, same direction within 2 min, ≥6¢ ML or ≥0.5pt spread line) appear in the table below the live slate and in History.
6. Anyone can open the public History URL to browse past days (after the first backup commits).

Optional: **Export today** downloads a local JSON copy. Menu → **Backup history now** / **Update recent W/P/L results** / **Poll live scores** / **Poll coordinated slams**.

### Local / file:// (optional)

Chrome/Edge blocks Tampermonkey on local files unless **Allow access to file URLs** is on. Live Server / localhost also works; prefer the GitHub Pages URL for the public history site.

## Run

1. Open https://jacobtulster.github.io/pinny-fade/ with the userscript enabled (green TM badge).
2. Click **Open ZCode tabs** — opens [BMR odds-scores](https://www.bookmakersreview.com/odds-scores/) plus MLB / NFL / WNBA Line Reversals (stay logged in on ZCode).
3. On ZCode: enable **Tickets Public Rankings** / Public Bets **Show All**.
4. Keep the dashboard tab open — slate fills; scores + slams refresh; history commits land in this repo and show on the History page.

## Notes

- Odds source: [Bookmakers Review odds-scores](https://www.bookmakersreview.com/odds-scores/) + Bet105 GraphQL open/current (`paid=130`). Slam books: Bet105=130, BetCRIS=10, BetOnline=8 via `lineHistory`.
- MLB moneyline; NFL/WNBA point spread.
- No persistent dashboard cache — only live TM pushes. GM storage is live IPC between open tabs.
- History grades **Take** only: MLB = ML vs final; NFL/WNBA = ATS vs snapshot current spread.
- Move: MLB = American ¢ on current fav; NFL/WNBA = spread points on current fav.
- **Not respected** = public side’s money not followed by Bet105 move.
