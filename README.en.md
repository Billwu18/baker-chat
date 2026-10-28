# BAKER Chat

> A **LAN-only**, end-to-end encrypted chat client: UDP multicast discovery + direct TCP,
> no server in the middle. The UI is a **personal, study-purpose** recreation of the
> "Baker" interface from *Arknights: Endfield*.
>
> **This is an unofficial fan project. It is not affiliated with, authorised by, endorsed by,
> or sponsored by Hypergryph. This repository contains no game artwork and no game fonts.**
> See [Legal notice](#legal-notice).

[中文](README.md) · [Crypto design](docs/加密与身份.md) · [Network surface](docs/网络与暴露面.md) · [Adding assets](src/assets/README.md)

![BAKER Chat](docs/screenshots/main.jpg)

---

## What it is

How do two machines on the same LAN exchange messages without any server?

- **Discovery** — every 3 seconds a beacon goes out on multicast group `239.255.66.66`,
  carrying the peer id, TCP port and a short self-introduction.
- **Connection** — on receiving a beacon, dial the peer's TCP port directly and handshake.
- **Sync** — every message is a **signed event** appended to `events.log`. All state
  (sessions, friends, unread counts, reactions) is **folded** from that log.
- **Encryption** — Ed25519 identity plus X25519 key agreement; message bodies are sealed
  with AES-GCM and the session key is wrapped per member in a signed envelope.

No server, no public exposure, no accounts. Open it on two machines behind the same
Wi-Fi and they see each other.

## Features

- Direct and group chats, stickers, images, files, quote-replies, `@` mentions,
  reactions, recall, search
- End-to-end encryption with AAD binding session + sender + recipient + version + sequence;
  replays are dropped
- Offline catch-up (set-difference sync), reconnect, every device keeps a full log
- Native Windows toast notifications — click one to jump to that message
- Unread counters, pinning, mute, drafts, day dividers, message grouping
- Keyboard-first: `Enter` sends, `Shift+Enter` newline, `Esc` closes panels, `Ctrl/Cmd+K` searches

## Getting started

Requires Node 20+, Rust 1.90+, and WebView2 on Windows (preinstalled on Windows 11).

```bash
npm install
npm run dev            # UI in a browser (no P2P, just the interface)
npm run desktop:dev    # desktop shell with real P2P
```

Build:

```bash
npm run build          # typecheck + vite build
npm run desktop:build  # tauri build (release)
```

> **It compiles without assets.** Avatars, stickers and fonts are simply skipped and the
> UI leaves those spots empty. To supply your own, read
> [src/assets/README.md](src/assets/README.md).

## Verification

Tests are not decoration here — every security-relevant change is guarded by a
**mutation test** (break the source, watch a test go red).

```bash
npm test               # 23 checks: typecheck, 7 self-test suites, 2 guards, cargo check + test
npm run test:mutation  # 64 mutations, each rewrites source and restores it byte-for-byte
```

## Layout

```
src/                  frontend (React 19 + TypeScript)
  p2p/                events, log, fold, HLC, node, Tauri bridge
  crypto/             identity, keys, envelopes, sessions
  transport/          the layer that binds p2p to the UI
  store/              state and actions
  components/         UI
  assets/             asset registry (images are not shipped)
src-tauri/            Rust: multicast discovery, TCP, frame routing, notifications
tools/                self-tests, mutation runner, packaging
docs/                 crypto and network design notes (Chinese)
```

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
For security issues please follow [SECURITY.md](SECURITY.md) and report privately.

---

## Known issues

Known, deliberately unfixed for now — listed here so you don't have to debug them:

1. **Quote replies leak plaintext.** Message bodies are sealed in `cipher`, but
   `replyTo.excerpt` (the quoted message's text, up to 200 chars) and `mentions` live in
   the event body: they end up in `events.log` and in every sync frame. Fixing this means
   moving them into the encrypted JSON — a wire-format change.
2. **The event log is plaintext on disk.** Text and key envelopes are encrypted, but who
   talked to whom and when, session membership, and file names are readable. The threat
   model is "someone else on the LAN", not "someone who can read your disk".
3. **Clock skew is tolerated up to 365 days.** A peer whose clock is a year off will drag
   our HLC to that position, and every message we send afterwards carries a future
   timestamp. This bound should be minutes, not a year.
4. **"Today / Yesterday" labels don't refresh across midnight** until the next render.
5. **Windows only.** `src-tauri/icons/icon.icns` is a placeholder; macOS needs a real icon
   set before it will build.

---

## Legal notice

> This applies to the code, docs and releases in this repository.

### 1. Relationship to the game's rights holders

This project is a **personal, study-purpose recreation** of the "BAKER" interface from
*Arknights: Endfield* (copyright holder: Hypergryph). It is **not affiliated with,
authorised by, endorsed by, or sponsored by** Hypergryph or its affiliates. "BAKER" here
refers to the name of an in-game interface; this project is **not** part of that game and
is **not** an official or unofficial client for it.

### 2. No game assets are included

This repository contains **no** game artwork, fonts, audio, text or data files. All UI
art (avatars, emoji, stickers, icons, decorations, masks, backgrounds) and all fonts
(HarmonyOS Sans SC etc.) have been **removed** — see [NOTICE.md](NOTICE.md).

The two images that remain are **self-drawn 1×1 placeholders**, and the app icon is a
**neutral icon drawn for this project**. Neither derives from the game.

### 3. On "personal study, research or appreciation"

Article 24(1)(i) of the *Copyright Law of the People's Republic of China* (2020 amendment)
permits use of a published work without authorisation "for the purpose of personal study,
research or appreciation".

**That exception is personal-use only and does not cover public distribution.** Therefore:

- What this project publishes under MIT is **code only**, with no protected expressive assets;
- If you add assets yourself, **you are responsible for them** — redistributing them publicly
  may constitute infringement;
- Deploying this project as a publicly reachable service may itself expose you to claims
  about the interface's appearance.

### 4. A game UI can itself be a protected work

Chinese courts have held that a game's UI can qualify as an **artistic work** where it is
sufficiently original. See, for example, Shaanxi (2023) 陕0116民初349号 — the court found a
mini-program's UI to be an artistic work and found the accused game's UI substantially similar.

That is precisely why this repository **ships no UI assets**: code can be open-sourced,
someone else's artwork cannot.

### 5. Names, icons and confusion

Article 7 of the *Anti-Unfair Competition Law of the PRC* (2025 revision, effective
2025-10-15) prohibits using another party's influential product name, trade dress, or
"application name or icon" in a way that is likely to confuse consumers.

Accordingly:

- This project does **not** use the game's official logo, app icon, or promotional art;
- This project must **not** be used commercially, nor to imply any affiliation with Hypergryph;
- If you fork and redistribute it, keep this notice and **do not** use a name or icon that
  could be mistaken for an official product.

### 6. Infringement and our standing practice

Article 53 of the Copyright Law provides civil, administrative and (where applicable)
criminal liability for unauthorised reproduction, distribution or communication to the
public of protected works.

The authors have made reasonable efforts to exclude third-party material.
**If you believe something here infringes your rights**, contact us via an issue or the
maintainer e-mail listed on the repository, identify the file and the basis of your claim,
and we will **remove it promptly** — no legal process required first.

### 7. Disclaimer of warranty

This project is provided "**as is**", without warranty of any kind, express or implied,
under the MIT license. You are solely responsible for your use of it.

### 8. Credits

- Early UI reconstruction referenced the asset-organisation approach of the open-source
  project [baker-dx](https://github.com/Wanye-7300/baker-dx); neither repository ships
  game assets.
- *Arknights: Endfield* and all of its art, text and music are the property of **Hypergryph**.
- If a rights holder would like a name or visual changed, contact us and we will cooperate.

---

## License

Code and documentation: [MIT](LICENSE). Third-party assets are **not** covered by that
license — none are included in this repository.
