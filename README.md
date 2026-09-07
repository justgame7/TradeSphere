# Crypto Screener — Android App

A native Android app (via [Capacitor](https://capacitorjs.com)) combining two standalone tools
behind a single sidebar menu, entirely client-side — no backend, no API key, no login.

- **☁️ Screener - Ichimoku** — Ichimoku breakout screener across all Binance USDT-M perpetual
  futures (see conditions below)
- **🧮 Position Sizing** — risk-based position size / quantity calculator, live prices via
  CoinGecko

Tap the ☰ menu (top-left) to switch between the two. Each runs in its own isolated `<iframe>`,
so their code never collides, and the second tool's network calls only fire once you actually
open it (lazy-loaded).

## Project structure

```
crypto-screener-app/
├── www/
│   ├── index.html            # the shell: top bar + sidebar drawer + iframes (edit for nav/branding)
│   ├── screener.html         # Ichimoku breakout screener (Binance Futures API)
│   └── position-sizing.html  # Position sizing calculator (CoinGecko API)
├── docs/                     # mirror of www/, used for GitHub Pages hosting (see below)
├── android/                  # generated native Android project (Capacitor)
├── capacitor.config.ts       # app id, name, web dir
├── package.json
└── README.md
```

## Ichimoku Screener — what it detects

Two independent breakout signals, checked in both directions (long and short):

- **CK — Chikou Breakout**: the lagging span (Chikou) crosses its own cloud (the cloud drawn
  at the position the Chikou line is plotted, i.e. `kijunLen` bars back).
- **PK — Price/Kumo Breakout**: price itself crosses the current bar's cloud.

**Rule used throughout:** the Chikou line is always compared against *its own* cloud (26 bars
back); price is always compared against the *current* bar's cloud.

**Breakout column** shows `CK`, `PK`, or `CK, PK` (when both fire the same day) — only when
*all* conditions for that signal are fully met. **Setup column** shows `Long` or `Short`, only
when at least one of CK/PK is fully confirmed.

Universe: Binance **USDT-margined perpetual futures only** (USDC and delivery/quarterly
contracts excluded).

## Position Sizing — what it does

Enter portfolio value, risk %, pick a coin (or any CoinGecko id), fetch its live price, and set
a stop loss — it returns quantity, position size, stop distance %, % of portfolio, and flags
when the sized position implies leverage above 1×.

---

## Option A — Build the APK yourself (recommended, full control)

### Prerequisites
- [Node.js](https://nodejs.org) 18+
- [Android Studio](https://developer.android.com/studio) (includes the Android SDK)
- JDK 17 (Android Studio bundles one — you generally don't need to install separately)

### Steps

```bash
# 1. Clone this repo
git clone <your-repo-url> crypto-screener-app
cd crypto-screener-app

# 2. Install dependencies
npm install

# 3. Sync web assets into the Android project (run this again any time you edit www/index.html)
npx cap sync android

# 4. Open in Android Studio
npx cap open android
```

Once Android Studio finishes indexing/Gradle sync:
- Click **Run ▶** with a device/emulator connected to install and launch it directly, **or**
- Go to **Build → Generate Signed Bundle / APK → APK** to produce an installable `.apk` you can
  copy to your phone.

### Fastest path if you just want an APK without opening Android Studio's UI

```bash
cd android
./gradlew assembleDebug
```

The unsigned debug APK will be at:
`android/app/build/outputs/apk/debug/app-debug.apk`

Copy that file to your phone (e.g. via USB, Google Drive, or `adb push`) and install it —
you'll need to allow "install from unknown sources" for whichever app you use to open it.

```bash
# Or install directly over USB with a device connected + USB debugging enabled:
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Option B — Skip Android Studio entirely, just use it as a website

Since the whole app is static HTML with zero backend dependencies, you don't strictly need an
Android app at all.

### Hosting on GitHub Pages

GitHub Pages needs an `index.html` at the **root** of whatever folder it serves — but this
repo's actual app lives in `www/`, which Pages won't look inside by default (that's why you'll
see your `README.md` rendered instead of the app if you just point Pages at the repo root
without configuration).

This repo includes a `docs/` folder — a mirror of `www/` — set up specifically for this:

1. On GitHub: **Settings → Pages → Build and deployment → Source: "Deploy from a branch"**
2. **Branch: `main`, folder: `/docs`** → Save
3. Your app will be live at `https://<your-username>.github.io/<repo-name>/` within a minute or two

**Keeping `docs/` in sync:** whenever you edit anything in `www/`, run:
```bash
npm run pages
```
before committing/pushing — this copies the three HTML files from `www/` into `docs/` so what's
live on Pages matches what's in the Android app.

### Add to your phone's home screen

Once hosted, open the Pages URL in Chrome on your Android phone → menu (⋮) →
**"Add to Home screen"** — gives you a home-screen icon that opens full-screen like an app, no
Android Studio/Gradle build needed. The tradeoff: it's a shortcut to a website rather than an
actual installed APK, so it needs the site to stay hosted to keep working.

This gives you a home-screen icon that opens full-screen like an app, with none of the
Android-Studio/Gradle build steps above. The tradeoff: it's a shortcut to a website rather than an
actual installed APK, so it needs the site to still be hosted somewhere to keep working.

---

## Making changes

Each page is plain HTML/CSS/vanilla JS — no build step, no framework:
- Edit `www/screener.html` for the Ichimoku screener's logic/UI
- Edit `www/position-sizing.html` for the position sizing calculator
- Edit `www/index.html` for the sidebar/navigation/branding shell

After editing, re-run:

```bash
npx cap sync android
```

then re-build/re-run in Android Studio (or `./gradlew assembleDebug` again).

## Notes

- **Network access**: the screener calls Binance's public Futures API (`fapi.binance.com` and
  its official mirrors); the position sizer calls CoinGecko's public API. Both are plain HTTPS,
  no API key or login required, since both only read public market data.
- **App ID**: `com.cryptoscreener.ichimoku` — change this in `capacitor.config.ts` (and
  `android/app/build.gradle`'s `applicationId`) before publishing anywhere, if you want your own
  unique identifier. Note that changing it after the Android project was generated also requires
  renaming the Java package folder under `android/app/src/main/java/` to match.
- **Icon/splash screen**: currently the Capacitor default placeholder. Swap out
  `android/app/src/main/res/mipmap-*/ic_launcher*.png` if you want custom branding — or use
  [`@capacitor/assets`](https://github.com/ionic-team/capacitor-assets) to generate a full set
  from one source image.
