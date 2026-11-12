// bilody 웹 시험판(아이폰 Safari용). 안드로이드 앱과 같은 서버·계정·친구·기억을 쓴다.
import * as api from "./api.js";
import { CONSENT_VERSION, VERSION } from "./config.js";
import { CHARACTERS, byId, dotColor, validFriendName, validMyName, animSrc } from "./characters.js";
import { GUIDE } from "./guide.js";
import { Player } from "./audio.js";
import { Chat } from "./rt.js";

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const app = $("#app");
const player = new Player();

// ---------------- 이 기기에만 저장하는 설정 ----------------
const pref = {
  get(k, d) { try { const v = localStorage.getItem(`bilody_${api.userId() ?? "anon"}_${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`bilody_${api.userId() ?? "anon"}_${k}`, JSON.stringify(v)); } catch { /* */ } },
};

const S = { stage: "loading", profile: null, progress: null, tab: "chat", chat: null, toast: null, busy: false, error: null,
  sessions: [], previews: {}, openSession: null, turns: null, memories: [], open: null, dialog: null };

const CONSENT_ITEMS = [
  ["ai_notice", "bilody 친구의 대답과 목소리는 생성형 AI가 만든 것입니다. 사람이 아닌 AI와 대화한다는 것을 이해했습니다."],
  ["processing", "내가 한 말(음성)은 외부 AI 업체(OpenAI, 미국)로 보내져 글로 바뀌고 대답을 만드는 데 쓰입니다. 친구의 대답 글은 안전검사(OpenAI)를 거친 뒤 목소리를 만들기 위해 ElevenLabs(미국)로 보내집니다. bilody는 녹음 파일을 저장하지 않습니다. 외부 업체의 보관 조건은 업체 정책을 따르며 확인 중입니다."],
  ["records", "대화 글(내가 한 말과 친구가 실제로 들려준 말)은 bilody 서버(서울)에 저장됩니다. 보관 기간은 설정에서 고를 수 있고(기본 30일), 기록 화면에서 언제든 하나씩 또는 전부 지울 수 있습니다."],
  ["nearby", "주변 가족·아이의 목소리도 마이크에 함께 들어가 외부로 보내질 수 있습니다. 혼자 있는 곳에서 쓰고, 아이가 곁에 있으면 일시정지 버튼을 누르겠습니다."],
  ["analysis", "시험 기간 동안 운영자(bilody)가 서비스를 고치기 위해 내 대화 글과 사용 기록(사용 시간, 누른 버튼 등), 설문 응답을 읽고 분석할 수 있습니다. 분석은 초대 코드 단위로 하며 외부에 공개하지 않습니다."],
  ["adult", "나는 만 19세 이상이며, 초대받은 비공개 시험 참여자입니다."],
];

const STATE_LABEL = { idle: "대기", connecting: "연결 중", listening: "듣는 중", thinking: "생각 중", speaking: "말하는 중", stopped: "멈춤", disconnected: "연결 끊김" };

function toast(msg) {
  S.toast = msg; const t = $("#toast"); if (!t) return;
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), 3200);
}

async function work(fn) {
  S.busy = true; S.error = null; render();
  try { await fn(); } catch (e) { S.error = api.errText(e); if (e?.code === "session_expired" || e?.code === "not_logged_in") { api.signOut(); S.stage = "auth"; } }
  S.busy = false; render();
}

// ---------------- 시작 ----------------
async function refresh() {
  if (!api.signedIn()) { S.stage = "auth"; return render(); }
  try {
    const consent = await api.hasConsent(CONSENT_VERSION);
    S.profile = await api.loadProfile();
    S.stage = !consent ? "consent" : !S.profile?.my_name ? "names" : "main";
    if (S.stage === "main") S.progress = await api.myProgress();
  } catch (e) {
    if (e?.code === "session_expired" || e?.code === "not_logged_in") { api.signOut(); S.stage = "auth"; }
    else { S.stage = "auth"; S.error = api.errText(e); }
  }
  render();
}

// ---------------- 그리기 ----------------
let lastView = null;
function render() {
  const html = {
    loading: () => `<div class="center"><img class="logo-stacked" src="img/logo_stacked.png" alt="bilody"><div class="spinner"></div></div>`,
    auth: renderAuth, consent: renderConsent, names: renderNames, main: renderMain,
  }[S.stage]();
  const view = S.stage === "main" ? `main:${S.tab}` : S.stage;
  app.innerHTML = html + `<div id="toast" class="toast"></div>` + renderDialog();
  if (view !== lastView) { window.scrollTo(0, 0); lastView = view; }  // 화면이 바뀌면 맨 위부터
  if (S.stage === "main" && S.tab === "chat") updateChat();
}

function renderAuth() {
  const signup = S.authMode !== "login";
  return `<div class="page center-col">
    <img class="logo-stacked" src="img/logo_stacked.png" alt="bilody">
    <p class="muted center-text">초대받은 성인만 이용할 수 있는 비공개 시험판이에요</p>
    <div class="card form">
      <div class="seg">
        <button data-act="mode" data-v="signup" class="${signup ? "on" : ""}">초대 코드로 가입</button>
        <button data-act="mode" data-v="login" class="${signup ? "" : "on"}">로그인</button>
      </div>
      ${signup ? `<label>초대 코드<input id="code" autocapitalize="characters" autocomplete="off"></label>` : ""}
      <label>이메일<input id="email" type="email" autocomplete="email"></label>
      <label>비밀번호${signup ? "(8자 이상)" : ""}<input id="pw" type="password" autocomplete="${signup ? "new-password" : "current-password"}"></label>
      ${S.error ? `<p class="error">${esc(S.error)}</p>` : ""}
      <button class="pill primary" data-act="auth" ${S.busy ? "disabled" : ""}>${S.busy ? "잠시만요…" : signup ? "가입하기" : "로그인"}</button>
    </div>
    <p class="muted small">bilody ${VERSION} · 아이폰은 Safari에서 열어 주세요</p>
  </div>`;
}

function renderConsent() {
  return `<div class="page">
    <h1>시작하기 전에 확인해 주세요</h1>
    <p class="muted small">시험판 안내문(임시본)입니다. 정식 문구는 법률 검토 후 바뀝니다.</p>
    ${CONSENT_ITEMS.map(([id, t]) => `<label class="consent"><input type="checkbox" data-consent="${id}"><span>${esc(t)}</span></label>`).join("")}
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ""}
    <button class="pill primary" data-act="agree" disabled>모두 확인하고 동의합니다</button>
  </div>`;
}

function charPicker(sel) {
  return `<div class="picker">${CHARACTERS.map((c) => `<button class="pick ${c.id === sel ? "on" : ""}" data-act="pick" data-v="${c.id}" style="--c:${c.color}">
    <img src="img/char_${c.id}.webp" alt=""><span>${c.ko}</span></button>`).join("")}</div>`;
}

function renderNames() {
  const c = byId(S.nameDraft?.character ?? S.profile?.character);
  const d = S.nameDraft ??= { character: c.id, friend: S.profile?.friend_name ?? c.en, me: S.profile?.my_name ?? "" };
  return `<div class="page center-col">
    <h1>함께 이야기할 친구를 골라요</h1>
    <div class="stage"><img class="friend big" src="${animSrc(d.character, "idle")}" alt=""></div>
    <p class="muted center-text">${esc(byId(d.character).intro)}</p>
    ${charPicker(d.character)}
    <div class="form">
      <label>친구 이름<input id="friend" maxlength="8" value="${esc(d.friend)}"></label>
      <label>내 이름(영어로, 예: Hyemin)<input id="me" maxlength="20" value="${esc(d.me)}" autocapitalize="words"></label>
      <p class="muted small">친구 이름은 한글이나 영어로 1~8자, 내 이름은 영어로 1~20자예요.</p>
      ${S.error ? `<p class="error">${esc(S.error)}</p>` : ""}
      <button class="pill primary" data-act="saveNames" ${S.busy ? "disabled" : ""}>${S.busy ? "잠시만요…" : "시작하기"}</button>
    </div>
  </div>`;
}

function renderMain() {
  const title = { history: "지난 대화", settings: "설정" }[S.tab] ?? "";
  const body = { chat: renderChat, history: renderHistory, settings: renderSettings }[S.tab]();
  return `<div class="frame">
    <header class="top"><img src="img/logo_horizontal.png" alt="bilody"><span class="title">${title}</span></header>
    <main class="content">${body}</main>
    <nav class="tabs">
      ${[["chat", "대화", "💬"], ["history", "기록", "🕘"], ["settings", "설정", "⚙️"]].map(([k, l, i]) =>
        `<button data-act="tab" data-v="${k}" class="${S.tab === k ? "on" : ""}"><span class="ti">${i}</span>${l}</button>`).join("")}
    </nav>
  </div>`;
}

// ---------------- 대화 ----------------
function renderChat() {
  const p = S.profile; const c = byId(p?.character); const pr = S.progress;
  const chat = S.chat;
  const home = !chat ? `
    <div class="streak card">
      <div class="ring" style="--p:${Math.min(1, (pr?.today_seconds ?? 0) / 300)}"><span>${(pr?.streak ?? 0) > 0 ? "🔥" : "🌱"}</span></div>
      <div class="grow"><b>${esc(p?.friend_name ?? c.en)}와 ${(pr?.streak ?? 0) > 0 ? `${pr.streak}일째` : "첫날"}</b>
        <div class="muted small">${pr?.done_today ? "오늘 5분 완료! ✨" : `오늘 ${Math.floor((pr?.today_seconds ?? 0) / 60)}분 · 목표 5분`}</div></div>
      <button class="points" data-act="board"><b>${pr?.week_points ?? 0}</b><span>이번 주 🏆</span></button>
    </div>` : "";
  const guide = !chat && !pref.get("guideSeen", false) ? `<div class="card guide"><b>이렇게 이야기해요</b><ul>
      <li>‘대화 시작’을 누르면 짧은 음악이 끝나고 ${esc(p?.friend_name ?? "친구")}가 먼저 인사해요.</li>
      <li>빨간 ‘마이크 켜짐’일 때 편하게 말하면 돼요. 한국어가 섞여도, 짧게 답해도 괜찮아요.</li>
      <li>친구가 말하는 중에 말하면 친구가 멈추고 들어요. 생각할 시간이 필요하면 “Wait”라고 해 보세요.</li>
      <li>틀린 표현은 친구가 고쳐 주고 따라 말해 보게 해요.</li>
      <li>곁에 아이나 가족이 있으면 일시정지해 주세요. 주변 목소리도 함께 보내질 수 있어요.</li>
      <li>아이폰은 무음 모드를 끄고 소리를 키워 주세요.</li></ul>
      <button class="link" data-act="guideSeen">알겠어요</button></div>` : "";
  return `<div class="chat">
    <div class="chat-top">${home}
      <div class="stage"><img id="friendImg" class="friend" src="${animSrc(c.id, "idle")}" alt=""></div>
      <div class="status"><i></i><span id="stLabel">대기</span><em></em><span id="micLabel" class="mic">🎙 마이크 꺼짐</span></div>
      <p class="muted tiny">${esc(p?.friend_name ?? "친구")}는 AI 친구예요 · 대답과 목소리는 AI가 만들어요</p>
      <p id="remain" class="accent tiny"></p><p id="latency" class="muted tiny"></p>
      <div id="photo"></div>
    </div>
    <div id="card"></div>
    <div id="lines" class="lines"></div>
    ${guide}
    <p id="notice" class="error"></p>
    <div class="controls" id="controls">${chat ? "" : `
      <button class="pill primary grow" data-act="start">🎙 대화 시작</button>`}</div>
    <div class="inputbar ${chat ? "" : "hidden"}" id="inputbar">
      <button class="round lilac" data-act="photo" aria-label="사진 보여 주기">📷</button>
      <input id="say" placeholder="글로 말하기" maxlength="300" enterkeyhint="send">
      <button class="round send" data-act="send" aria-label="보내기">➤</button>
    </div>
    <input type="file" id="camera" accept="image/*" capture="environment" hidden>
    <input type="file" id="gallery" accept="image/*" hidden>
  </div>`;
}

/** 대화 중 자주 바뀌는 부분만 고친다(글 입력칸 포커스를 지키려고 전체를 다시 그리지 않음). */
function updateChat() {
  if (S.stage !== "main" || S.tab !== "chat") return;
  const chat = S.chat; const u = chat?.ui; const c = byId(S.profile?.character);
  const img = $("#friendImg"); if (!img) return;
  const src = animSrc(c.id, u?.state ?? "idle"); if (!img.src.endsWith(src)) img.src = src;
  $("#stLabel").textContent = STATE_LABEL[u?.state ?? "idle"];
  const mic = $("#micLabel"); mic.textContent = u?.micOn ? "🎙 마이크 켜짐" : "🎙 마이크 꺼짐"; mic.classList.toggle("on", !!u?.micOn);
  $("#remain").textContent = u?.remainingMinutes ? `오늘 남은 대화 시간 약 ${u.remainingMinutes}분` : "";
  $("#latency").textContent = u?.lastLatencyMs ? `마지막 대답 ${(u.lastLatencyMs / 1000).toFixed(1)}초` : "";
  $("#notice").textContent = u?.notice ?? "";
  $("#photo").innerHTML = u?.photo ? `<div class="photo-card" data-act="clearPhoto"><img src="${u.photo}" alt="보여 준 사진"></div>` : "";
  const card = u?.card;
  $("#card").innerHTML = card ? `<div class="card help" data-act="dismissCard">
      <div class="accent small b">${card.chunk ? "한 부분씩 따라 말해 보세요" : card.practice ? "따라 말해 보세요" : card.rephrased ? "친구가 쉽게 다시 말했어요" : "친구가 다시 말했어요"}</div>
      <div class="help-text ${card.practice ? "big" : ""}">${highlight(card)}</div></div>` : "";
  const subs = pref.get("subtitles", false);
  $("#lines").innerHTML = subs && u ? u.lines.slice(-8).map((l) => `<div class="bubble ${l.role === "user" ? "me" : ""}">${esc(l.text)}</div>`).join("") : "";
  if (chat) {
    const running = !["stopped", "disconnected"].includes(u.state);
    $("#controls").innerHTML = `
      <button class="pill dark" data-act="pause" ${running ? "" : "disabled"}>⏸ 일시정지</button>
      <button class="pill primary" data-act="restart" ${u.canRestart && !running ? "" : "disabled"}>↻ 다시 시작</button>
      <button class="pill secondary" data-act="exit">나가기</button>`;
    $("#inputbar").classList.remove("hidden");
  }
}

function highlight(card) {
  const t = card.text; const ch = card.chunk?.replace(/[.!?,]+$/, "");
  if (!ch) return esc(t);
  const i = t.toLowerCase().indexOf(ch.toLowerCase());
  if (i < 0) return `${esc(t)}<div class="accent b">지금: “${esc(card.chunk)}”</div>`;
  return `<span class="dim">${esc(t.slice(0, i))}</span><mark>${esc(t.slice(i, i + ch.length))}</mark><span class="dim">${esc(t.slice(i + ch.length))}</span>`;
}

async function startChat() {
  player.unlock();
  const p = S.profile; const c = byId(p?.character);
  player.setVolume(pref.get("volume", 1));
  S.chat = new Chat({ voiceId: c.voice, speed: pref.get("speed", 1), saveTranscripts: (p?.transcript_days ?? 30) > 0, player, onChange: () => updateChat() });
  render();
  await S.chat.start();
}

async function endChat() {
  const c = S.chat; S.chat = null;
  const said = c ? c.ui.lines.filter((l) => l.role === "user").length : 0;
  const sid = c?.sessionId ?? null;
  render();
  if (c) await c.close();
  S.progress = await api.myProgress();
  // 그날 첫 대화를 마칠 때 짧은 설문(내가 한 말이 있는 대화만, 답할 때까지 하루 두 번까지)
  if (c && said > 0 && checkin.day() !== today() && checkin.asks() < 2) { checkin.ask(); S.dialog = { kind: "checkin", sid, rating: 0 }; }
  render();
}

// ---------- 매일 짧은 설문(0.7.7) ----------
const CHECKIN_ISSUES = [["no_reply", "내가 말했는데 대답을 안 했어요"], ["repeat_after_me", "같은 말을 자꾸 따라 해 보라고 했어요"], ["cut_off", "내 말을 끊었어요"],
  ["misheard", "내 말을 잘못 알아들었어요"], ["slow", "대답이 느렸어요"], ["repetitive", "같은 얘기를 되풀이했어요"], ["voice", "목소리나 소리가 이상했어요"],
  ["disconnected", "연결이 끊겼어요"], ["none", "없었어요"]];
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
const ck = (k) => `bilody_${api.userId()}_${k}`;
const lsGet = (k) => { try { return localStorage.getItem(ck(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(ck(k), v); } catch { /* 저장 못 해도 설문은 계속 */ } };
const checkin = {
  day: () => lsGet("checkin_day"),
  asks: () => (lsGet("checkin_ask_day") === today() ? Number(lsGet("checkin_asks") || 0) : 0),
  ask: () => { const n = checkin.asks() + 1; lsSet("checkin_ask_day", today()); lsSet("checkin_asks", String(n)); },
};

// 사진: 긴 변 768px, 데이터 채널 한 번에 보낼 수 있는 크기 안으로 줄인다
async function preparePhoto(file, maxBytes) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    let side = 768, q = 0.8, data = "";
    const limit = Math.max(20000, maxBytes - 4000);
    for (let n = 0; n < 8; n++) {
      const k = Math.min(1, side / Math.max(img.width, img.height));
      const cv = document.createElement("canvas"); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      data = cv.toDataURL("image/jpeg", q);
      if (data.length <= limit) break;
      if (q > 0.5) q -= 0.15; else side = Math.round(side * 0.8);
    }
    return data;
  } finally { URL.revokeObjectURL(url); }
}

// ---------------- 기록 ----------------
function niceDate(iso) {
  const d = new Date(iso); if (isNaN(d)) return iso;
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function renderHistory() {
  if (S.turns) {
    const practiced = [...new Set(S.turns.filter((t) => t.role !== "user").map((t) => /(?:usually say|we say|you can say),?\s*["“]([^"”]{2,120})["”]/i.exec(t.text)?.[1]).filter(Boolean))];
    return `<div class="list">
      <button class="link" data-act="closeSession">← 목록으로</button>
      ${practiced.length ? `<div class="card lilac"><div class="accent small b">이 대화에서 연습한 표현</div>${practiced.map((p) => `<p class="b">“${esc(p)}”</p>`).join("")}</div>` : ""}
      ${S.turns.map((t, i) => `<div class="bubble ${t.role === "user" ? "me" : ""}">${esc(t.text)}</div>
        ${t.role !== "user" ? `<button class="link tiny" data-act="report" data-v="${i}">문제 알리기</button>` : ""}`).join("")}
    </div>`;
  }
  return `<div class="list">
    ${S.sessions.length ? `<div class="right"><button class="link danger" data-act="deleteAll">전부 지우기</button></div>` : `<div class="empty"><img src="img/char_${byId(S.profile?.character).id}.webp" alt=""><b>아직 저장된 대화가 없어요</b><span class="muted">친구와 이야기하면 여기에 남아요</span></div>`}
    ${S.sessions.map((s) => `<div class="card row">
      <button class="grow left" data-act="openSession" data-v="${s.id}"><b>${esc(S.previews[s.id] ?? "(내가 한 말 없음)")}</b><span class="muted small">${niceDate(s.started_at)}</span></button>
      <button class="icon" data-act="deleteSession" data-v="${s.id}" aria-label="지우기">🗑</button></div>`).join("")}
  </div>`;
}

async function loadHistory() {
  try { [S.sessions, S.previews] = await Promise.all([api.sessions(), api.firstLines()]); } catch (e) { S.error = api.errText(e); }
  render();
}

// ---------------- 설정 ----------------
function section(key, title, summary, body) {
  const open = S.open === key;
  return `<div class="card section ${open ? "open" : ""}">
    <button class="sec-head" data-act="section" data-v="${key}"><b>${title}</b><span class="muted small">${esc(summary)}</span><i>›</i></button>
    ${open ? `<div class="sec-body">${body}</div>` : ""}</div>`;
}

function renderSettings() {
  const p = S.profile ?? {}; const c = byId(p.character);
  const speed = pref.get("speed", 1), vol = pref.get("volume", 1), subs = pref.get("subtitles", false);
  const days = p.transcript_days ?? 30; const memOn = p.memory_enabled !== false;
  return `<div class="list">
    ${section("friend", "친구", `${c.ko} · 이름 ${p.friend_name ?? c.en} · 속도 ${speed.toFixed(1)}배`, `
      <p class="muted small">함께 이야기할 친구를 골라요. 친구마다 성격과 목소리가 달라요. 바꿔도 기억과 대화 기록은 그대로예요.</p>
      ${charPicker(c.id)}
      <div class="row"><span class="grow">${esc(c.intro)}</span><button class="link" data-act="preview">▶ 목소리 듣기</button></div>
      <div class="row"><input id="fname" maxlength="8" value="${esc(p.friend_name ?? c.en)}"><button class="link" data-act="renameFriend">저장</button></div>
      <p class="muted tiny">한글이나 영어로 1~8자. 이름을 바꿔도 성격과 목소리는 그대로예요.</p>
      <hr><b>말 속도 <span id="speedV">${speed.toFixed(1)}</span>배</b>
      <p class="muted small">1.0배가 보통 원어민 대화 속도예요. 바꾸면 다음 문장부터 적용돼요.</p>
      <input type="range" id="speed" min="0.7" max="1.2" step="0.1" value="${speed}">
      <b>목소리 크기</b><input type="range" id="volume" min="0.2" max="1" step="0.05" value="${vol}">`)}
    ${section("subs", "자막", subs ? "켜짐" : "꺼짐", `
      <label class="switch-row"><span>대화 중 자막<br><span class="muted small">켜면 나와 친구의 말이 대화 화면에 글자로 나와요. 꺼도 기록에는 남고, 따라 말하기 카드는 그대로 보여요.</span></span>
      <input type="checkbox" id="subs" ${subs ? "checked" : ""}></label>`)}
    ${section("memory", "기억", `${memOn ? "켜짐" : "꺼짐"} · ${S.memories.length}개`, `
      <label class="switch-row"><span class="muted small">내가 직접 말한 사실만 대화가 끝날 때 기억해요. 끄면 기억을 새로 만들거나 대화에 쓰지 않아요(지우지는 않아요).</span>
      <input type="checkbox" id="memOn" ${memOn ? "checked" : ""}></label>
      ${S.memories.length ? S.memories.map((m) => `<div class="row"><span class="grow small">${esc(m.text)}</span><button class="link tiny" data-act="editMem" data-v="${m.id}">고치기</button><button class="link tiny" data-act="delMem" data-v="${m.id}">지우기</button></div>`).join("") : `<p class="small">아직 기억한 것이 없어요.</p>`}`)}
    ${section("records", "대화 기록 보관", days === 0 ? "저장 안 함" : `${days}일`, `
      <p class="muted small">기간이 지난 대화 기록은 자동으로 지워져요. ‘저장 안 함’이면 새 대화를 기록하지 않고, 기억도 새로 만들지 않아요.</p>
      <div class="seg">${[[30, "30일"], [7, "7일"], [0, "저장 안 함"]].map(([d, l]) => `<button data-act="days" data-v="${d}" class="${days === d ? "on" : ""}">${l}</button>`).join("")}</div>`)}
    ${section("league", "순위", p.league_opt_in !== false ? "참여" : "참여 안 함", `
      <label class="switch-row"><span>이번 주 순위에 나오기<br><span class="muted small">다른 사람에게는 이름 첫 글자만 보여요.</span></span>
      <input type="checkbox" id="league" ${p.league_opt_in !== false ? "checked" : ""}></label>`)}
    ${section("account", "계정", `내 이름 ${p.my_name ?? ""}`, `
      <p class="muted small">친구가 나를 부르는 이름이에요. 영어 글자로 써 주세요.</p>
      <div class="row"><input id="myname" maxlength="20" value="${esc(p.my_name ?? "")}"><button class="link" data-act="renameMe">저장</button></div>
      <button class="link" data-act="signOut">로그아웃</button><br>
      <button class="link danger" data-act="deleteAccount">탈퇴하기</button>`)}
    ${section("help", "도움말", "사용 안내 · 문의하기", `
      <button class="link" data-act="guide">사용 안내 보기</button><br>
      <button class="link" data-act="inquiry">문의하기</button><br>
      <button class="link" data-act="openCheckin">오늘 대화 의견 남기기</button>
      <p class="muted tiny">앱을 쓸 수 없을 때는 초대해 준 운영자에게 연락해 주세요(삭제 요청 포함).</p>
      <p class="muted tiny">웹 시험판에는 알림과 동화 듣기가 아직 없어요.</p>`)}
    <p class="muted tiny center-text">bilody ${VERSION} · 비공개 시험판</p>
  </div>`;
}

// ---------------- 창(대화상자) ----------------
function renderDialog() {
  const d = S.dialog; if (!d) return "";
  const box = (inner) => `<div class="overlay" data-act="closeDialog"><div class="dialog" data-stop>${inner}</div></div>`;
  if (d.kind === "confirm") return box(`<h2>${esc(d.title)}</h2><p>${esc(d.text ?? "")}</p>
    <div class="row end"><button class="link" data-act="closeDialog">취소</button><button class="link ${d.danger ? "danger" : ""}" data-act="confirmYes">${esc(d.yes)}</button></div>`);
  if (d.kind === "guide") return `<div class="overlay full"><div class="guide-page">
    <div class="row"><button class="link" data-act="closeDialog">← 닫기</button><b class="grow">사용 안내</b></div>
    ${GUIDE.map((g, i) => `<details class="card" ${i === 0 ? "open" : ""}><summary><b>${esc(g.title)}</b></summary><p>${esc(g.intro)}</p>
      ${g.items.map(([k, v]) => `<p><b class="accent">${esc(k)}</b><br>${esc(v)}</p>`).join("")}</details>`).join("")}</div></div>`;
  if (d.kind === "inquiry") return box(`<h2>문의하기</h2>
    ${[["question", "사용 방법"], ["bug", "오류·불편"], ["idea", "의견"], ["delete", "데이터 삭제 요청"]].map(([v, l], i) => `<label class="radio"><input type="radio" name="cat" value="${v}" ${i === 0 ? "checked" : ""}> ${l}</label>`).join("")}
    <textarea id="inq" rows="5" placeholder="내용을 적어 주세요. 대화 기록은 자동으로 붙지 않아요."></textarea>
    <div class="row end"><button class="link" data-act="closeDialog">취소</button><button class="link" data-act="sendInquiry">보내기</button></div>`);
  if (d.kind === "checkin") return box(`<h2>오늘 대화는 어땠어요?</h2><p class="muted small">30초면 끝나요. 남겨 주신 의견은 방금 대화와 함께 보고 고칠게요.</p>
    <div class="faces">${["😣", "😕", "😐", "🙂", "😄"].map((f, i) => `<button class="face ${d.rating === i + 1 ? "on" : ""}" data-act="ckRate" data-v="${i + 1}" aria-label="${i + 1}점">${f}</button>`).join("")}</div>
    <b class="small">불편한 게 있었나요? (여러 개 골라도 돼요)</b>
    ${CHECKIN_ISSUES.map(([v, l]) => `<label class="radio"><input type="checkbox" data-ck="${v}"> ${l}</label>`).join("")}
    <textarea id="cknote" rows="2" maxlength="500" placeholder="무슨 일이 있었는지 한 줄로 (선택) 예: 여행 얘기를 했는데 계속 다른 질문만 했어요"></textarea>
    <div class="row end"><button class="link" data-act="closeDialog">다음에 할게요</button><button class="link" data-act="sendCheckin" ${d.rating ? "" : "disabled"}>보내기</button></div>`);
  if (d.kind === "editMem") return box(`<h2>기억 고치기</h2><textarea id="memText" rows="3">${esc(d.text)}</textarea>
    <div class="row end"><button class="link" data-act="closeDialog">취소</button><button class="link" data-act="saveMem">저장</button></div>`);
  if (d.kind === "board") return box(`<h2>이번 주 순위 🏆</h2><p class="muted small">5분 이상 이야기한 날 10점 + 1분마다 1점(하루 최대 30점). 매주 월요일에 새로 시작해요. 다른 사람 이름은 첫 글자만 보여요.</p>
    ${d.rows.length ? d.rows.map((r) => `<div class="row board ${r.me ? "me" : ""}"><span class="rank">${["🥇", "🥈", "🥉"][r.rank - 1] ?? r.rank}</span><i class="dot" style="background:${dotColor(r.color)}"></i><span class="grow">${esc(r.name)}${r.me ? " (나)" : ""}</span><b>${r.points}점</b></div>`).join("") : `<p>아직 이번 주 기록이 없어요. 오늘 5분이면 바로 올라가요!</p>`}
    <div class="row end"><button class="link" data-act="closeDialog">닫기</button></div>`);
  if (d.kind === "photoPick") return box(`<h2>사진 보여 주기</h2><p class="muted small">보여 준 사진은 저장하지 않아요. 사람 얼굴보다 물건이 잘 맞아요.</p>
    <button class="pill primary" data-act="camera">📷 사진 찍기</button><button class="pill secondary" data-act="gallery">🖼 앨범에서 고르기</button>
    <div class="row end"><button class="link" data-act="closeDialog">취소</button></div>`);
  if (d.kind === "report") return box(`<h2>이 답변의 문제 알리기</h2><p class="small">아래 문장만 운영자에게 보내져요. 다른 대화는 보내지 않아요.</p>
    ${d.lines.map((l) => `<p class="quote">${l.role === "user" ? "나" : "친구"}: ${esc(l.text)}</p>`).join("")}
    ${[["unsafe", "불쾌하거나 위험한 말"], ["wrong", "틀린 내용·잘못된 교정"], ["odd", "엉뚱한 대답"], ["other", "기타"]].map(([v, l], i) => `<label class="radio"><input type="radio" name="rcat" value="${v}" ${i === 1 ? "checked" : ""}> ${l}</label>`).join("")}
    <textarea id="rnote" rows="2" placeholder="덧붙일 말(선택)"></textarea>
    <label class="radio"><input type="checkbox" id="ragree"> 위 문장을 운영자에게 보내는 데 동의해요</label>
    <div class="row end"><button class="link" data-act="closeDialog">취소</button><button class="link" data-act="sendReport">보내기</button></div>`);
  return "";
}

function confirm(title, text, yes, onYes, danger = false) { S.dialog = { kind: "confirm", title, text, yes, onYes, danger }; render(); }

// ---------------- 누름 처리 ----------------
app.addEventListener("click", async (e) => {
  const stop = e.target.closest("[data-stop]");
  const el = e.target.closest("[data-act]"); if (!el) return;
  if (stop && el.dataset.act === "closeDialog" && el.classList.contains("overlay")) return;
  const act = el.dataset.act, v = el.dataset.v;
  const p = S.profile;
  switch (act) {
    case "mode": S.authMode = v; S.error = null; render(); break;
    case "auth": {
      const email = $("#email").value.trim(), pw = $("#pw").value, code = $("#code")?.value.trim().toUpperCase();
      if (!email || !pw || (S.authMode !== "login" && !code)) { S.error = "빈칸을 채워 주세요."; return render(); }
      await work(async () => { if (S.authMode !== "login") await api.redeemInvite(code, email, pw); await api.signIn(email, pw); await refresh(); });
      break;
    }
    case "agree": await work(async () => { await api.saveConsents(CONSENT_ITEMS.map((x) => x[0]), CONSENT_VERSION); await refresh(); }); break;
    case "pick": {
      if (S.stage === "names") {
        const d = S.nameDraft; d.friend = $("#friend").value; d.me = $("#me").value;
        if (d.friend.trim() === byId(d.character).en) d.friend = byId(v).en;
        d.character = v; render();
      } else if (v !== p?.character) {
        const c = byId(v);
        confirm(`${c.ko}로 바꿀까요?`, `친구 이름도 ${c.en}로 바뀌어요. 지금까지의 기억과 대화 기록은 그대로 남아요.`, "바꾸기", async () => {
          await work(async () => { await api.saveProfile({ friendName: c.en, myName: p.my_name, presetId: p.preset_id, color: c.colorId, character: c.id }); S.profile = await api.loadProfile(); });
          toast(S.chat ? `${c.ko}로 바꿨어요. 다음 대화부터 ${c.ko}가 이야기해요.` : `${c.ko}로 바꿨어요.`);
        });
      }
      break;
    }
    case "saveNames": {
      const d = S.nameDraft; d.friend = $("#friend").value.trim(); d.me = $("#me").value.trim();
      if (!validFriendName(d.friend)) { S.error = "친구 이름은 한글이나 영어로 1~8자로 써 주세요."; return render(); }
      if (!validMyName(d.me)) { S.error = "내 이름은 영어 글자로 1~20자로 써 주세요. 친구가 영어로 불러 줘요."; return render(); }
      const c = byId(d.character);
      await work(async () => { await api.saveProfile({ friendName: d.friend, myName: d.me, presetId: p?.preset_id ?? "rt-voice", color: c.colorId, character: c.id }); await refresh(); });
      break;
    }
    case "tab": {
      if (v === "history" && S.chat) await endChat();
      S.tab = v; S.error = null; S.turns = null; render();
      if (v === "history") loadHistory();
      if (v === "settings") { try { S.memories = await api.memories(); } catch { /* */ } render(); }
      break;
    }
    case "guideSeen": pref.set("guideSeen", true); render(); break;
    case "board": S.dialog = { kind: "board", rows: await api.weeklyBoard() }; render(); break;
    case "start": await startChat(); break;
    case "pause": S.chat?.stop(); break;
    case "restart": player.unlock(); await S.chat?.restart(); break;
    case "exit": await endChat(); break;
    case "send": { const i = $("#say"); S.chat?.sendText(i.value); i.value = ""; break; }
    case "dismissCard": S.chat?.dismissCard(); break;
    case "clearPhoto": S.chat?.clearPhoto(); break;
    case "photo": S.dialog = { kind: "photoPick" }; render(); break;
    case "camera": case "gallery": { S.dialog = null; render(); S.chat?.holdForCamera(true); $(act === "camera" ? "#camera" : "#gallery").click(); break; }
    case "openSession": S.openSession = v; await work(async () => { S.turns = await api.turns(v); }); break;
    case "closeSession": S.turns = null; S.openSession = null; render(); break;
    case "deleteSession": confirm("이 대화를 지울까요?", "지운 기록은 되돌릴 수 없어요.", "지우기", async () => { await work(() => api.deleteSession(v)); loadHistory(); }, true); break;
    case "deleteAll": confirm("모든 대화 기록을 지울까요?", "지운 기록은 되돌릴 수 없어요.", "전부 지우기", async () => { await work(() => api.deleteAllSessions()); loadHistory(); }, true); break;
    case "report": {
      const i = Number(v); const lines = [S.turns[i - 1]?.role === "user" ? S.turns[i - 1] : null, S.turns[i]].filter(Boolean);
      S.dialog = { kind: "report", lines }; render(); break;
    }
    case "sendReport": {
      if (!$("#ragree").checked) return toast("동의에 체크해 주세요.");
      const cat = document.querySelector("input[name=rcat]:checked").value; const note = $("#rnote").value.trim(); const lines = S.dialog.lines;
      S.dialog = null; await work(() => api.sendFeedback("report", cat, note, lines.map((l) => ({ role: l.role, text: l.text })), S.openSession)); toast("보냈어요. 고마워요!"); break;
    }
    case "section": S.open = S.open === v ? null : v; render(); break;
    case "preview": {
      player.unlock(); const c = byId(p?.character);
      try { const s = await api.say("Hi! I'm so happy to see you. What did you have for lunch today?", c.voice, pref.get("speed", 1), null, true); player.setVolume(pref.get("volume", 1)); await player.play(s.pcm, s.rate); }
      catch (err) { toast(api.errText(err)); }
      break;
    }
    case "renameFriend": {
      const n = $("#fname").value.trim(); if (!validFriendName(n)) return toast("친구 이름은 한글이나 영어로 1~8자로 써 주세요.");
      await work(async () => { await api.saveProfile({ friendName: n, myName: p.my_name, presetId: p.preset_id, color: p.color, character: p.character }); S.profile = await api.loadProfile(); });
      toast("저장했어요."); break;
    }
    case "renameMe": {
      const n = $("#myname").value.trim(); if (!validMyName(n)) return toast("내 이름은 영어 글자로 1~20자로 써 주세요.");
      await work(async () => { await api.saveProfile({ friendName: p.friend_name, myName: n, presetId: p.preset_id, color: p.color, character: p.character }); S.profile = await api.loadProfile(); });
      toast("저장했어요."); break;
    }
    case "days": await work(async () => { await api.patchProfile({ transcript_days: Number(v) }); S.profile = await api.loadProfile(); }); break;
    case "editMem": S.dialog = { kind: "editMem", id: v, text: S.memories.find((m) => String(m.id) === v)?.text ?? "" }; render(); break;
    case "saveMem": { const t = $("#memText").value.trim(); const id = S.dialog.id; S.dialog = null; if (t) await work(async () => { await api.updateMemory(id, t); S.memories = await api.memories(); }); break; }
    case "delMem": await work(async () => { await api.deleteMemory(v); S.memories = await api.memories(); }); break;
    case "signOut": if (S.chat) await endChat(); api.signOut(); S.profile = null; S.stage = "auth"; render(); break;
    case "deleteAccount": confirm("정말 탈퇴할까요?", "계정과 모든 대화 기록·기억·작동 기록이 지워지고 되돌릴 수 없어요. 외부 AI 업체 쪽에 남은 처리 기록은 업체의 보관 기간이 지나면 지워져요.", "탈퇴", async () => { await work(async () => { await api.deleteAccount(); S.stage = "auth"; }); }, true); break;
    case "guide": S.dialog = { kind: "guide" }; render(); break;
    case "openCheckin": { const sid = (await api.sessions().catch(() => []))[0]?.id ?? null; S.dialog = { kind: "checkin", sid, rating: 0 }; render(); break; }
    case "ckRate": {
      // 고른 항목·적은 글을 지우지 않고 얼굴만 바꾼다
      S.dialog.rating = Number(v);
      document.querySelectorAll(".face").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
      $("[data-act=sendCheckin]").disabled = false; break;
    }
    case "sendCheckin": {
      const issues = [...document.querySelectorAll("[data-ck]:checked")].map((x) => x.dataset.ck);
      const note = $("#cknote").value; const { sid, rating } = S.dialog; S.dialog = null;
      await work(async () => { await api.saveCheckin(sid, rating, issues, note); lsSet("checkin_day", today()); });
      toast("고마워요! 의견을 잘 받았어요."); break;
    }
    case "inquiry": S.dialog = { kind: "inquiry" }; render(); break;
    case "sendInquiry": {
      const body = $("#inq").value.trim(); if (!body) return toast("내용을 적어 주세요.");
      const cat = document.querySelector("input[name=cat]:checked").value; S.dialog = null;
      await work(() => api.sendFeedback("inquiry", cat, body)); toast("보냈어요. 확인하고 연락드릴게요."); break;
    }
    case "closeDialog": if (!stop || el === e.target) { S.dialog = null; render(); } break;
    case "confirmYes": { const f = S.dialog.onYes; S.dialog = null; render(); await f(); break; }
  }
});

app.addEventListener("change", async (e) => {
  const t = e.target; const p = S.profile;
  if (t.dataset.consent !== undefined) { const all = [...document.querySelectorAll("[data-consent]")].every((x) => x.checked); $("[data-act=agree]").disabled = !all; t.closest("label").classList.toggle("on", t.checked); }
  if (t.id === "speed") { pref.set("speed", Number(t.value)); if (S.chat) S.chat.speed = Number(t.value); render(); }
  if (t.id === "volume") { pref.set("volume", Number(t.value)); player.setVolume(Number(t.value)); }
  if (t.id === "subs") { pref.set("subtitles", t.checked); render(); }
  if (t.id === "memOn") await work(async () => { await api.patchProfile({ memory_enabled: t.checked }); S.profile = await api.loadProfile(); });
  if (t.id === "league") await work(async () => { await api.patchProfile({ league_opt_in: t.checked }); S.profile = await api.loadProfile(); });
  if (t.id === "camera" || t.id === "gallery") {
    const f = t.files?.[0]; t.value = "";
    S.chat?.holdForCamera(false);
    if (!f || !S.chat) return;
    try { const data = await preparePhoto(f, S.chat.maxMsg); S.chat.sendImage(data, data); } catch { toast("사진을 열지 못했어요."); }
  }
  void p;
});
app.addEventListener("input", (e) => { if (e.target.id === "speed") { const s = $("#speedV"); if (s) s.textContent = Number(e.target.value).toFixed(1); } });
app.addEventListener("keydown", (e) => { if (e.target.id === "say" && e.key === "Enter") { S.chat?.sendText(e.target.value); e.target.value = ""; } });

// 다른 앱으로 나가면 대화와 마이크를 멈춘다(사진 고르러 간 경우는 제외). 돌아와도 저절로 말하지 않는다.
document.addEventListener("visibilitychange", () => { if (document.hidden) S.chat?.pauseForBackground(); });
window.addEventListener("focus", () => { setTimeout(() => { if (S.chat?.cameraHold) S.chat.holdForCamera(false); }, 1500); });

refresh();
