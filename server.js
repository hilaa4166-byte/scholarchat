"use strict";
// 단둘이 쓰는 비공개 채팅 서버. 외부 패키지 없이 Node 내장 모듈만 씁니다.
// - 비밀 주소를 아는 사람만 들어올 수 있어요. 그 밖의 주소는 모두 404예요.
// - 동시에 접속할 수 있는 사람은 최대 2명이에요.
// - 대화와 사진은 서버 메모리에만 있고(최근 100개), 서버가 꺼지거나 삭제하면 사라져요.

const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const ROOM_ID = "scholarchat";
const MAX_USERS = 2;
const MAX_HISTORY = 100;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 요청 최대 2MB

const room = {
  messages: [],
  clients: new Set(), // { id, res, name }
};

function broadcast(eventObj) {
  const payload = `data: ${JSON.stringify(eventObj)}\n\n`;
  for (const client of room.clients) {
    try {
      client.res.write(payload);
    } catch (_) {
      room.clients.delete(client);
    }
  }
}

function getParticipantNames() {
  return Array.from(room.clients).map((c) => c.name);
}

function pushMessage(msg) {
  room.messages.push(msg);
  if (room.messages.length > MAX_HISTORY) {
    room.messages = room.messages.slice(-MAX_HISTORY);
  }
}

