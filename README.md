# WikiMasters Market Lens

A Chrome extension that shows historical sale averages on the [WikiMasters marketplace](https://www.wiki-masters.com/marketplace), auction pages, and your collection. This repository also contains an **optional local selling bot**. The extension works on its own; installing it does not start the bot or place any bids or listings.

> **Authorization required.** [WikiMasters' public community rules](https://www.wiki-masters.com/rules) prohibit bots and traffic interception for an advantage. This project observes marketplace responses, and its optional bot can create listings. Obtain explicit permission from WikiMasters for **your own account and intended use** before using these features. Permission granted to another user does not cover you. This is an independent project, not an official WikiMasters extension.

## What the extension does

- Shows the historical average sale price for the matching card and rarity in purple, inside marketplace cards, auction details, and collection cards.
- Outlines a marketplace auction in purple when its displayed price is at most half of that average.
- Animates the loading indicator while a price is being fetched. Missing sale data is shown as unavailable.
- Loads averages for visible cards first, caches fresh values for 24 hours, and slows requests when the API rate limits them.

An average is historical data, not a guaranteed resale price. The current auction price can change after the outline appears.

### Install the extension

1. Download or clone this repository into a folder you will keep. The folder containing `manifest.json` is the extension root.
2. Open `chrome://extensions/` in Chrome and enable **Developer mode**.
3. Choose **Load unpacked** and select the repository folder.
4. Open WikiMasters and refresh the page. After changing extension files, use **Reload** on the extension card and refresh the WikiMasters tab.

No Node.js, local token, or bot setup is needed for the price overlay.

## Optional selling bot

The bot uses your existing WikiMasters session in Chrome through the extension. It runs only while the local process is active. **Automatic buying is disabled** in the supplied configuration (`buyEnabled: false`). Running `bot:live` creates real sale listings.

The selling cycle reads your collection and current listings, waits for average prices for all eligible card types, then selects randomly among available copies of the ten highest-valued types (including types already listed in the ranking). It starts 10-minute auctions at a random amount from 90% to 100% of the historical average and respects the concurrent-listing limit returned by WikiMasters. It checks the account again immediately before listing. Missing prices, session errors, and ambiguous write results stop or delay sales rather than triggering blind retries.

### Set up and run

Requirements: Node.js 20+, Chrome with the extension installed, and a signed-in WikiMasters session. The bot has been exercised on macOS with Chrome; other platforms need local verification.

```sh
npm ci
npm run bot:setup
```

`bot:setup` generates a random token in `automation/bridge-token.json`, writes `bot-token.js` for the extension, and creates `automation/exclusions.local.txt` if needed. These local files are ignored by Git. **Reload the extension in Chrome after setup.**

Test the connection without transactions:

```sh
npm run bot:dry
```

After confirming that you are authorized and have reviewed the cards that may be sold, start real listings:

```sh
npm run bot:live
```

Press **Ctrl+C** in that terminal to stop. On macOS, the launcher uses `caffeinate` to prevent idle sleep while it runs. The computer must still remain powered on, connected, and signed in to WikiMasters. See [BOT.md](BOT.md) for operation, error handling, email notifications, and advanced configuration.

### Keep specific cards

Edit `automation/exclusions.local.txt` and put **one exact WikiMasters card title per line**:

```text
# Cards I want to keep
Ada Lovelace
Grace Hopper
```

Titles are matched without regard to case or repeated whitespace. A card-model UUID also works. The bot rereads this file on every sale cycle and immediately before creating a listing, so edits do not require a restart. If a title is unavailable from the API while title exclusions are active, that card is not listed. **Adding a card does not cancel an auction that is already live.** For a particular copy, use `excludedCopyIds` in a private `automation/config.local.json` based on `automation/config.example.json` and restart the bot.

## Privacy and security

- The extension runs on `www.wiki-masters.com`. Its optional bot bridge listens only on `127.0.0.1:17887` and requires a locally generated random token.
- The bot uses the browser session; it does not request or store your WikiMasters password.
- Average prices and timing samples are stored locally in the browser. Bot state and configuration remain on your computer.
- **Never commit or share** `bot-token.js`, `automation/bridge-token.json`, `automation/config.local.json`, `automation/exclusions.local.txt`, `.wmma-bot/`, or SMTP credentials. All are covered by `.gitignore`.
- Email notifications are off by default and require your own SMTP settings.

See the [French PDF guide](docs/guide-fr.pdf) for a concise walkthrough.

## Development

```sh
npm ci
npm test
```

The extension uses plain JavaScript and Manifest V3; there is no build step. The local bot requires the `ws` package. This repository has no server, analytics endpoint, or remote telemetry.
