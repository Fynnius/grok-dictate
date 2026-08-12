# Grok Dictate

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![macOS 14+ arm64](https://img.shields.io/badge/macOS-14%2B%20Apple%20Silicon-black)](#requirements)
[![Release](https://img.shields.io/github/v/release/Fynnius/grok-dictate?include_prereleases)](https://github.com/Fynnius/grok-dictate/releases/latest)
[![CI](https://github.com/Fynnius/grok-dictate/actions/workflows/ci.yml/badge.svg)](https://github.com/Fynnius/grok-dictate/actions/workflows/ci.yml)

Hold `Fn`, speak, release — the transcript is typed into whatever app has focus.

Unofficial menu-bar dictation for macOS, using the public [xAI streaming speech-to-text API](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text) with **your** API key. Not affiliated with, endorsed by, or sponsored by xAI.

<p align="center">
  <img src="docs/demo.gif" alt="Hold Fn to dictate — the transcript is typed at the cursor" width="800" />
</p>

|                      |                                                            |
| -------------------- | ---------------------------------------------------------- |
| `Fn` (hold)          | push-to-talk                                               |
| `Fn` + `Space`       | hands-free toggle                                          |
| `Ctrl` + `Cmd` + `V` | re-insert the last transcript wherever you are now pointed |
| `Esc`                | cancel a recording                                         |

**The clipboard is never written automatically.** Insertion goes Accessibility API → Unicode injection, then stops. `Ctrl+Cmd+V` re-runs that ladder against an in-memory buffer; it is not a paste. The pasteboard is touched only when you click **Copy**.

## Requirements

- macOS on Apple Silicon
- Node.js 20 or newer (to build from source)
- An [xAI API key](https://console.x.ai/team/default/api-keys), **or** a logged-in [Grok CLI](https://docs.x.ai)
- Microphone, Accessibility, and Input Monitoring permissions

## Install

### Download (Apple Silicon)

1. Get an [xAI API key](https://console.x.ai/team/default/api-keys). Streaming STT is **$0.20 / hour** ([pricing](https://docs.x.ai/docs/models#pricing)).
2. Download `grok-dictate-0.1.0-mac-arm64.zip` from the [latest release](https://github.com/Fynnius/grok-dictate/releases/latest).
3. Unzip and drag `Grok Dictate.app` to `/Applications`, then double-click it.

On macOS Sequoia and later you will see **“Grok Dictate Not Opened”** with only **Move to Trash** and **Done**. Click **Done**, then:

**System Settings → Privacy & Security → Open Anyway**

That is Apple’s supported path for an app that is not Developer ID signed and notarized. After the first exception, double-clicking works. Details: [docs/permissions.md](docs/permissions.md).

On first launch a **Sign in** window opens. Paste the API key. If you already use the Grok CLI, Grok Dictate can reuse that login and skip the window.

### From source

```bash
git clone https://github.com/Fynnius/grok-dictate.git
cd grok-dictate
npm install
./native/build.sh
npm run package
open -a "Grok Dictate"
```

`npm run package` builds the Swift helper, bundles the app, ad-hoc signs it, and copies it to `~/Applications/Grok Dictate.app`.

### Development

```bash
npm install
./native/build.sh
npm run dev
```

```bash
npm test        # Vitest — no Electron or network needed
npm run lint    # ESLint + Prettier
npm run typecheck
./native/test.sh
```

## First-run permissions

A packaged `.app` is its own TCC identity. Grant these once under **System Settings → Privacy & Security**:

1. **Microphone** — the orange indicator only appears while you are actually recording
2. **Accessibility** — so the helper can type into the frontmost app
3. **Input Monitoring** — so `Fn` can be detected globally

If `Fn` does nothing, the menu bar says so and offers a shortcut to the Accessibility pane. Details and a reset command: [docs/permissions.md](docs/permissions.md).

## How auth works

1. An API key you paste in the Sign in window (stored via Electron `safeStorage` / Keychain)
2. The `XAI_API_KEY` environment variable (useful for `npm run dev`)
3. A valid Grok CLI token in `~/.grok/auth.json`

Grok Dictate **never refreshes** a Grok CLI token. Doing that from a second client can invalidate the CLI login. If the CLI token expires, paste an API key or run `grok` in a terminal.

The token is never logged, never written to history, and never sent to the Swift helper.

## Privacy

- Audio is streamed to xAI only while you hold the dictation key (or until you end a hands-free turn)
- Transcripts are stored locally, searchable, and expire according to your retention setting
- Nothing is written to the system clipboard unless you click **Copy**
- Secure Input (password fields, `sudo`) blocks insertion and is named in the menu bar

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ Electron main                                            │
│   state/machine.ts     pure reducer, effects as data     │
│   state/orchestrator   interprets effects against ports  │
└──────────────────────────────┬───────────────────────────┘
                               │
   ┌──────────────┬────────────┴───┬──────────────┬────────┐
   │ native/      │ audio/ + stt/  │ hud/ tray/   │ history│
   │ Swift helper │ mic + xAI ws   │ windows      │ config │
   └──────────────┴────────────────┴──────────────┴────────┘
```

The dictation round-trip is a pure state machine that returns side effects as data, so it is testable without Electron, a microphone, or a socket. Everything crossing a boundary goes through a port in `contracts/`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

Grok Dictate is an **unofficial**, independently developed macOS app. It is **not** affiliated with, endorsed by, or sponsored by xAI. “Grok” and “xAI” are trademarks of xAI ([brand guidelines](https://x.ai/legal/brand-guidelines)). You use the public [Speech-to-Text API](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text) with **your** key and are responsible for the [xAI terms](https://x.ai/legal/terms-of-service) and [acceptable use policy](https://x.ai/legal/acceptable-use-policy).

This repo does not ship xAI logos. Apple Silicon only. Electron, yes — the menu-bar and insertion logic is small; Chromium is the rest.

## License

[MIT](LICENSE)
