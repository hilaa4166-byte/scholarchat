"use strict";
// 단둘이 쓰는 비공개 채팅 서버. 외부 패키지 없이 Node 내장 모듈만 씁니다.
// - 비밀 주소를 아는 사람만 들어올 수 있어요. 그 밖의 주소는 모두 404예요.
// - 동시에 접속할 수 있는 사람은 최대 2명이에요.
// - 대화는 서버 메모리에만 있고(최근 100개), 서버가 꺼지면 사라져요.

const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const MAX_HISTORY = 100;
const MAX_TEXT = 1000;
const MAX_NAME = 20;
const MAX_BODY = 4096;
const MAX_PEOPLE = 2;
const MAX_CONNECTIONS = 10;
const SECRET_RE = /^[A-Za-z0-9_-]{4,128}$/;
const CID_RE = /^[A-Za-z0-9]{8,40}$/;

// 비밀 주소: ROOM_SECRET 환경변수가 있으면 사용, 없으면 "scholarchat"
function loadSecret() {
  const fromEnv = (process.env.ROOM_SECRET || "").trim();
  if (fromEnv) {
    if (!SECRET_RE.test(fromEnv)) {
      console.error("ROOM_SECRET은 영문, 숫자, _, - 로만 이루어진 4~128자여야 해요.");
      process.exit(1);
    }
    return fromEnv;
  }
  return "scholarchat";
}
const SECRET = loadSecret();
const SECRET_BUF = Buffer.from(SECRET);
function isSecret(s) {
  const b = Buffer.from(String(s));
  return b.length === SECRET_BUF.length && crypto.timingSafeEqual(b, SECRET_BUF);
}

const room = { clients: new Map(), history: [] }; // 연결(res) -> 접속자 id(cid)
const sendRate = new Map(); // ip -> { n, t }
const strikes = new Map(); // ip -> { n, t }  틀린 주소로 접근한 횟수

function members() { return new Set(room.clients.values()); }

setInterval(function () {
  const now = Date.now();
  sendRate.forEach(function (v, ip) { if (now - v.t > 60000) sendRate.delete(ip); });
  strikes.forEach(function (v, ip) { if (now - v.t > 60000) strikes.delete(ip); });
}, 60 * 1000).unref();

setInterval(function () {
  room.clients.forEach(function (cid, res) { res.write(": ping\n\n"); });
}, 25000).unref();

function sse(res, event, data) {
  res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}
function broadcast(event, data) {
  room.clients.forEach(function (cid, res) { sse(res, event, data); });
}
function ipOf(req) {
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return fwd || req.socket.remoteAddress || "?";
}
function sendLimited(ip) {
  const now = Date.now();
  let v = sendRate.get(ip);
  if (!v || now - v.t > 10000) { v = { n: 0, t: now }; sendRate.set(ip, v); }
  v.n++;
  return v.n > 20;
}
function blocked(ip) {
  const v = strikes.get(ip);
  return !!v && Date.now() - v.t <= 60000 && v.n >= 20;
}
function strike(ip) {
  const now = Date.now();
  let v = strikes.get(ip);
  if (!v || now - v.t > 60000) { v = { n: 0, t: now }; strikes.set(ip, v); }
  v.n++;
}
function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  let dead = false;
  req.on("data", function (c) {
    if (dead) return;
    size += c.length;
    if (size > MAX_BODY) { dead = true; cb(null); return; }
    chunks.push(c);
  });
  req.on("end", function () { if (!dead) cb(Buffer.concat(chunks).toString("utf8")); });
}

