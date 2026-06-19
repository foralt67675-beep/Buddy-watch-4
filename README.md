# 🎬 Buddy Watch

Watch anything together, in real time, with a friend — **100% free, no credit card, no account.**

- 📡 **Peer-to-peer** — video & chat flow directly between you and your friend, never through a paid server
- 📂 **Local files** — each of you plays your own copy from disk → **zero buffering**, perfectly synced
- 🖥️ **Screen share** — stream literally anything (works for streaming sites, games, anything on screen)
- 🌐 **Direct video URLs** — paste a `.mp4` / `.webm` / `.m3u8` link
- 💬 **Chat + stickers** — react in real time
- ⏱️ **Smart sync** — play/pause/seek are shared, plus continuous drift-correction keeps you in lock-step

---

## How it works (the no-cost secret)

This app uses **WebRTC** (via the free [PeerJS](https://peerjs.com) library) to connect two browsers **directly to each other**. The only server involved is PeerJS's free public **broker**, and it does nothing except help the two browsers find each other for a few seconds during connection (called *signaling*). After that, all video, audio, chat, and stickers travel **peer-to-peer** — no bandwidth bills, no hosting costs.

For local files specifically, **nothing is uploaded at all** — each person plays their own copy of the file from their own disk, and only tiny sync commands (play/pause/seek) are sent over the connection. That's why local-file playback is perfectly smooth with no buffering.

The only external dependency that touches a server is **Google's free STUN service**, which helps your routers figure out how to reach each other. It's free and requires no key.

---

## 🚀 Deploy to GitHub Pages (free, ~2 minutes)

1. Create a free [GitHub](https://github.com) account (if you don't have one).
2. Create a **new repository** (e.g. `buddy-watch`). Set it to **Public**.
3. Upload all files from this folder (`index.html`, `styles.css`, the `js/` folder, and the `.github/` folder) to the repo. You can drag-and-drop them on the GitHub web UI.
4. Go to **Settings → Pages**.
5. Under **Build and deployment → Source**, choose **GitHub Actions**.
6. Push any change (or trigger the workflow manually). The included workflow (`.github/workflows/deploy.yml`) publishes the site automatically.
7. In a minute or two you'll get a link like `https://YOUR-USERNAME.github.io/buddy-watch/`. That's your app — share it!

> The included GitHub Actions workflow means every time you push an update, the site redeploys automatically. Still 100% free.

### Alternative: Netlify / Vercel (also free, no card)
- **Netlify:** drag the folder onto [app.netlify.com/drop](https://app.netlify.com/drop). Done.
- **Vercel:** import the repo at [vercel.com/new](https://vercel.com/new). Done.

---

## 🧪 Run it locally

No build step. Just serve the folder with any static server:

```bash
# Python (already installed on most systems)
python -m http.server 8000

# or Node
npx serve .
```

Then open <http://localhost:8000>.

> To test the two-person flow on one machine, open the app in **two different browsers** (e.g. Chrome + Edge) or one normal + one incognito window. Create a room in one, paste the code in the other.

---

## 🎯 How to use it

1. **One person** clicks **Create a room** → gets a 6-character code (e.g. `K7P-2MQ`).
2. They click the code to **copy the invite link** and send it to their friend.
3. The friend opens the link (or pastes the code on the home screen) → you're connected.
4. Pick a source:
   - **📂 Open local video** — both of you load the same file from your own devices (best quality, no buffering)
   - **🌐 Play from URL** — both of you paste the same direct video link
   - **🖥️ Share my screen** — one of you streams their screen live to the other
5. Either person can play / pause / seek — it syncs to both automatically.
6. Chat and send stickers from the side panel. 😎🍿

### Keyboard shortcuts (in the room)
- `Space` / `K` — play / pause
- `←` / `→` — skip 10s back / forward
- `M` — mute / unmute
- `Esc` — close popups

---

## ⚠️ Honest limitations

- **Strict NATs:** Free STUN works for the large majority of home networks. If *both* of you are behind very restrictive firewalls (some corporate/college networks, symmetric NATs), the direct connection may fail. A paid TURN relay would fix that — which is the one thing we deliberately avoid here to keep it free. Mobile data and typical home Wi-Fi work fine.
- **Local files must be the same on both sides.** The app syncs *playback position*, not the file itself (that's what keeps it free and buffer-free). Both of you need your own copy of the movie.
- **Screen-share quality** depends on the upload speed of the person sharing and the connection between you. Local-file playback is unaffected and always smooth.
- **2 people only.** This is a cozy two-person room by design.
- **Browser support:** Use a recent Chrome, Edge, Firefox, or Safari. Screen share with system audio works best in Chrome/Edge.

---

## 🛠️ Tech

- Vanilla HTML/CSS/JS — no framework, no build step
- [PeerJS 1.5.4](https://peerjs.com) (loaded from a CDN) for WebRTC
- Google STUN servers (free, no key)
- Emoji stickers (zero asset weight, crisp at any size)

Enjoy your movie night. 🍿
