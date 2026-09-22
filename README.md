# Crypto Screener — Market Intelligence Suite ("TradeSphere")

A self-hosted, entirely client-side suite of static HTML tools for crypto futures trading,
portfolio tracking, and macro market monitoring — no backend, no build step, no login. Runs
directly from the filesystem, from any static host (e.g. GitHub Pages), or packaged as a native
Android app via [Capacitor](https://capacitorjs.com).

`index.html` is the shell: a persistent icon sidebar that lazy-loads each tool into its own
`<iframe>`, so every page's code stays isolated and network calls only fire once a tool is
actually opened.

## What's inside

**Trading & screening**
- **Screener** (`screener.html`) — Binance USDT-M futures screener combining Ichimoku
  cloud breakouts with a full ICT/Smart Money Concepts toolkit (FVGs, liquidity sweeps,
  BOS/CHoCH, order blocks, and more)
- **Position Sizing** (`position-sizing.html`) — risk-based position size calculator with live
  prices
- **Watchlist** (`watchlist.html`) — tracked coins with technical analysis
- **DeFi & TVL** (`defi.html`)

**Portfolio**
- **Meridian** (`portfolio.html`) — crypto/stock portfolio tracker with P&L, trade history, and
  fee-aware accounting

**Macro & markets**
- **Riskline** (`macro.html`) — macro financial indices most relevant to crypto
- **ETF Flows**, **Oil & Energy**, **Fear & Greed Index**, **BTC Returns**, **Season Index**,
  **Long/Short & Liquidations**

**News & sentiment**
- **Crypto News**, **Market Calendar** (+ Craft Calendar sub-view), **Whale & Social Pulse**,
  **Prediction Markets**, **Trump's Truth Social**, **Crypto YouTube**

**Settings**
- **Trading Settings** (`trading-settings.html`) — shared preferences across the suite

Two mirrored copies of every page are kept in sync: `www/` (source of truth, feeds the Android
build) and `docs/` (served via GitHub Pages). Run `npm run pages` after editing `www/` to copy
changes across.

## Also in this repo

- **Android app** (`android/`, `capacitor.config.ts`) — wraps the suite as an installable APK.
  See "Building the Android app" below.
- **Portfolio import tool** — a separate standalone HTML utility (not part of the main suite)
  that converts CoinDCX futures trade exports into Meridian's portfolio import JSON format.

---

## Building the Android app

### Prerequisites
- [Node.js](https://nodejs.org) 18+
- [Android Studio](https://developer.android.com/studio) (includes the Android SDK)
- JDK 17 (bundled with Android Studio)

### Steps
```bash
git clone <your-repo-url> crypto-screener-app
cd crypto-screener-app
npm install
npx cap sync android      # re-run any time www/ changes
npx cap open android
```
Then in Android Studio: **Run ▶** with a device/emulator connected, or
**Build → Generate Signed Bundle / APK** for an installable `.apk`.

Fastest path without the Android Studio UI:
```bash
cd android && ./gradlew assembleDebug
# APK at android/app/build/outputs/apk/debug/app-debug.apk
```

## Using it as a website instead

The whole suite is static HTML with no backend dependency, so an Android build isn't required.
Host the `docs/` folder (e.g. GitHub Pages: **Settings → Pages → Deploy from branch → `main` /
`docs`**), then on your phone open the URL in Chrome and use **⋮ → "Add to Home screen"** for an
app-like icon — no build step needed, but it requires the site to stay hosted.

## Making changes

Every page is plain HTML/CSS/vanilla JS — no framework, no bundler. Edit the file directly under
`www/`, run `npm run pages` to mirror it into `docs/`, then `npx cap sync android` if the Android
app needs the update too.

## Key constraints to keep in mind

- Runs under `file://`, which blocks cross-file `<iframe>` loading in Chromium — cross-page
  embedding must be done as in-page merges or `postMessage`, not iframes to separate local files.
- Binance's API is blocked on GitHub Actions runners (HTTP 451) — server-side jobs route through
  CoinGlass or another intermediary instead.
- All network calls are plain HTTPS to public market-data APIs (Binance, CoinGecko, CoinGlass,
  etc.) — no API keys or login required anywhere in the suite.

## App ID / branding

- **App ID**: `com.cryptoscreener.ichimoku` (set in `capacitor.config.ts` and
  `android/app/build.gradle`) — change before publishing, and rename the matching Java package
  folder under `android/app/src/main/java/` if you do.
- **Icon/splash**: currently Capacitor defaults — swap files under
  `android/app/src/main/res/mipmap-*/` or use
  [`@capacitor/assets`](https://github.com/ionic-team/capacitor-assets) for custom branding.