const server = http.createServer(function (req, res) {
  const ip = ipOf(req);
  if (blocked(ip)) { res.writeHead(429, { "Retry-After": "60" }); return res.end(); }

  const u = new URL(req.url, "http://localhost");
  const parts = u.pathname.split("/").filter(Boolean);

  function deny() {
    strike(ip);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("Not found");
  }

  if (req.method === "GET" && u.pathname === "/robots.txt") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("User-agent: *\nDisallow: /\n");
  }

  // 채팅 화면: 비밀 주소와 정확히 같을 때만
  if (req.method === "GET" && parts[0] === "r" && parts.length === 2) {
    if (!isSecret(parts[1])) return deny();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'"
    });
    return res.end(PAGE);
  }

  if (parts[0] === "api" && parts.length === 3 && isSecret(parts[1])) {
    // 실시간 수신 (Server-Sent Events)
    if (req.method === "GET" && parts[2] === "events") {
      const cid = u.searchParams.get("cid") || "";
      if (!CID_RE.test(cid)) return json(res, 400, { error: "bad_cid" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no"
      });
      res.write(": ok\n\n");
      const who = members();
      if ((!who.has(cid) && who.size >= MAX_PEOPLE) || room.clients.size >= MAX_CONNECTIONS) {
        sse(res, "full", {});
        return res.end();
      }
      room.clients.set(res, cid);
      sse(res, "history", room.history);
      broadcast("count", { n: members().size });
      req.on("close", function () {
        room.clients.delete(res);
        broadcast("count", { n: members().size });
      });
      return;
    }

    // 메시지 보내기: 지금 접속 중인 사람만
    if (req.method === "POST" && parts[2] === "send") {
      if (sendLimited(ip)) return json(res, 429, { error: "slow_down" });
      return readBody(req, function (body) {
        if (body === null) return json(res, 413, { error: "too_big" });
        let d;
        try { d = JSON.parse(body); } catch (e) { return json(res, 400, { error: "bad_json" }); }
        if (!d || typeof d !== "object") return json(res, 400, { error: "bad_json" });
        const text = String(d.text == null ? "" : d.text).trim().slice(0, MAX_TEXT);
        const name = String(d.name == null ? "" : d.name).trim().slice(0, MAX_NAME) || "익명";
        const cid = String(d.cid == null ? "" : d.cid);
        if (!text || !CID_RE.test(cid)) return json(res, 400, { error: "empty" });
        if (!members().has(cid)) return json(res, 403, { error: "not_member" });
        const msg = { id: crypto.randomBytes(6).toString("hex"), cid: cid, name: name, text: text, ts: Date.now() };
        room.history.push(msg);
        if (room.history.length > MAX_HISTORY) room.history.shift();
        broadcast("msg", msg);
        return json(res, 200, { ok: true });
      });
    }
  }

  deny();
});

server.listen(PORT, function () {
  const base = (process.env.PUBLIC_URL || "http://localhost:" + PORT).replace(/\/+$/, "");
  console.log("채팅 서버가 시작됐어요.");
  console.log("아래 주소를 친구와 둘만 공유하세요. 이 주소를 아는 사람만 들어올 수 있어요.");
  console.log("");
  console.log("  " + base + "/r/" + SECRET);
  console.log("");
});

const PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Backroom</title>
<style>
:root {
  --bg: #b9f06a; --surface: #f5ffe0; --ink: #142208; --muted: #3f5a1f; --line: #8fcc43;
  --mine: #1f3a5f; --mine-ink: #f4f7fb; --accent: #b8621a; --ok: #2f8f5b; --danger: #b3372d;
  --font: system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15260b; --surface: #1c2916; --ink: #e8f0dc; --muted: #9fb38c; --line: #2f4222;
    --mine: #2c5a8c; --mine-ink: #f3f7fc; --accent: #e29a52; --ok: #5cc48e; --danger: #e8766b;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg); color: var(--ink); font-family: var(--font); font-size: 15px; line-height: 1.5;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
button, input, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[hidden] { display: none !important; }

.app { height: 100%; width: 100%; max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; min-height: 0; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-block: 12px; border-bottom: 1px solid var(--line); }
.who { display: flex; align-items: center; gap: 10px; min-width: 0; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex: none; }
.dot.on { background: var(--ok); }
.title { font-weight: 600; font-size: 16px; }
.sub { font-size: 12px; color: var(--muted); }
.ghost { flex: none; background: transparent; border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; font-size: 13px; color: var(--muted); cursor: pointer; }
.ghost:hover { color: var(--ink); border-color: var(--muted); }

.thread { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; padding-block: 14px; overscroll-behavior: contain; }
.empty { margin: auto; text-align: center; color: var(--muted); max-width: 30ch; }
.empty strong { display: block; color: var(--ink); font-weight: 600; margin-bottom: 4px; }
.row { display: flex; flex-direction: column; max-width: 82%; min-width: 0; }
.row.mine { align-self: flex-end; align-items: flex-end; }
.row.theirs { align-self: flex-start; align-items: flex-start; }
.row.gap { margin-top: 8px; }
.who-name { font-size: 12px; color: var(--muted); margin: 0 4px 2px; }
.bubble { white-space: pre-wrap; overflow-wrap: anywhere; padding: 8px 12px; border-radius: 16px; background: var(--surface); border: 1px solid var(--line); }
.mine .bubble { background: var(--mine); color: var(--mine-ink); border-color: transparent; border-bottom-right-radius: 5px; }
.theirs .bubble { border-bottom-left-radius: 5px; }
.time { margin-top: 2px; font-size: 11px; color: var(--muted); }

.composer { display: flex; align-items: flex-end; gap: 8px; padding-block: 10px 12px; border-top: 1px solid var(--line); }
.composer textarea { flex: 1; min-width: 0; resize: none; max-height: 140px; padding: 9px 12px; border-radius: 18px; border: 1px solid var(--line); background: var(--surface); line-height: 1.45; }
.composer textarea:disabled { opacity: 0.6; }
.send { flex: none; border: 0; border-radius: 18px; padding: 9px 16px; background: var(--mine); color: var(--mine-ink); font-weight: 500; cursor: pointer; }
.send:disabled { opacity: 0.45; cursor: default; }

.gate { position: fixed; inset: 0; z-index: 10; background: var(--bg); display: flex; align-items: center; justify-content: center; padding: 24px; }
.gate form { width: 100%; max-width: 340px; display: flex; flex-direction: column; gap: 12px; }
.gate h1 { margin: 0; font-size: 22px; }
.gate p { margin: 0; color: var(--muted); }
.gate input { padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface); }
.gate .send { border-radius: 12px; padding: 10px 16px; }
@media (max-width: 420px) { .row { max-width: 88%; } }
</style>
</head>
<body>
<div class="app">
  <header class="top">
    <div class="who">
      <span class="dot" id="dot" aria-hidden="true"></span>
      <div>
        <div class="title">Backroom</div>
        <div class="sub" id="sub">연결 중</div>
      </div>
    </div>
    <button type="button" class="ghost" id="copy">링크 복사</button>
  </header>
  <main class="thread" id="thread" aria-live="polite">
    <p class="empty"><strong>아직 대화가 없어요</strong>위의 링크 복사를 눌러 친구에게 보내고, 첫 메시지를 남겨 보세요.</p>
  </main>
  <form class="composer" id="composer" autocomplete="off">
    <textarea id="msg" rows="1" maxlength="1000" placeholder="메시지 입력" aria-label="메시지" disabled></textarea>
    <button type="submit" class="send" id="send" disabled>보내기</button>
  </form>
</div>

<div class="gate" id="gate">
  <form id="gateForm">
    <h1>대화방 입장</h1>
    <p>대화에서 보일 이름을 정해 주세요.</p>
    <input id="nameInput" maxlength="20" placeholder="이름" aria-label="이름" required>
    <button type="submit" class="send">들어가기</button>
  </form>
</div>