function renderPage() {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>ScholarChat</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
    header {
      background: #1e293b;
      border-bottom: 1px solid #334155;
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .room-info { display: flex; flex-direction: column; gap: 2px; }
    .room-title { font-weight: 700; font-size: 16px; }
    .room-meta { font-size: 12px; color: #94a3b8; }
    button {
      cursor: pointer;
      border: none;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
      font-weight: 600;
      flex-shrink: 0;
    }
    .btn-clear { background: #dc2626; color: #fff; }
    .btn-clear:hover { background: #b91c1c; }
    .btn-send { background: #2563eb; color: #fff; }
    .btn-send:hover { background: #1d4ed8; }
    .btn-attach {
      background: #334155;
      color: #f8fafc;
      padding: 8px 10px;
      font-size: 16px;
      line-height: 1;
    }
    .btn-attach:hover { background: #475569; }
    #join-screen {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .join-card {
      width: 100%;
      max-width: 360px;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 14px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .join-card h2 { font-size: 18px; }
    .join-card p { font-size: 13px; color: #94a3b8; line-height: 1.4; }
    input[type="text"] {
      width: 100%;
      background: #0f172a;
      border: 1px solid #475569;
      color: #f8fafc;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 14px;
      outline: none;
    }
    input[type="text"]:focus { border-color: #3b82f6; }
    #chat-screen {
      flex: 1;
      display: none;
      flex-direction: column;
      min-height: 0;
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .msg {
      max-width: 78%;
      padding: 10px 12px;
      border-radius: 12px;
      background: #1e293b;
      border: 1px solid #334155;
      word-break: break-word;
    }
    .msg.mine {
      align-self: flex-end;
      background: #1d4ed8;
      border-color: #2563eb;
    }
    .msg-sender {
      font-size: 11px;
      color: #cbd5e1;
      margin-bottom: 4px;
      font-weight: 600;
    }
    .msg-text {
      font-size: 14px;
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .msg-img {
      display: block;
      max-width: 100%;
      max-height: 320px;
      border-radius: 8px;
      margin-top: 4px;
      cursor: pointer;
    }
    .sys-msg {
      align-self: center;
      font-size: 12px;
      color: #94a3b8;
      background: rgba(30, 41, 59, 0.7);
      padding: 5px 10px;
      border-radius: 999px;
    }
    #composer {
      background: #1e293b;
      border-top: 1px solid #334155;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #status-msg {
      font-size: 13px;
      color: #f87171;
      min-height: 18px;
    }
  </style>
</head>
<body>
  <header>
    <div class="room-info">
      <div class="room-title">ScholarChat</div>
      <div class="room-meta" id="room-meta">대기 중 · 최대 ${MAX_USERS}명 · /clear</div>
    </div>
    <button class="btn-clear" id="clear-btn" type="button">대화 삭제</button>
  </header>

  <section id="join-screen">
    <form class="join-card" id="join-form">
      <h2>채팅방 입장</h2>
      <p>대화와 사진은 메모리에만 임시 저장되며, 삭제 버튼 또는 /clear로 즉시 지워집니다.</p>
      <input type="text" id="nickname-input" placeholder="이름 또는 닉네임 입력" maxlength="20" required />
      <button class="btn-send" type="submit">입장하기</button>
      <div id="status-msg"></div>
    </form>
  </section>

  <section id="chat-screen">
    <div id="messages"></div>
    <form id="composer">
      <input type="file" id="photo-input" accept="image/*" hidden />
      <button class="btn-attach" id="photo-btn" type="button" title="파일/사진 첨부">📎</button>
      <input type="text" id="message-input" placeholder="메시지 입력 (/clear 입력 시 대화 삭제)" autocomplete="off" />
      <button class="btn-send" type="submit">전송</button>
    </form>
  </section>

  <script>
    const joinScreen = document.getElementById("join-screen");
    const chatScreen = document.getElementById("chat-screen");
    const joinForm = document.getElementById("join-form");
    const nicknameInput = document.getElementById("nickname-input");
    const statusMsg = document.getElementById("status-msg");
    const messagesEl = document.getElementById("messages");
    const composer = document.getElementById("composer");
    const messageInput = document.getElementById("message-input");
    const roomMeta = document.getElementById("room-meta");
    const clearBtn = document.getElementById("clear-btn");
    const photoBtn = document.getElementById("photo-btn");
    const photoInput = document.getElementById("photo-input");

    let myName = "";
    let eventSource = null;
    let audioCtx = null;

    function ensureAudioContext() {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      if (!audioCtx) {
        audioCtx = new AudioContextClass();
      }
      if (audioCtx.state === "suspended") {
        audioCtx.resume().catch(() => {});
      }
      return audioCtx;
    }

    // "띠링~" 이중 톤 알림음 재생
    function playDingSound() {
      const ctx = ensureAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;

      const tone1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      tone1.type = "sine";
      tone1.frequency.setValueAtTime(880, now); // A5 ("띠")
      gain1.gain.setValueAtTime(0.001, now);
      gain1.gain.exponentialRampToValueAtTime(0.14, now + 0.015);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      tone1.connect(gain1);
      gain1.connect(ctx.destination);
      tone1.start(now);
      tone1.stop(now + 0.15);

      const tone2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      tone2.type = "sine";
      tone2.frequency.setValueAtTime(1318.51, now + 0.09); // E6 ("링~")
      gain2.gain.setValueAtTime(0.001, now + 0.09);
      gain2.gain.exponentialRampToValueAtTime(0.16, now + 0.11);
      gain2.gain.exponentialRampToValueAtTime(0.0008, now + 0.36);
      tone2.connect(gain2);
      gain2.connect(ctx.destination);
      tone2.start(now + 0.09);
      tone2.stop(now + 0.38);
    }

    function addSystemMessage(text) {
      const div = document.createElement("div");
      div.className = "sys-msg";
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function addChatMessage(msg) {
      const div = document.createElement("div");
      div.className = "msg" + (msg.sender === myName ? " mine" : "");

      const sender = document.createElement("div");
      sender.className = "msg-sender";
      sender.textContent = msg.sender;
      div.appendChild(sender);

      if (msg.image) {
        const img = document.createElement("img");
        img.className = "msg-img";
        img.src = msg.image;
        img.alt = "첨부 이미지";
        img.onclick = () => window.open(msg.image, "_blank");
        div.appendChild(img);
      }

      if (msg.text) {
        const text = document.createElement("div");
        text.className = "msg-text";
        text.textContent = msg.text;
        div.appendChild(text);
      }

      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function updateMeta(users) {
      const listText = users.length ? users.join(", ") : "없음";
      roomMeta.textContent = \`접속 \${users.length}/\${${MAX_USERS}} (\${listText}) · /clear\`;
    }

    async function requestClear() {
      await fetch("/api/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ by: myName || "참여자" }),
      });
    }

    function compressImageToDataUrl(file, maxSide = 1000, quality = 0.78) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => {
          const img = new Image();
          img.onerror = reject;
          img.onload = () => {
            let { width, height } = img;
            if (width > maxSide || height > maxSide) {
              if (width >= height) {
                height = Math.round((height * maxSide) / width);
                width = maxSide;
              } else {
                width = Math.round((width * maxSide) / height);
                height = maxSide;
              }
            }
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL("image/jpeg", quality));
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    }

    photoBtn.addEventListener("click", () => {
      if (!myName) return;
      ensureAudioContext();
      photoInput.click();
    });

    photoInput.addEventListener("change", async () => {
      const file = photoInput.files && photoInput.files[0];
      photoInput.value = "";
      if (!file || !myName) return;

      try {
        const dataUrl = await compressImageToDataUrl(file);
        const res = await fetch("/api/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender: myName, image: dataUrl }),
        });
        if (!res.ok) {
          addSystemMessage("사진 전송에 실패했습니다. (용량 초과 또는 연결 오류)");
        }
      } catch (_) {
        addSystemMessage("이미지를 처리하지 못했습니다.");
      }
    });

    clearBtn.addEventListener("click", async () => {
      if (!myName) return;
      ensureAudioContext();
      if (!confirm("대화 내용과 사진을 모두 삭제할까요?")) return;
      await requestClear();
    });

    joinForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      ensureAudioContext();
      statusMsg.textContent = "";
      const name = nicknameInput.value.trim();
      if (!name) return;

      const res = await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        statusMsg.textContent = data.error || "입장할 수 없습니다.";
        return;
      }

      myName = name;
      joinScreen.style.display = "none";
      chatScreen.style.display = "flex";
      messageInput.focus();

      messagesEl.innerHTML = "";
      if (Array.isArray(data.messages)) {
        for (const m of data.messages) addChatMessage(m);
      }
      updateMeta(data.users || []);

      eventSource = new EventSource(\`/api/stream?name=\${encodeURIComponent(myName)}\`);

      eventSource.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === "message") {
          addChatMessage(payload.message);
          if (payload.message && payload.message.sender !== myName) {
            playDingSound();
          }
        } else if (payload.type === "presence") {
          updateMeta(payload.users || []);
        } else if (payload.type === "system") {
          addSystemMessage(payload.text);
        } else if (payload.type === "cleared") {
          messagesEl.innerHTML = "";
          addSystemMessage(\`\${payload.by || "참여자"}님이 대화 내용을 삭제했습니다.\`);
        }
      };

      eventSource.onerror = () => {
        addSystemMessage("연결이 끊어졌습니다. 새로고침 후 다시 입장해 주세요.");
      };
    });

    composer.addEventListener("submit", async (e) => {
      e.preventDefault();
      ensureAudioContext();
      const text = messageInput.value.trim();
      if (!text || !myName) return;
      messageInput.value = "";

      if (text === "/clear") {
        await requestClear();
        return;
      }

      await fetch("/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: myName, text }),
      });
    });

    window.addEventListener("beforeunload", () => {
      if (eventSource) eventSource.close();
    });
  </script>
</body>
</html>`;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const parts = u.pathname.split("/").filter(Boolean);

  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method === "GET" && parts.length === 2 && parts[0] === "r" && parts[1] === ROOM_ID) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(renderPage());
  }

  if (req.method === "POST" && u.pathname === "/api/join") {
    try {
      const body = await parseJsonBody(req);
      const name = String(body.name || "").trim().slice(0, 20);
      if (!name) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "이름을 입력해 주세요." }));
      }
      if (room.clients.size >= MAX_USERS) {
        res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: `방 인원이 가득 찼습니다. (최대 ${MAX_USERS}명)` }));
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(
        JSON.stringify({
          ok: true,
          messages: room.messages,
          users: getParticipantNames(),
        })
      );
    } catch (_) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "잘못된 요청입니다." }));
    }
  }

  if (req.method === "GET" && u.pathname === "/api/stream") {
    const name = String(u.searchParams.get("name") || "").trim().slice(0, 20);
    if (!name) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Missing name");
    }
    if (room.clients.size >= MAX_USERS) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Room full");
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const client = { id: crypto.randomBytes(6).toString("hex"), res, name };
    room.clients.add(client);

    broadcast({ type: "presence", users: getParticipantNames() });
    broadcast({ type: "system", text: `${name}님이 입장했습니다.` });

    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch (_) {
        clearInterval(keepAlive);
      }
    }, 25000);

    req.on("close", () => {
      clearInterval(keepAlive);
      room.clients.delete(client);
      broadcast({ type: "presence", users: getParticipantNames() });
      broadcast({ type: "system", text: `${name}님이 퇴장했습니다.` });
    });
    return;
  }

  if (req.method === "POST" && u.pathname === "/api/message") {
    try {
      const body = await parseJsonBody(req);
      const sender = String(body.sender || "").trim().slice(0, 20);
      const text = String(body.text || "").trim().slice(0, 2000);
      const image = typeof body.image === "string" && body.image.startsWith("data:image/") ? body.image : "";

      if (!sender || (!text && !image)) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ error: "내용이 비어 있습니다." }));
      }

      const msg = {
        id: crypto.randomBytes(4).toString("hex"),
        sender,
        text,
        image,
        ts: Date.now(),
      };
      pushMessage(msg);
      broadcast({ type: "message", message: msg });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true }));
    } catch (_) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "전송 실패" }));
    }
  }

  if (req.method === "POST" && u.pathname === "/api/clear") {
    try {
      const body = await parseJsonBody(req);
      const by = String(body.by || "참여자").trim().slice(0, 20);
      room.messages = [];
      broadcast({ type: "cleared", by });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ ok: true }));
    } catch (_) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "삭제 실패" }));
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log("채팅 서버가 시작됐어요.");
  console.log("아래 주소를 친구와 둘만 공유하세요. 이 주소를 아는 사람만 들어올 수 있어요.");
  console.log(`http://localhost:${PORT}/r/${ROOM_ID}`);
});
