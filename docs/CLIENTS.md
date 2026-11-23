# Chat clients: how you talk to your data from inside the game

Research, not a committed build. The MCP surface (`docs/MCP-PLAN.md`) makes the data
*askable*; this document is about **where the asking happens** — in-game, on a phone, on the
desktop beside the game — and which of those surfaces is worth building first.

The one decision that matters is stated up front in
[The privacy fork](#the-privacy-fork): one of these options sends your questions and Claude's
answers off the machine, and one keeps them on it. Everything else is cost and convenience.

## The shape they all share

None of these is a new data source. They are **frontends of one agent-side "chat brain"**: Claude,
with the Portalstone MCP tools (`docs/MCP-PLAN.md`) attached, running in the agent process — which
already runs as an always-on Windows service (`docs/SERVICE.md`). The brain is built once and is
transport-agnostic; a client is a thin thing that carries text to it and renders text back.

    sensor addon → SavedVariables → core/store → MCP tools → Claude (the brain) → ⟨a client⟩

Because the brain holds the Claude call, the API key never ships to a phone or an overlay, and the
same backend serves every client. This is the deferred `StreamableHTTPServerTransport` seam the MCP
plan already names: the clients below are what ride on it.

## The hard constraint that rules out the obvious idea

A WoW addon cannot be the chat window. It runs in a locked Lua 5.1 sandbox: no sockets, no HTTP, no
arbitrary file read/write; its only persistence is SavedVariables, **written** at
logout/`/reload`/exit and **read back only once**, at `ADDON_LOADED`. There is no API to re-read a
file mid-session. So an addon cannot receive live external text — every round-trip would cost a
`/reload` (a full UI rebuild), and there is a credible report that WoW: Forever writes SavedVariables
on logout but does not read them back at login, which may break even that channel on this server.

Conclusion: the chat surface lives **outside** the game sandbox. The question is only which outside.

## The candidates

| option | in-game | mobile | cross-platform | build cost | keeps data local |
| --- | --- | --- | --- | --- | --- |
| **Discord bot** | yes (Discord's overlay) | free (Discord app) | free | very low | **no** |
| **Web page (agent-served)** | no (alt-tab / 2nd monitor) | free (phone browser, LAN) | free | low | yes |
| **Tauri overlay** | yes (own window) | yes (Tauri mobile) | yes (fiddly on macOS) | medium | yes |
| **egui native overlay** | yes | no real mobile story | desktop only | medium | yes |
| **In-game addon** | — | — | — | — | ruled out above |

### Discord bot — the cheapest path to everything you asked for

You cannot inject your own UI into Discord's overlay (no public API; anything that did would look
like injection to anti-cheat/AV). You don't need to. The overlay already renders **Discord DMs and
lets you reply to them in-game**. So the chat *is* a Discord bot the agent runs: you DM it, it asks
the brain, it replies in the DM; in-game you open the overlay (Shift+`` ` ``), type, read.

Discord has already solved every hard part a home-grown overlay fights — always-on-top,
click-through, and fullscreen (its overlay hooks the swapchain, so it works even in exclusive
fullscreen, which an external window of ours cannot). For near-zero overlay code you get in-game
chat, a **free mobile remote** (the Discord phone app), cross-platform desktop, and a host that is
already running.

Caveats:

- **Bot account, not self-bot.** Create an application in the Developer Portal and use its bot
  token. Automating your own user account ("self-bot") is bannable. Easy to do correctly.
- **Overlay replies are plain text only.** Slash commands/stickers/GIFs can be *received* in the
  overlay but not *sent* from it, and the recent overlay revamp moved quick-reply into the
  notification window. Design the bot around plain DM messages; keep slash commands for the full
  Discord window and mobile, where they work well.
- **"Everyone uses it" is mostly your own multi-device convenience, not a guild product.** Each
  player's data lives on their own PC, so a shared-guild bot would need every user running their own
  agent. Single user across devices: excellent. Many users in one server: hard.

### Web page served by the agent — the local-first baseline

The agent already serves a local UI on `127.0.0.1:48120`. A chat page there is reachable from a
browser on the same machine and from a phone over the LAN (or a Tailscale/tunnel). No native code,
nothing leaves the machine, and it is the same frontend a Tauri shell would later wrap. It is not
*in* the game — you alt-tab or use a second monitor — but it is the cheapest surface that honours the
privacy posture, and it validates the whole brain-and-transport loop before any overlay exists.

### Tauri overlay — the local-first in-game surface

A transparent, always-on-top window (Tauri 2, OS webview — ~5–10 MB, a fraction of Electron's RAM)
wrapping the same web frontend. Right pick **over egui specifically because of the mobile want**:
Tauri 2 ships iOS/Android targets and reuses the web frontend, whereas egui's "runs everywhere" is a
WASM canvas with no real mobile-app story. egui is lighter and has first-class selective
click-through, and would win **if this were a desktop-only HUD** — but it isn't.

Performance is the wrong worry here: a chat panel updates on message, not every frame; the webview is
overkill-fast for text. The real gotchas are window behaviour, not frame cost:

- **Exclusive fullscreen kills all external overlays.** Independent of stack. Run WoW in **windowed
  (fullscreen) / borderless** or nothing draws over it. Decide this first.
- **Click-through:** whole-window toggle is built in; per-region needs `tauri-plugin-polygon` or
  Win32 `WS_EX_LAYERED | WS_EX_TRANSPARENT`. A chat rectangle probably only needs the simple toggle.
- **macOS is the fiddly 10%:** fullscreen spaces isolate windows; drawing over them needs
  `tauri-nspanel`. Windows and Linux are easy.

## The privacy fork

This is the decision; the rest is detail.

Portalstone's contract (README) is *"nothing leaves the machine unless you explicitly share a
coarsened summary."* A **Discord bot breaks that**: your questions and Claude's answers — which will
carry SavedVariables-derived data (gold, gear, specs) — transit Discord's servers (US cloud, logged,
retained). For a solo private-server player that may be perfectly acceptable, but it is a real
reversal of the design, not a footnote. It can be softened (bot sends coarsened answers; raw data
stays local) but the conversation itself still leaves the box.

The **web and Tauri surfaces keep everything local.** That is their reason to exist over Discord, and
the reason to keep the brain transport-agnostic rather than wiring it to Discord alone.

## Recommended order

1. **Build the agent-side chat brain once** — Claude + the Portalstone MCP tools, behind a transport
   the clients share (the MCP plan's deferred HTTP transport). Every client below is thin after this.
2. **Discord bot as frontend #1.** Highest leverage for the stated wants — in-game + mobile +
   cross-platform — at near-zero overlay cost, *if* the privacy tradeoff is acceptable to you.
3. **Agent-served web chat page** in parallel or next — the local-first baseline, phone-over-LAN for
   free, and the frontend a Tauri shell reuses.
4. **Tauri overlay** only if the Discord privacy tradeoff bothers you enough to want a fully-local
   in-game surface. This reorders Tauri from "the plan" to "the local-first fallback" — the right
   call given the goals.

egui and the in-game addon are not on this path: egui trades away the mobile/web reuse the goals
need, and the addon is ruled out by the sandbox.

## Sources

- Discord overlay messages/replies — <https://support.discord.com/hc/en-us/articles/217659737>
- Discord overlay text chat & notifications — <https://discord.com/blog/discord-overlay-text-chat-performance-boost-and-notifications>
- Discord overlay revamp (reply via notification window) — <https://www.techradar.com/computing/software/discords-game-overlay-has-seen-a-complete-revamp-ive-tried-it-and-its-one-of-the-best-updates-ever>
- Discord self-bots policy (use a bot account) — <https://support.discord.com/hc/articles/115002192352>
- WoW saved variables (write/read cadence) — <https://warcraft.wiki.gg/wiki/Saved_variables>
- WoW addon sandbox (no network/filesystem) — <https://wow-midnight-addon-template.vercel.app/security/>
- Tauri v2 mobile (iOS/Android) support — <https://v2.tauri.app/blog/tauri-2-0-0-beta/>
- Tauri overlay / click-through in practice — <https://dev.to/manasightgg/why-i-chose-tauri-v2-for-a-desktop-overlay-in-2026-597h>
- Tauri always-on-top over fullscreen (macOS) — <https://github.com/tauri-apps/tauri/issues/9557>
