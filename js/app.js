/* ===== Buddy Watch — app logic =====
 *
 * Architecture (100% free, peer-to-peer):
 *   - PeerJS (WebRTC) connects the two browsers directly. The free public
 *     PeerJS broker is used ONLY to help them find each other (signaling);
 *     all video/chat/stickers flow peer-to-peer, never through a paid server.
 *   - Local files: each person plays their OWN copy from disk -> zero network
 *     buffering. We sync play / pause / seek + drift-correction over a data channel.
 *   - Screen share: one person's screen is streamed live over a media channel.
 *   - Chat + stickers ride on the data channel.
 *
 * Sync model: the room creator (host) is the time authority for continuous
 * drift-correction. Discrete commands (play/pause/seek/source) are bidirectional
 * so either person can control playback.
 */
(function () {
  "use strict";

  // ---------- tiny helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const state = {
    peer: null,
    conn: null,        // data connection
    call: null,        // media connection (screen share)
    isHost: false,
    roomCode: null,
    remoteStream: null,
    srcType: null,     // 'file' | 'url' | 'screen'
    sharingScreen: false,
    suppressSync: false,
    driftTimer: null,
    recentStickers: [],
    rtt: 120,          // rolling round-trip-time estimate (ms)
  };

  // ---------- toast ----------
  let toastTimer = null;
  function toast(msg, kind = "") {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast " + kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
  }

  // ---------- loading overlay (shown while a source buffers) ----------
  function showLoading(text) {
    $("#loading-text").textContent = text || "Loading…";
    $("#loading-overlay").classList.remove("hidden");
  }
  function hideLoading() {
    $("#loading-overlay").classList.add("hidden");
  }

  // ---------- time format ----------
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const mm = h ? String(m).padStart(2, "0") : String(m);
    const ss = String(sec).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // ---------- room code ----------
  function genCode() {
    // friendly, unambiguous alphabet (no 0/O/1/I)
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 6; i++) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out.slice(0, 3) + "-" + out.slice(3);
  }
  const peerIdFor = (code) => "buddywatch-" + code.toLowerCase().replace(/[^a-z0-9-]/g, "");

  // ---------- screen switching ----------
  function show(screen) {
    $("#lobby").classList.toggle("hidden", screen !== "lobby");
    $("#room").classList.toggle("hidden", screen !== "room");
  }

  // ============================================================
  //  PEER / CONNECTION
  // ============================================================
  function startHosting() {
    const code = genCode();
    state.roomCode = code;
    state.isHost = true;
    enterRoomUI(code);

    const peer = new Peer(peerIdFor(code), {
      debug: 1,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun.cloudflare.com:3478" },
        ],
      },
    });
    state.peer = peer;

    peer.on("open", () => setConnStatus("waiting", "Waiting for friend…"));
    peer.on("error", onPeerError);
    peer.on("disconnected", () => {
      setConnStatus("error", "Disconnected — reconnecting…");
      try { peer.reconnect(); } catch (e) {}
    });

    // a joiner connects -> set up data channel
    peer.on("connection", (conn) => {
      if (state.conn && state.conn.open) {
        // already have a partner; block extra connections (2-person room)
        conn.on("open", () => conn.close());
        return;
      }
      bindDataConn(conn);
    });

    // a joiner (or anyone) might call us with a screen-share stream
    peer.on("call", (call) => {
      // answer with no outgoing stream (we just want to receive)
      call.answer();
      call.on("stream", (stream) => attachRemoteStream(stream));
      call.on("close", () => detachRemoteStream());
      call.on("error", () => {});
      state.call = call;
    });
  }

  function startJoining(code) {
    code = (code || "").trim().toUpperCase();
    if (!/^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(code)) {
      toast("That doesn't look like a valid room code.", "error");
      return;
    }
    state.roomCode = code;
    state.isHost = false;
    enterRoomUI(code);
    setConnStatus("waiting", "Connecting to room…");

    // joiner uses a random peer id
    const peer = new Peer({
      debug: 1,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun.cloudflare.com:3478" },
        ],
      },
    });
    state.peer = peer;

    peer.on("open", () => {
      const conn = peer.connect(peerIdFor(code), { reliable: true });
      bindDataConn(conn);
      // give the connection a moment, then warn if it never opens
      setTimeout(() => {
        if (!state.conn || !state.conn.open) {
          setConnStatus("error", "Couldn't reach the room.");
          toast("Room not reachable. Check the code, or the host may have left.", "error");
        }
      }, 8000);
    });
    peer.on("error", onPeerError);
    peer.on("call", (call) => {
      call.answer();
      call.on("stream", (stream) => attachRemoteStream(stream));
      call.on("close", () => detachRemoteStream());
      state.call = call;
    });
  }

  function bindDataConn(conn) {
    state.conn = conn;
    conn.on("open", () => {
      setConnStatus("connected", "Connected");
      $("#peer-count").textContent = "2 online";
      toast("Friend connected! 🎉", "success");
      send({ t: "hello" });
      startDriftLoop();
      // host pushes its current playback state to the newcomer
      if (state.isHost) broadcastState();
    });
    conn.on("data", onMessage);
    conn.on("close", () => onPeerLeft("Friend left the room."));
    conn.on("error", () => onPeerLeft("Connection problem."));
  }

  function onPeerError(err) {
    const type = err && err.type;
    if (type === "peer-unavailable") {
      setConnStatus("error", "Room not found");
      toast("That room doesn't exist or the host left.", "error");
    } else if (type === "unavailable-id") {
      toast("Room code in use — creating a new one…", "error");
      // rare collision; regenerate
      if (state.isHost) setTimeout(startHosting, 600);
    } else if (type === "network" || type === "server-error" || type === "socket-error") {
      setConnStatus("error", "Network issue — retrying…");
      toast("Network hiccup with the signaling server. Retrying…", "error");
    } else {
      console.error("Peer error", err);
      toast("Connection error: " + (type || "unknown"), "error");
    }
  }

  function onPeerLeft(msg) {
    setConnStatus("error", "Friend offline");
    $("#peer-count").textContent = "1 online";
    stopDriftLoop();
    toast(msg, "error");
    detachRemoteStream();
  }

  function leaveRoom() {
    stopDriftLoop();
    try { state.conn && state.conn.close(); } catch (e) {}
    try { state.call && state.call.close(); } catch (e) {}
    try { state.peer && state.peer.destroy(); } catch (e) {}
    stopSharingScreen(true);
    // reset player
    const v = $("#player");
    v.pause();
    v.removeAttribute("src");
    v.load();
    state.peer = state.conn = state.call = null;
    state.srcType = null;
    location.hash = "";
    show("lobby");
  }

  // ============================================================
  //  MESSAGING
  // ============================================================
  function send(obj) {
    if (state.conn && state.conn.open) {
      try { state.conn.send(obj); } catch (e) {}
    }
  }

  function broadcastState() {
    const v = $("#player");
    send({
      t: "state",
      playing: !v.paused,
      time: v.currentTime,
      duration: v.duration || 0,
      srcType: state.srcType,
      src: state.srcType === "url" ? v.currentSrc || v.src : "",
      name: state.srcType === "file" ? (v.dataset.name || "") : "",
    });
  }

  function onMessage(data) {
    const v = $("#player");
    switch (data.t) {
      case "hello":
        // friend just connected; if we are host we already pushed state
        break;

      case "state":
        applyRemoteState(data);
        break;

      case "play": {
        // play at time T (account for one-way latency)
        const target = data.time + state.rtt / 2000;
        safeSeek(target, () => safePlay());
        setPlayUI(true);
        break;
      }
      case "pause": {
        safeSeek(data.time);
        safePause();
        setPlayUI(false);
        break;
      }
      case "seek":
        safeSeek(data.time);
        break;

      case "src":
        applyRemoteSrc(data);
        break;

      case "sync-req":
        send({
          t: "sync-resp",
          playing: !v.paused,
          time: v.currentTime,
          ts: data.ts,
        });
        break;

      case "sync-resp":
        handleSyncResp(data);
        break;

      case "chat":
        addChatMessage("them", data.text);
        break;

      case "sticker":
        addStickerMessage("them", data.emoji);
        break;

      case "screen-stop":
        detachRemoteStream();
        break;
    }
  }

  // ---------- remote-driven playback (no feedback loops) ----------
  function safeSeek(time, cb) {
    const v = $("#player");
    state.suppressSync = true;
    try { v.currentTime = Math.max(0, time || 0); } catch (e) {}
    if (cb) v.addEventListener("seeked", function h() {
      v.removeEventListener("seeked", h);
      state.suppressSync = false;
      cb();
    }); else {
      setTimeout(() => (state.suppressSync = false), 200);
    }
  }
  function safePlay() {
    const v = $("#player");
    state.suppressSync = true;
    v.play().catch(() => {}).finally(() => setTimeout(() => (state.suppressSync = false), 300));
  }
  function safePause() {
    const v = $("#player");
    state.suppressSync = true;
    v.pause();
    setTimeout(() => (state.suppressSync = false), 300);
  }

  function applyRemoteState(s) {
    if (s.srcType && s.srcType !== state.srcType) {
      // need to load the same source first
      if (s.srcType === "url" && s.src) {
        loadUrl(s.src, { silent: true, then: () => finishState(s) });
        return;
      }
      if (s.srcType === "file") {
        promptLoadFile(s.name);
      }
      if (s.srcType === "screen") {
        hideVideoEmpty();
      }
    }
    finishState(s);
  }
  function finishState(s) {
    const v = $("#player");
    if (s.srcType === "screen") return; // live stream, no time sync
    if (isFinite(s.time) && s.time >= 0) safeSeek(s.time);
    if (s.playing) setTimeout(() => safePlay(), 250);
    else safePause();
    setPlayUI(s.playing);
  }

  function applyRemoteSrc(d) {
    if (d.srcType === "url" && d.src) {
      loadUrl(d.src, { silent: true });
    } else if (d.srcType === "file") {
      promptLoadFile(d.name);
    } else if (d.srcType === "screen") {
      hideVideoEmpty();
      toast("Friend is sharing their screen…", "");
    }
  }

  function promptLoadFile(name) {
    showVideoEmpty(
      "📁",
      "Your friend loaded a video",
      name ? `Load “${name}” (or your own copy) to watch in sync.` : "Load your copy of the file to watch in sync."
    );
    toast("Friend loaded a local file — open yours to sync.", "");
  }

  // ============================================================
  //  DRIFT CORRECTION (only the joiner nudges toward the host)
  // ============================================================
  function startDriftLoop() {
    stopDriftLoop();
    state.driftTimer = setInterval(() => {
      if (state.isHost) return;          // host is the authority
      if (!state.conn || !state.conn.open) return;
      if (state.srcType === "screen" || !state.srcType) return;
      const v = $("#player");
      if (!v.duration) return;
      send({ t: "sync-req", ts: Date.now() });
    }, 4000);
  }
  function stopDriftLoop() {
    if (state.driftTimer) clearInterval(state.driftTimer);
    state.driftTimer = null;
  }
  function handleSyncResp(d) {
    const v = $("#player");
    if (!isFinite(d.time)) return;
    // rtt & one-way latency estimate
    const rtt = Date.now() - d.ts;
    state.rtt = state.rtt * 0.7 + Math.max(10, Math.min(2000, rtt)) * 0.3;
    const oneWay = state.rtt / 2000;
    // friend's estimated current time (advance if they're playing)
    const friendTime = d.time + (d.playing ? oneWay : 0);
    const drift = v.currentTime - friendTime;
    const adrift = Math.abs(drift);

    if (adrift > 1.5) {
      // big gap -> hard seek
      safeSeek(friendTime);
      if (d.playing) safePlay();
    } else if (adrift > 0.4) {
      // small gap -> gentle rate nudge until caught up
      v.playbackRate = drift > 0 ? 0.93 : 1.07;
    } else {
      v.playbackRate = 1.0;
    }
  }

  // ============================================================
  //  LOCAL PLAYBACK CONTROLS
  // ============================================================
  const player = $("#player");

  function togglePlay() {
    if (state.srcType === "screen" || !player.src) return;
    if (player.paused) {
      safePlay();
      setPlayUI(true);
      send({ t: "play", time: player.currentTime });
    } else {
      safePause();
      setPlayUI(false);
      send({ t: "pause", time: player.currentTime });
    }
  }
  function userSeek(time) {
    if (state.srcType === "screen") return;
    safeSeek(time);
    setPlayUI(!player.paused);
    send({ t: "seek", time });
  }

  function setPlayUI(playing) {
    $("#ctrl-play .play-icon").classList.toggle("hidden", playing);
    $("#ctrl-play .pause-icon").classList.toggle("hidden", !playing);
  }

  function refreshSeekBar() {
    if (!player.duration) return;
    const pct = (player.currentTime / player.duration) * 1000;
    if (!seekDragging) $("#ctrl-seek").value = pct;
    $("#ctrl-current").textContent = fmtTime(player.currentTime);
  }

  // ---------- sources ----------
  function loadFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    player.src = url;
    player.dataset.name = file.name;
    player.load();
    state.srcType = "file";
    hideVideoEmpty();
    setPlayUI(false);
    toast("Loaded: " + file.name, "success");
    send({ t: "src", srcType: "file", name: file.name });
  }

  function loadUrl(url, opts = {}) {
    url = (url || "").trim();
    if (!url) return;
    player.src = url;
    player.dataset.name = "";
    player.load();
    state.srcType = "url";
    hideVideoEmpty();
    setPlayUI(false);
    if (!opts.silent) toast("Playing from URL", "success");
    if (!opts.silent) send({ t: "src", srcType: "url", src: url });
    if (opts.then) player.addEventListener("loadedmetadata", opts.then, { once: true });
  }

  // ---------- screen sharing ----------
  async function shareScreen() {
    if (state.sharingScreen) { stopSharingScreen(); return; }
    if (!state.conn || !state.conn.open) {
      toast("Connect with your friend first.", "error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: true,            // system/tab audio when available
      });
      state.sharingScreen = true;
      state.srcType = "screen";
      $("#src-screen").classList.add("btn-primary");
      $("#src-screen").classList.remove("btn-ghost");

      // pause + clear local media player (we're streaming the screen instead)
      player.pause();
      showVideoEmpty("🖥️", "You're sharing your screen", "Your friend sees it live. Click “Share my screen” again to stop.");

      // call the friend with the screen stream
      state.call = state.peer.call(state.conn.peer, stream);
      state.call.on("close", () => {});
      send({ t: "src", srcType: "screen" });

      // when user stops via browser UI
      stream.getVideoTracks()[0].addEventListener("ended", () => stopSharingScreen());
    } catch (e) {
      state.sharingScreen = false;
      if (e.name !== "NotAllowedError") toast("Couldn't start screen share.", "error");
    }
  }
  function stopSharingScreen(silent) {
    if (!state.sharingScreen) return;
    state.sharingScreen = false;
    if (state.call) { try { state.call.close(); } catch (e) {} state.call = null; }
    $("#src-screen").classList.remove("btn-primary");
    $("#src-screen").classList.add("btn-ghost");
    showVideoEmpty();
    if (!silent) send({ t: "screen-stop" });
  }

  // ---------- remote screen rendering ----------
  function attachRemoteStream(stream) {
    state.remoteStream = stream;
    const host = $("#remote-screen-host");
    host.innerHTML = "";
    const vid = document.createElement("video");
    vid.autoplay = true;
    vid.playsInline = true;
    vid.srcObject = stream;
    host.appendChild(vid);
    host.classList.remove("hidden");
    $("#player").classList.add("hidden");
    $("#video-empty").classList.add("hidden");
    state.srcType = "screen";
    toast("Friend is sharing their screen 🖥️", "success");
    vid.play().catch(() => {});
  }
  function detachRemoteStream() {
    const host = $("#remote-screen-host");
    host.innerHTML = "";
    host.classList.add("hidden");
    $("#player").classList.remove("hidden");
    state.remoteStream = null;
    if (!player.src) showVideoEmpty();
  }

  // ---------- video empty state ----------
  function showVideoEmpty(emoji, title, sub) {
    const el = $("#video-empty");
    el.classList.remove("hidden");
    if (emoji) el.querySelector(".empty-emoji").textContent = emoji;
    if (title) el.querySelector(".empty-title").textContent = title;
    if (sub) el.querySelector(".empty-sub").textContent = sub;
  }
  function hideVideoEmpty() {
    $("#video-empty").classList.add("hidden");
  }

  // ============================================================
  //  CHAT + STICKERS
  // ============================================================
  function addChatMessage(who, text) {
    const wrap = $("#chat-messages");
    const div = document.createElement("div");
    div.className = "msg " + who;
    div.textContent = text;
    wrap.appendChild(div);
    wrap.scrollTop = wrap.scrollHeight;
  }
  function addStickerMessage(who, emoji) {
    const wrap = $("#chat-messages");
    const div = document.createElement("div");
    div.className = "msg sticker " + who;
    const author = document.createElement("div");
    author.className = "msg-author";
    author.textContent = who === "me" ? "You" : "Friend";
    div.appendChild(author);
    const big = document.createElement("div");
    big.textContent = emoji;
    div.appendChild(big);
    wrap.appendChild(div);
    wrap.scrollTop = wrap.scrollHeight;
  }
  function sendText(text) {
    text = (text || "").trim();
    if (!text) return;
    addChatMessage("me", text);
    send({ t: "chat", text });
  }
  function sendSticker(emoji) {
    addStickerMessage("me", emoji);
    send({ t: "sticker", emoji });
    pushRecentSticker(emoji);
  }
  function pushRecentSticker(emoji) {
    state.recentStickers = state.recentStickers.filter((e) => e !== emoji);
    state.recentStickers.unshift(emoji);
    state.recentStickers = state.recentStickers.slice(0, 10);
    renderRecentStickers();
  }
  function renderRecentStickers() {
    const tray = $("#sticker-tray");
    tray.innerHTML = "";
    state.recentStickers.forEach((e) => {
      const b = document.createElement("button");
      b.textContent = e;
      b.title = "Send " + e;
      b.addEventListener("click", () => sendSticker(e));
      tray.appendChild(b);
    });
  }

  function buildStickerPicker() {
    const grid = $("#sp-grid");
    (window.STICKERS || []).forEach((emoji) => {
      const b = document.createElement("button");
      b.textContent = emoji;
      b.addEventListener("click", () => {
        sendSticker(emoji);
        closeStickerPicker();
      });
      grid.appendChild(b);
    });
  }
  function openStickerPicker() { $("#sticker-picker").classList.remove("hidden"); }
  function closeStickerPicker() { $("#sticker-picker").classList.add("hidden"); }

  // ============================================================
  //  UI WIRING
  // ============================================================
  function setConnStatus(kind, label) {
    const dot = $("#conn-dot");
    dot.className = "connection-dot" + (kind === "connected" ? " connected" : kind === "error" ? " error" : "");
    $("#conn-status").textContent = label;
  }
  function enterRoomUI(code) {
    show("room");
    $("#room-code-display").textContent = code;
    location.hash = "r=" + code;
    setConnStatus("waiting", state.isHost ? "Waiting for friend…" : "Connecting…");
  }

  // ---- events ----
  let seekDragging = false;

  function wire() {
    // lobby
    $("#btn-host").addEventListener("click", startHosting);
    $("#join-form").addEventListener("submit", (e) => {
      e.preventDefault();
      startJoining($("#room-code-input").value);
    });

    // room top bar
    $("#btn-copy-code").addEventListener("click", () => {
      const link = location.origin + location.pathname + "#r=" + state.roomCode;
      navigator.clipboard.writeText(link).then(
        () => toast("Invite link copied! Send it to your friend.", "success"),
        () => toast("Link: " + link)
      );
    });
    $("#btn-leave").addEventListener("click", leaveRoom);

    // video controls
    $("#ctrl-play").addEventListener("click", togglePlay);
    $("#player").addEventListener("click", togglePlay);
    $("#ctrl-seek").addEventListener("input", () => { seekDragging = true; });
    $("#ctrl-seek").addEventListener("change", (e) => {
      seekDragging = false;
      if (!player.duration) return;
      const time = (e.target.value / 1000) * player.duration;
      userSeek(time);
    });
    $("#ctrl-sync").addEventListener("click", () => {
      if (state.isHost) { toast("You're the host — friends sync to you.", ""); return; }
      send({ t: "sync-req", ts: Date.now() });
      toast("Re-syncing…", "");
    });
    $("#ctrl-mute").addEventListener("click", () => {
      player.muted = !player.muted;
      $("#ctrl-mute").textContent = player.muted ? "🔇" : "🔊";
    });
    $("#ctrl-volume").addEventListener("input", (e) => {
      player.volume = parseFloat(e.target.value);
      player.muted = player.volume === 0;
      $("#ctrl-mute").textContent = player.muted ? "🔇" : "🔊";
    });

    // player events
    player.addEventListener("timeupdate", refreshSeekBar);
    player.addEventListener("durationchange", () => {
      $("#ctrl-duration").textContent = fmtTime(player.duration);
    });
    player.addEventListener("play", () => setPlayUI(true));
    player.addEventListener("pause", () => setPlayUI(false));
    player.addEventListener("ended", () => setPlayUI(false));
    player.addEventListener("ratechange", () => {
      // keep rate nudges invisible; reset to 1 when paused
      if (player.paused) player.playbackRate = 1;
    });
    // loading overlay while a URL source buffers
    player.addEventListener("loadstart", () => {
      if (state.srcType === "url") showLoading("Loading video…");
    });
    player.addEventListener("canplay", () => hideLoading());
    player.addEventListener("waiting", () => {
      if (state.srcType === "url") showLoading("Buffering…");
    });
    player.addEventListener("playing", () => hideLoading());

    // sources
    $("#src-local").addEventListener("click", () => $("#file-input").click());
    $("#file-input").addEventListener("change", (e) => loadFile(e.target.files[0]));
    $("#src-url").addEventListener("click", () => {
      $("#url-modal").classList.remove("hidden");
      $("#url-input").focus();
    });
    $("#url-ok").addEventListener("click", () => {
      const u = $("#url-input").value;
      $("#url-modal").classList.add("hidden");
      $("#url-input").value = "";
      loadUrl(u);
    });
    $("#url-cancel").addEventListener("click", () => {
      $("#url-modal").classList.add("hidden");
      $("#url-input").value = "";
    });
    $("#url-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("#url-ok").click();
    });
    $("#src-screen").addEventListener("click", shareScreen);

    // chat
    $("#chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("#chat-input");
      sendText(input.value);
      input.value = "";
    });
    $("#btn-stickers").addEventListener("click", (e) => {
      e.stopPropagation();
      $("#sticker-picker").classList.toggle("hidden");
    });
    $("#sp-close").addEventListener("click", closeStickerPicker);
    document.addEventListener("click", (e) => {
      const sp = $("#sticker-picker");
      if (sp.classList.contains("hidden")) return;
      if (!sp.contains(e.target) && e.target.id !== "btn-stickers") closeStickerPicker();
    });

    // keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if ($("#room").classList.contains("hidden")) return;
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.code === "Space" || e.key === "k") { e.preventDefault(); togglePlay(); }
      else if (e.key === "m") { $("#ctrl-mute").click(); }
      else if (e.key === "ArrowRight") { userSeek(Math.min(player.currentTime + 10, player.duration || 0)); }
      else if (e.key === "ArrowLeft") { userSeek(Math.max(player.currentTime - 10, 0)); }
      else if (e.key === "Escape") { closeStickerPicker(); $("#url-modal").classList.add("hidden"); }
    });

    // respond to history changes (back button)
    window.addEventListener("hashchange", () => {
      if (!location.hash && !$("#room").classList.contains("hidden")) leaveRoom();
    });
  }

  // ============================================================
  //  INIT
  // ============================================================
  function init() {
    wire();
    buildStickerPicker();

    // deep-link: #r=CODE -> auto-join
    const m = /^#r=([A-Za-z0-9-]+)/.exec(location.hash);
    if (m && m[1]) {
      const code = m[1].toUpperCase();
      // populate lobby input too, in case the code is malformed
      $("#room-code-input").value = code;
      startJoining(code);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
