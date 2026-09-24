# Local selling bot

The bot is optional. It runs in Node.js, with the Chrome extension forwarding a restricted set of WikiMasters API requests through the browser's existing signed-in session. `npm run bot:live` can create real listings; `npm run bot:dry` cannot send bid or listing writes. Buying is disabled in `automation/config.example.json`.

## Sale selection

Every minute, the bot reads current listings and collection cards. It excludes cards in pending trades and cards in `automation/exclusions.local.txt` or the private config's ID lists. It loads historical sale averages for **all eligible card types**, including types already on sale, before ranking them. It fetches at most 12 new card prices per cycle and retains averages for up to 24 hours. If any necessary average is missing or blocked by the API, the cycle waits rather than selling from an incomplete ranking.

Once the ranking is complete, the bot considers the ten types with the highest average sale price and randomly selects available copies from that group until the account's concurrent-listing limit is reached. It sets a 10-minute starting price randomly between 90% and 100% of the average. Historical averages may have an unknown sample size (`minSaleCount: 0` by default); neither a sale nor a final price is guaranteed.

Before each listing, the bot rereads the account and exclusion file. It confirms a successful listing against a fresh account snapshot. An uncertain result sets that copy aside for 11 minutes instead of immediately retrying the write. A missing or unreadable exclusion file stops new sales.

## Rate limiting and failures

Bot requests use one queue: at most three concurrent calls, at most two low-priority reads, and at least 1.5 seconds between request starts. Failed GET requests are retried at most twice with increasing delays. Repeated cycle failures slow that loop for up to five minutes. After repeated forbidden average-price responses, new price reads pause for 30 minutes. Ambiguous POST requests are never retried blindly.

Chrome and the extension must stay active, and the WikiMasters session must remain valid. The extension may reuse an existing WikiMasters tab or open one in the background; no special `?wmma_bot=1` URL is required. The computer must stay on and online. On macOS, `npm run bot:live` uses `caffeinate` to prevent idle sleep; closing the laptop or ending the session can still stop the bot.

## Setup

```sh
npm ci
npm run bot:setup
```

Reload the extension in `chrome://extensions/`, then refresh a WikiMasters tab. Test without writes using `npm run bot:dry` and look for `browser_connected` and `sale_cycle_ok`. Stop with Ctrl+C. Start live sales with `npm run bot:live`; stop with Ctrl+C in the same terminal. On macOS, `npm run bot:status` reports terminal or LaunchAgent status, and `npm run bot:stop` asks a terminal-run bot to stop. `npm run bot:install` installs a macOS LaunchAgent for automatic restart at sign-in; `npm run bot:uninstall` removes it. LaunchAgent logs and state live under `.wmma-bot/`.

A local lock prevents two bot processes from running simultaneously. The local WebSocket bridge listens on `127.0.0.1:17887`, checks a random 64-character token and a Chrome-extension origin, and only forwards the API paths needed for operation.

## Exclusion list

`automation/exclusions.local.txt` is created by `bot:setup`. Enter one exact WikiMasters title or card-model UUID per line. Blank lines and lines starting with `#` are ignored; case and repeated whitespace are normalized. The list is reloaded while the bot runs. A card already in an active auction cannot be withdrawn by editing this file.

Advanced exclusions: copy `automation/config.example.json` to `automation/config.local.json` and use `excludedCardIds` for models or `excludedCopyIds` for individual copies. Restart after changing this JSON configuration. It is ignored by Git. Keep `buyEnabled: false` if you want sale-only operation; that is the supplied default.

## Optional email notifications

Email notifications are disabled by default. To enable them, set `emailNotifications: true` in `automation/config.local.json` and provide these environment variables to the bot process:

- `WMMA_SMTP_USER` — your sender address
- `WMMA_SMTP_PASSWORD` — your SMTP password or app password
- `WMMA_MAIL_TO` — the recipient address
- `WMMA_SMTP_HOST` and `WMMA_SMTP_PORT` — optional; default to `smtp.gmail.com:587`

The notifier checks settled sales and purchases every minute. A sale email includes the final sale price. A purchase email includes the paid price, available average, and estimated profit before fees; manual purchases are also detected. Notification IDs are stored locally to avoid normal duplicates, though an ambiguous SMTP response can still lead to a retry. SMTP acceptance does not prove delivery to an inbox.

Do not put mail passwords in `config.local.json`, the repository, screenshots, or issue reports. Use a private environment or credential manager.

## Limits

Automatic buying code exists in the engine but is **not active** with the supplied configuration. The bot does not guarantee an auction outcome or profit. Backend errors, Cloudflare challenges, a missing average, a stale browser session, and unverified platform changes can stop or delay operations. Check the terminal output when the bot appears idle; `sale_waiting_for_prices`, `session_unavailable`, and `waiting_for_browser` indicate different causes. If the API changes, stop live mode and retest dry mode before resuming.