<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var room = location.pathname.split("/")[2] || "";
  var thread = $("thread"), msg = $("msg"), form = $("composer"), sendBtn = $("send");
  var subEl = $("sub"), dotEl = $("dot"), gate = $("gate");
  var cid = "", name = "", list = [], es = null, online = 0, connected = false;

  try { cid = localStorage.getItem("cid") || ""; name = localStorage.getItem("name") || ""; } catch (e) {}
  if (!cid) {
    cid = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem("cid", cid); } catch (e) {}
  }

  function setSub() {
    if (!connected) { subEl.textContent = "연결 중이에요"; return; }
    subEl.textContent = "지금 " + online + "명 접속 중";
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
  }
  function minuteKey(ts) { return Math.floor(ts / 60000); }

  function render() {
    var near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
    var last = list[list.length - 1];
    var lastMine = !!last && last.cid === cid;
    thread.textContent = "";
    if (!list.length) {
      var p = document.createElement("p");
      p.className = "empty";
      var s = document.createElement("strong");
      s.textContent = "아직 대화가 없어요";
      p.appendChild(s);
      p.appendChild(document.createTextNode("링크 복사를 눌러 친구에게 보내고, 첫 메시지를 남겨 보세요."));
      thread.appendChild(p);
      return;
    }
    var frag = document.createDocumentFragment();
    list.forEach(function (m, i) {
      var prev = list[i - 1], next = list[i + 1];
      var mine = m.cid === cid;
      var newSender = !prev || prev.cid !== m.cid;
      var endOfGroup = !next || next.cid !== m.cid || minuteKey(next.ts) !== minuteKey(m.ts);
      var row = document.createElement("div");
      row.className = "row " + (mine ? "mine" : "theirs") + (newSender ? " gap" : "");
      if (!mine && newSender) {
        var n = document.createElement("div");
        n.className = "who-name";
        n.textContent = m.name;
        row.appendChild(n);
      }
      var b = document.createElement("div");
      b.className = "bubble";
      b.textContent = m.text;
      row.appendChild(b);
      if (endOfGroup) {
        var t = document.createElement("div");
        t.className = "time";
        t.textContent = fmtTime(m.ts);
        row.appendChild(t);
      }
      frag.appendChild(row);
    });
    thread.appendChild(frag);
    if (near || lastMine) thread.scrollTop = thread.scrollHeight;
  }

  function connect() {
    if (es) es.close();
    es = new EventSource("/api/" + encodeURIComponent(room) + "/events?cid=" + encodeURIComponent(cid));
    es.onopen = function () { connected = true; dotEl.classList.add("on"); setSub(); };
    es.onerror = function () { connected = false; dotEl.classList.remove("on"); setSub(); };
    es.addEventListener("full", function () {
      es.close();
      connected = false;
      dotEl.classList.remove("on");
      subEl.textContent = "이미 두 명이 쓰는 중이라 들어갈 수 없어요";
      msg.disabled = true;
      syncSend();
    });
    es.addEventListener("history", function (e) {
      try { list = JSON.parse(e.data); } catch (x) { list = []; }
      render();
    });
    es.addEventListener("msg", function (e) {
      try { list.push(JSON.parse(e.data)); } catch (x) { return; }
      if (list.length > 200) list.shift();
      render();
    });
    es.addEventListener("count", function (e) {
      try { online = JSON.parse(e.data).n; } catch (x) {}
      setSub();
    });
  }

  function autosize() {
    msg.style.height = "auto";
    msg.style.height = Math.min(msg.scrollHeight, 140) + "px";
  }
  function syncSend() { sendBtn.disabled = !msg.value.trim() || msg.disabled; }

  async function doSend() {
    var text = msg.value.trim();
    if (!text) return;
    msg.value = "";
    autosize();
    syncSend();
    try {
      var r = await fetch("/api/" + encodeURIComponent(room) + "/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cid: cid, name: name, text: text })
      });
      if (!r.ok) throw new Error(String(r.status));
    } catch (e) {
      msg.value = text;
      autosize();
      syncSend();
      subEl.textContent = "보내지 못했어요. 잠시 뒤 다시 눌러 주세요";
    }
    msg.focus();
  }

  msg.addEventListener("input", function () { autosize(); syncSend(); });
  msg.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      doSend();
    }
  });
  sendBtn.addEventListener("pointerdown", function (e) { e.preventDefault(); });
  form.addEventListener("submit", function (e) { e.preventDefault(); doSend(); });

  $("copy").addEventListener("click", function () {
    var btn = $("copy");
    function done() { btn.textContent = "복사됨"; setTimeout(function () { btn.textContent = "링크 복사"; }, 1500); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(location.href).then(done, function () { window.prompt("링크를 복사하세요", location.href); });
    } else {
      window.prompt("링크를 복사하세요", location.href);
    }
  });

  function enter(n) {
    name = n;
    try { localStorage.setItem("name", n); } catch (e) {}
    gate.hidden = true;
    msg.disabled = false;
    syncSend();
    msg.focus();
    connect();
  }
  $("gateForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var n = $("nameInput").value.trim();
    if (n) enter(n);
  });
  if (name) { $("nameInput").value = name; }
  $("nameInput").focus();
})();
</script>
</body>
</html>
`;
