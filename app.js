// bilody 웹 시험판(아이폰 Safari용). 안드로이드 앱과 같은 서버·계정·친구·기억을 쓴다.
import * as api from "./api.js?v=0.8.4";
import { CONSENT_VERSION, VERSION } from "./config.js?v=0.8.4";
import { CHARACTERS, byId, dotColor, validFriendName, validMyName, animSrc, eunNeun, iGa, gwaWa } from "./characters.js?v=0.8.4";
import { GUIDE } from "./guide.js?v=0.8.4";
import { Player } from "./audio.js?v=0.8.4";
import { Chat } from "./rt.js?v=0.8.4";
import * as story from "./story.js?v=0.8.4";
import * as push from "./push.js?v=0.8.4";
import { LessonManager, loadLib as loadLessons, lessonShell, lessonImage, lessonBody, resumeId as lessonResume } from "./lesson.js?v=0.8.4";

const $ = (sel, root = document) => root.querySelector(sel);
/** 앱과 같은 아이콘(Material Icons Round). o=true면 테두리형(Outlined). */
const I = (name, cls = "", o = false) => `<i class="${o ? "mo" : "mi"} ${cls}" aria-hidden="true">${name}</i>`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const app = $("#app");
const player = new Player();

// ---------------- 이 기기에만 저장하는 설정 ----------------
const pref = {
  get(k, d) { try { const v = localStorage.getItem(`bilody_${api.userId() ?? "anon"}_${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`bilody_${api.userId() ?? "anon"}_${k}`, JSON.stringify(v)); } catch { /* */ } },
};

const S = { stage: "loading", profile: null, progress: null, tab: "chat", chat: null, story: null, toast: null, busy: false, error: null,
  sessions: [], previews: {}, openSession: null, turns: null, memories: [], open: null, dialog: null,
  kidsAvailable: false, presetLabel: "", reminder: null };

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
    if (S.stage === "main") {
      const [pr, ps, rem] = await Promise.all([api.myProgress(), api.presets(), push.load()]);
      S.progress = pr; S.kidsAvailable = ps.some((x) => x.id === "kids-demo");
      S.presetLabel = (ps.find((x) => x.id === (S.profile?.preset_id ?? "rt-voice")) ?? ps[0])?.label ?? "";
      S.reminder = rem ?? { on: false, hour: pref.get("remHour", 20), minute: pref.get("remMinute", 0) };
    }
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
  if (S.stage === "main" && wantsPostSurvey() && !S.postOpened) { S.postOpened = true; openPostSurvey(); }
}

/** 앱의 OutlinedTextField처럼 이름표가 테두리 위로 올라가는 입력칸. */
const field = (id, label, attrs = "", value = "") => `<label class="field"><input id="${id}" placeholder=" " value="${esc(value)}" ${attrs}><span>${label}</span></label>`;

function renderAuth() {
  if (!S.authMode && wantsPostSurvey()) S.authMode = "login";   // 설문 링크로 왔으면 로그인 화면부터
  const signup = S.authMode !== "login";
  return `<div class="page center-col">
    <img class="logo-stacked" src="img/logo_stacked.png" alt="bilody">
    <p class="muted center-text">초대받은 성인만 이용할 수 있는 비공개 시험판이에요</p>
    <div class="card form">
      <div class="seg">
        <button data-act="mode" data-v="signup" class="${signup ? "on" : ""}">초대 코드로 가입</button>
        <button data-act="mode" data-v="login" class="${signup ? "" : "on"}">로그인</button>
      </div>
      ${signup ? field("code", "초대 코드", `autocapitalize="characters" autocomplete="off"`) : ""}
      ${field("email", "이메일", `type="email" autocomplete="email"`)}
      ${field("pw", signup ? "비밀번호(8자 이상)" : "비밀번호", `type="password" autocomplete="${signup ? "new-password" : "current-password"}"`)}
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
      ${field("friend", "친구 이름", `maxlength="8"`, d.friend)}
      ${field("me", "내 이름(영어로, 예: Hyemin)", `maxlength="20" autocapitalize="words"`, d.me)}
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
      ${[["chat", "대화", "chat_bubble", "chat_bubble_outline", false], ["history", "기록", "history", "history", false], ["settings", "설정", "settings", "settings", true]].map(([k, l, on, off, outlined]) =>
        `<button data-act="tab" data-v="${k}" class="${S.tab === k ? "on" : ""}"><span class="ti">${S.tab === k ? I(on) : I(off, "", outlined)}</span>${l}</button>`).join("")}
    </nav>
  </div>`;
}

// ---------------- 대화 ----------------
function renderChat() {
  if (S.story) return renderStory();
  const p = S.profile; const c = byId(p?.character); const pr = S.progress;
  const chat = S.chat; const fname = esc(p?.friend_name ?? c.en);
  const r = S.reminder;
  const home = !chat ? `
    <div class="streak card">
      <div class="ring" style="--p:${Math.min(1, (pr?.today_seconds ?? 0) / 300)}"><span>${(pr?.streak ?? 0) > 0 ? "🔥" : "🌱"}</span></div>
      <div class="grow"><b>${gwaWa(fname)} ${(pr?.streak ?? 0) > 0 ? `${pr.streak}일째` : "첫날"}</b>
        <div class="muted small">${pr?.done_today ? "오늘 5분 완료! ✨" : `오늘 ${Math.floor((pr?.today_seconds ?? 0) / 60)}분 · 목표 5분`}</div></div>
      <button class="points" data-act="board"><b>${pr?.week_points ?? 0}</b><span>이번 주 🏆</span></button>
    </div>
    <button class="alarm-line" data-act="notifyTime">${I("alarm")}${r?.on ? `매일 ${hhmm(r.hour, r.minute)}에 알림` : "알림 시간 정하기"}</button>` : "";
  const guide = !chat && !pref.get("guideSeen", false) ? `<div class="card guide"><b>이렇게 이야기해요</b><ul>
      <li>‘대화 시작’을 누르면 ${iGa(fname)} 먼저 인사해요.</li>
      <li>마이크가 빨갛게 켜지면 편하게 말하세요. 짧게 말해도, 한국어를 섞어도 괜찮아요.</li>
      <li>${iGa(fname)} 말하는 도중에 말해도 돼요. 하던 말을 멈추고 들어줘요. 생각할 시간이 필요하면 “Wait”라고 말해 보세요.</li>
      <li>어색한 표현은 ${iGa(fname)} 자연스럽게 바꿔 알려줘요. 한 번 따라 말해 보세요.</li>
      ${push.isIOS() ? "<li>아이폰은 무음 모드를 끄고 소리를 키워 주세요.</li>" : ""}</ul>
      <div class="right"><button class="link" data-act="guideSeen">알겠어요</button></div></div>` : "";
  return `<div class="chat">
    <div class="chat-top">${home}
      <div class="stage ${chat ? "" : "small"}"><img id="friendImg" class="friend" src="${animSrc(c.id, "idle")}" alt=""></div>
      <div class="status"><i></i><span id="stLabel">대기</span><em></em><span id="micLabel" class="mic">${I("mic_off")}마이크 꺼짐</span></div>
      <p class="ai-note">${eunNeun(fname)} AI 친구예요. 대답과 목소리는 AI가 만들어요.</p>
      <p id="remain" class="accent tiny b"></p><p id="latency" class="ai-note"></p>
      <div id="photo"></div>
    </div>
    <div id="webPic"></div>
    <div id="lesson"></div>
    <div id="card"></div>
    <div id="lines" class="lines"></div>
    ${guide}
    <p id="notice" class="error"></p>
    <div class="controls" id="controls">${chat ? "" : `
      <button class="pill primary grow" data-act="start">${I("mic")}대화 시작</button>
      ${S.kidsAvailable ? `<button class="pill secondary grow" data-act="storyPick">${I("auto_stories")}그림책 보기</button>` : ""}`}</div>
    <div class="inputbar ${chat ? "" : "hidden"}" id="inputbar">
      <button class="round lilac" data-act="photo" aria-label="사진 보여 주기">${I("add_a_photo")}</button>
      <input id="say" placeholder="글로 말하기" maxlength="300" enterkeyhint="send" autocomplete="off">
      <button class="round send" data-act="send" aria-label="보내기" disabled>${I("send")}</button>
    </div>
    <input type="file" id="camera" accept="image/*" capture="environment" hidden>
    <input type="file" id="gallery" accept="image/*" hidden>
  </div>`;
}

const hhmm = (h, m) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

/** 대화 중 자주 바뀌는 부분만 고친다(글 입력칸 포커스를 지키려고 전체를 다시 그리지 않음). */
function updateChat() {
  if (S.stage !== "main" || S.tab !== "chat") return;
  if (S.story) return updateStory();
  const chat = S.chat; const u = chat?.ui; const c = byId(S.profile?.character);
  const img = $("#friendImg"); if (!img) return;
  const src = animSrc(c.id, u?.state ?? "idle"); if (!img.src.endsWith(src)) img.src = src;
  $("#stLabel").textContent = u?.searching ? "찾아보는 중" : STATE_LABEL[u?.state ?? "idle"];
  const mic = $("#micLabel"); const micKey = u?.micOn ? "on" : "off";
  if (mic.dataset.k !== micKey) { mic.dataset.k = micKey; mic.innerHTML = u?.micOn ? `${I("mic")}마이크 켜짐` : `${I("mic_off")}마이크 꺼짐`; mic.classList.toggle("on", !!u?.micOn); }
  $("#remain").textContent = u?.remainingMinutes ? `오늘 남은 대화 시간 약 ${u.remainingMinutes}분` : "";
  $("#latency").textContent = chat ? `지금 대화: ${S.presetLabel}${u?.lastLatencyMs ? ` · 마지막 대답 ${(u.lastLatencyMs / 1000).toFixed(1)}초` : ""}` : "";
  $("#notice").textContent = u?.notice ?? "";
  $("#photo").innerHTML = u?.photo ? `<div class="photo-card" data-act="clearPhoto"><img src="${u.photo}" alt="보여 준 사진"></div>` : "";
  // 친구가 띄운 단어 사진(11/13). 사진을 누르면 닫히고, 출처를 누르면 사진 사이트의 사진 페이지가 열린다(사이트 조건).
  const wp = u?.webPicture; const wpKey = wp ? String(wp.seq) : "";
  if ($("#webPic").dataset.key !== wpKey) {
    $("#webPic").dataset.key = wpKey;
    const old = $("#webPic").firstElementChild;
    if (!wp && old) {   // 닫힐 때: 살짝 위로 사라진 뒤 지운다
      old.classList.add("leave"); setTimeout(() => { if ($("#webPic")?.dataset.key === "") $("#webPic").innerHTML = ""; }, 220);
    } else $("#webPic").innerHTML = wp ? `<div class="card webpic enter"><img src="${esc(wp.url)}" alt="${esc(wp.word)}" data-act="dismissWebPicture">
      <div class="webpic-row"><b>${esc(wp.word)}</b><a href="${esc(wp.pageUrl)}" target="_blank" rel="noopener">${esc(wp.photographer ? `Photo: ${wp.photographer} · ${wp.source}` : wp.source)}</a></div></div>` : "";
  }
  const card = u?.card;
  const cardKey = card ? card.text + "|" + (card.chunk ?? "") : "";
  if ($("#card").dataset.key !== cardKey) {
    $("#card").dataset.key = cardKey;
    const pics = card && !card.practice ? cardPics(card.text) : [];
    const fn = esc(S.profile?.friend_name ?? "친구");
    $("#card").innerHTML = card ? `<div class="card help enter" data-act="dismissCard">
      <div class="accent tiny b">${card.chunk ? "한 부분씩 따라 말해 보세요" : card.practice ? "따라 말해 보세요" : card.rephrased ? `${iGa(fn)} 쉽게 다시 말했어요` : `${iGa(fn)} 다시 말했어요`}</div>
      <div class="help-text ${card.practice ? "big" : ""}">${highlight(card)}</div>
      ${pics.length ? `<div class="help-pics">${pics.map((x) => `<img src="${story.picUrl(x)}" alt="${esc(x)}">`).join("")}</div>` : ""}</div>` : "";
  }
  const subs = pref.get("subtitles", false);
  $("#lines").innerHTML = subs && u ? u.lines.slice(-8).map((l) => `<div class="bubble ${l.role === "user" ? "me" : ""}">${esc(l.text)}</div>`).join("") : "";
  if (chat) {
    const running = !["stopped", "disconnected"].includes(u.state);
    const lessonBtn = !!S.lesson && running && !S.lesson.active;
    const ctl = `${running}|${u.canRestart}|${lessonBtn}`;
    if ($("#controls").dataset.k !== ctl) {
      $("#controls").dataset.k = ctl;
      $("#controls").innerHTML = `
      <button class="pill dark compact" data-act="pause" ${running ? "" : "disabled"}>${I("pause")}일시정지</button>
      <button class="pill primary compact" data-act="restart" ${u.canRestart && !running ? "" : "disabled"}>${I("refresh")}다시 시작</button>
      <button class="pill secondary compact narrow" data-act="exit">나가기</button>
      ${lessonBtn ? `<button class="pill lesson-open" data-act="lessonOpen">${I("menu_book")}교재로 배우기</button>` : ""}`;
    }
    renderLesson();
    $("#inputbar").classList.remove("hidden");
  }
}

// ---------------- 교재 카드(11/14): 그림은 lesson.js lessonShell·lessonBody ----------------
function renderLesson() {
  const box = $("#lesson"); if (!box) return;
  const u = S.lesson?.ui; const mic = !!S.chat?.ui.micOn;
  if (!u) { if (box.innerHTML) box.innerHTML = ""; box.dataset.shell = ""; box.dataset.key = ""; return; }
  // 겉틀(제목·그림)은 교재·단계가 바뀔 때만 새로 그리고, 처음 나타날 때만 올라오는 움직임
  const shell = `${u.title}|${u.phase}`;
  if (box.dataset.shell !== shell) { const enter = !box.dataset.shell; box.dataset.shell = shell; box.innerHTML = lessonShell(u, esc, I, enter); box.dataset.key = ""; }
  const key = JSON.stringify(u) + (mic ? "|m" : "");
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  lessonImage(box, u);
  box.querySelector(".lesson-body").innerHTML = lessonBody(u, mic, esc, I);
}

/** 쉽게 다시 말한 카드에 붙일 단어 그림(앱과 같이 최대 3개). 그림 묶음이 아직 없으면 불러온 뒤 다시 그린다. */
let picLib = null;
function cardPics(text) {
  if (!picLib) {
    story.loadLib().then((l) => story.loadCommon().then(() => { picLib = l; const k = $("#card"); if (k) k.dataset.key = ""; updateChat(); })).catch(() => {});
    return [];
  }
  const have = new Set(picLib.pics);
  return [...new Set((text.match(/[A-Za-z']+/g) ?? []).map((w) => picLib.match[w.toLowerCase().replace(/^'+|'+$/g, "")]).filter((x) => x && have.has(x)))].slice(0, 3);
}

function highlight(card) {
  const t = card.text; const ch = card.chunk?.replace(/[.!?,]+$/, "");
  if (!ch) return esc(t);
  const i = t.toLowerCase().indexOf(ch.toLowerCase());
  if (i < 0) return `${esc(t)}<div class="accent b">지금: “${esc(card.chunk)}”</div>`;
  return `<span class="dim">${esc(t.slice(0, i))}</span><mark>${esc(t.slice(i, i + ch.length))}</mark><span class="dim">${esc(t.slice(i + ch.length))}</span>`;
}

// ---------------- 동화 듣기(앱과 같은 화면) ----------------
function renderStory() {
  const u = S.story.ui; const p = S.profile;
  return `<div class="story" id="story" style="background:${esc(u.bg)}">
    <div class="st-head"><div class="grow"><b id="stTitle">${esc(u.title)}</b><div id="stSub"></div>
      ${(p?.character ?? "tori") !== "tori" ? `<div class="st-sub">그림책은 토리가 읽어 줘요</div>` : ""}</div>
      <span class="micchip" id="stMic">${I("mic_off")}마이크 꺼짐</span></div>
    <div class="st-main" id="stMain"><div class="st-pages" id="stPages"></div>
      <img id="stTori" class="st-tori" src="${animSrc("tori", "idle")}" alt=""></div>
    <p id="stLine" class="st-line"></p><p id="stNotice" class="error st-pad"></p>
    <p id="stCredit" class="st-credit"></p>
    <div class="controls st-pad" id="stCtl"></div>
    <div id="zoom"></div>
  </div>`;
}

function updateStory() {
  const st = S.story; const u = st.ui; const root = $("#story"); if (!root) return;
  root.style.background = u.bg;
  $("#stTitle").textContent = u.title;
  $("#stSub").innerHTML = u.quiz ? quizStars(u.quiz) : `<span class="st-sub">${u.page}/${u.pages}쪽 · 어른 목소리로만</span>`;
  const tsrc = animSrc("tori", u.state); const t = $("#stTori"); if (!t.src.endsWith(tsrc)) t.src = tsrc;
  // 쪽(그림·단어 카드)은 쪽이 바뀔 때만 새로 그린다 → 지금 읽는 단어 카드만 튀어 오르게
  const pageKey = `${u.storyId}|${u.page}|${u.image}|${u.image ? "" : u.picture}`;
  const pages = $("#stPages");
  if (st.book && pages.dataset.k !== pageKey) { pages.dataset.k = pageKey; pages.innerHTML = storyPage(u); pages.dataset.seq = ""; }
  if (pages.dataset.seq !== String(u.pictureSeq)) {
    pages.dataset.seq = String(u.pictureSeq);
    pages.querySelectorAll(".chip").forEach((c) => { const on = c.dataset.v === u.picture; c.classList.toggle("on", on); if (on) { c.classList.remove("pop"); void c.offsetWidth; c.classList.add("pop"); } });
    const big = pages.querySelector(".bigpic"); if (big) { big.classList.remove("pop"); void big.offsetWidth; big.classList.add("pop"); }
  }
  $("#stLine").textContent = pref.get("subtitles", false) ? u.line : "";
  $("#stNotice").textContent = u.notice ?? u.talkNotice ?? "";
  const mic = $("#stMic"); const mk = u.micOn ? "on" : "off";
  if (mic.dataset.k !== mk) { mic.dataset.k = mk; mic.classList.toggle("on", !!u.micOn); mic.innerHTML = u.micOn ? `${I("mic")}마이크 켜짐` : `${I("mic_off")}마이크 꺼짐`; }
  $("#stCredit").textContent = u.credit ? `${u.credit} · StoryWeaver` : "";
  const live = u.state !== "stopped";
  const ck = `${u.canRestart}|${live}`;
  if ($("#stCtl").dataset.k !== ck) {
    $("#stCtl").dataset.k = ck;
    $("#stCtl").innerHTML = (u.canRestart ? `<button class="pill primary grow" data-act="storyResume">${I("play_arrow")}이어서</button>`
      : `<button class="pill dark grow" data-act="storyPause" ${live ? "" : "disabled"}>${I("pause")}일시정지</button>`)
      + `<button class="pill secondary" data-act="storyExit">나가기</button>`;
  }
}

function quizStars(q) {
  return `<span class="quiz"><b>그림 찾기 놀이</b>${Array.from({ length: q.rounds }, (_, i) => (i < q.stars ? I("star", "star on") : I("star_border", "star"))).join("")}</span>`;
}

/** 이 쪽의 단어 그림: 동화 그림 바로 위·아래에 나눠 띄운다(아래 줄은 토리를 피해 왼쪽, 최대 2개). */
function storyPage(u) {
  const st = S.story; const book = st.book; const lib = st.lib;
  const pg = book?.pages[u.page - 1];
  const have = new Set(lib?.pics ?? []);
  const label = (x) => esc((lib.words[x]?.text ?? x).replace(/[!.]+$/, ""));
  const pics = pg ? [...new Set([...(pg.cues ?? []).map((c) => c.pic), ...(pg.see ?? [])])].filter((x) => have.has(x)) : [];
  const nBottom = Math.min(2, Math.floor(pics.length / 2));
  const top = pics.slice(0, pics.length - nBottom), bottom = pics.slice(pics.length - nBottom);
  const chips = (list, off, cls) => (list.length ? `<div class="chips ${cls}"><div class="chips-in">${list.map((x, i) =>
    `<button class="chip ${(i + off) % 2 === 0 ? "tl" : "tr"}" data-act="storyTap" data-v="${esc(x)}"><img src="${story.picUrl(x)}" alt=""><span>${label(x)}</span></button>`).join("")}</div></div>` : "");
  const img = u.image ? `<div class="st-imgbox"><img class="st-img" src="${st.pageImg(u.image)}" alt=""></div>` : "";
  const big = !u.image && u.picture && have.has(u.picture)
    ? `<button class="bigpic" data-act="storyTap" data-v="${esc(u.picture)}"><img src="${story.picUrl(u.picture)}" alt=""><span>${label(u.picture)}</span></button>` : "";
  return chips(top, 0, "mid") + img + big + chips(bottom, top.length, "lead");
}

/** 단어 그림을 누르면 그 카드 자리에서 화면 가운데로 날아오며 크게(약 2.6초 뒤 또는 누르면 사라짐). */
function zoomWord(pic, fromEl) {
  const z = $("#zoom"); if (!z) return;
  const lib = S.story.lib;
  z.innerHTML = `<div class="zoom-bg" data-act="zoomClose"><div class="zoom-card"><img src="${story.picUrl(pic)}" alt=""><b>${esc((lib.words[pic]?.text ?? pic).replace(/[!.]+$/, ""))}</b></div></div>`;
  const card = z.querySelector(".zoom-card"); const bg = z.querySelector(".zoom-bg");
  const a = fromEl.getBoundingClientRect(); const b = card.getBoundingClientRect();
  card.style.transition = "none";
  card.style.transform = `translate(${a.left + a.width / 2 - (b.left + b.width / 2)}px, ${a.top + a.height / 2 - (b.top + b.height / 2)}px) scale(.22)`;
  requestAnimationFrame(() => requestAnimationFrame(() => { card.style.transition = ""; bg.classList.add("in"); card.style.transform = ""; }));
  clearTimeout(zoomWord.t); zoomWord.t = setTimeout(() => { z.innerHTML = ""; }, 2600 + 450);
}

async function startStory(id) {
  player.unlock(); player.setVolume(pref.get("volume", 1));
  S.dialog = null;
  S.story = new story.StoryPlayer({ player, onChange: () => updateChat() });
  render();
  await S.story.start(id);
}

async function endStory() {
  const s = S.story; S.story = null; render();
  if (s) await s.close();
  S.progress = await api.myProgress(); render();
}

async function startChat() {
  player.unlock();
  const p = S.profile; const c = byId(p?.character);
  player.setVolume(pref.get("volume", 1));
  S.chat = new Chat({ voiceId: c.voice, speed: pref.get("speed", 1), saveTranscripts: (p?.transcript_days ?? 30) > 0, player, onChange: () => updateChat() });
  // 교재로 배우기(11/14): 운영자 계정에서만 먼저 켠다
  S.lesson = p?.is_staff === true ? new LessonManager({ chat: S.chat, player, speed: pref.get("speed", 1), store: pref, onChange: () => updateChat(), toast }) : null;
  S.lesson?.preload().catch(() => {});
  render();
  await S.chat.start();
}

async function endChat() {
  const c = S.chat; S.chat = null; S.lesson = null;
  const said = c ? c.ui.lines.filter((l) => l.role === "user").length : 0;
  const sid = c?.sessionId ?? null;
  render();
  if (c) await c.close();
  S.progress = await api.myProgress();
  // 그날 첫 대화를 마칠 때 짧은 설문(내가 한 말이 있는 대화만, 답할 때까지 하루 두 번까지)
  if (c && said > 0 && checkin.day() !== today() && checkin.asks() < 2) { checkin.ask(); S.dialog = { kind: "checkin", sid, rating: 0 }; }
  render();
}

// ---------- 마지막 설문(11/13 실장님: 1차 시험 11/17 오전 10시 종료) ----------
// 링크: https://hyeminson.github.io/bilody-web/?survey=post  (로그인하면 바로 열림, 한 사람 한 번)
const POST_Q = [
  { id: "overall", t: "bilody를 써 본 느낌은 전체적으로 어땠어요?", type: "face" },
  { id: "helpful", t: "영어로 말하는 데 도움이 됐나요?", type: "one", o: [["1", "전혀 아니에요"], ["2", "별로요"], ["3", "보통이에요"], ["4", "도움이 됐어요"], ["5", "많이 됐어요"]] },
  { id: "best", t: "가장 좋았던 점은 뭐예요? (여러 개 골라도 돼요)", type: "many", o: [["chat", "친구와 편하게 이야기하기"], ["correct", "틀린 표현을 고쳐 주기"], ["repeat", "따라 말하기 연습"], ["howto", "‘영어로 뭐라고 해?’ 도움"], ["cards", "글 카드·사진으로 보여 주기"], ["memory", "친구가 내 이야기를 기억하기"], ["character", "캐릭터와 목소리"], ["story", "그림책 보기"], ["habit", "알림·연속 기록·순위"], ["other", "기타"]] },
  { id: "worst", t: "가장 아쉬웠던 점은 뭐예요? (여러 개 골라도 돼요)", type: "many", o: [["slow", "대답이 느려요"], ["misheard", "내 말을 잘못 알아들어요"], ["too_many_fix", "교정이 너무 많아요"], ["too_few_fix", "교정이 너무 적어요"], ["same_q", "질문이 비슷비슷해요"], ["cut", "끊기거나 연결이 끊겨요"], ["voice", "목소리·소리가 아쉬워요"], ["hard", "쓰는 방법이 어려워요"], ["boring", "금방 지루해요"], ["other", "기타"]] },
  { id: "fix_amount", t: "틀린 표현을 고쳐 주는 횟수는 어땠어요?", type: "one", o: [["few", "너무 적어요"], ["ok", "적당해요"], ["many", "너무 많아요"]] },
  { id: "speed", t: "대답 속도는 어땠어요?", type: "one", o: [["bad", "답답했어요"], ["ok", "참을 만했어요"], ["good", "괜찮았어요"]] },
  { id: "chatgpt", t: "ChatGPT 음성 대화로 영어 연습을 해 본 적이 있나요?", type: "one", o: [["often", "자주 해요"], ["some", "몇 번 해 봤어요"], ["never", "해 본 적 없어요"]] },
  { id: "vs_chatgpt", t: "해 봤다면, bilody와 비교하면 어때요?", type: "one", o: [["bilody", "bilody가 더 좋아요"], ["same", "비슷해요"], ["chatgpt", "ChatGPT가 더 좋아요"], ["na", "해 본 적 없어요"]], note: "vs_note", ph: "무엇이 더 좋았고 무엇이 아쉬웠는지 한 줄로 (선택)" },
  { id: "continue", t: "정식으로 나오면 계속 쓸 것 같아요?", type: "one", o: [["yes", "꼭 쓸래요"], ["maybe", "아마 쓸 것 같아요"], ["unsure", "잘 모르겠어요"], ["no", "안 쓸 것 같아요"]] },
  // 11/13 17:35 실장님: 값은 하루·한 달 이용 한도에 따라 달라짐 → 먼저 원하는 시간을 묻고, 그 시간 기준으로 값을 묻는다
  { id: "usage", t: "정식으로 나오면 하루에 얼마나 쓰고 싶어요?", type: "one", o: [["10", "10분쯤"], ["20", "20분쯤"], ["30", "30분쯤"], ["60", "1시간쯤"], ["60+", "1시간보다 더"]] },
  { id: "price", t: "바로 앞에서 고른 시간만큼 매일 쓸 수 있다면, 한 달에 얼마까지 낼 수 있어요?", type: "one", o: [["0", "무료일 때만 쓸래요"], ["5000", "5천 원까지"], ["10000", "1만 원까지"], ["20000", "2만 원까지"], ["30000", "3만 원까지"], ["30000+", "3만 원보다 더"]] },
  { id: "kids", t: "18~36개월 아이에게 영어 그림책을 읽어 주고 아이 말에 반응하는 bilody가 있다면 쓰고 싶나요?", type: "one", o: [["yes", "쓰고 싶어요"], ["maybe", "한번 보고 싶어요"], ["no", "관심 없어요"], ["na", "그 나이 아이가 없어요"]] },
  { id: "free", t: "그 밖에 하고 싶은 말이 있으면 적어 주세요. (선택)", type: "text", ph: "좋았던 점, 고쳤으면 하는 점, 아이디어 모두 좋아요" },
];
const wantsPostSurvey = () => new URLSearchParams(location.search).get("survey") === "post";
async function openPostSurvey() {
  try { if (await api.postSurveyDone()) { S.dialog = { kind: "postDone" }; return render(); } } catch { /* 확인 못 해도 설문은 연다 */ }
  S.dialog = { kind: "post", face: 0 }; render();
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
      <div class="subhead"><button class="iconbtn" data-act="closeSession" aria-label="목록으로">${I("arrow_back")}</button><b>대화 보기</b></div>
      ${practiced.length ? `<div class="card lilac"><div class="accent small b">이 대화에서 연습한 표현</div>${practiced.map((p) => `<p class="b">“${esc(p)}”</p>`).join("")}</div>` : ""}
      ${S.turns.map((t, i) => `<div class="bubble ${t.role === "user" ? "me" : ""}">${esc(t.text)}</div>
        ${t.role !== "user" ? `<button class="report-link" data-act="report" data-v="${i}">문제 알리기</button>` : ""}`).join("")}
    </div>`;
  }
  return `<div class="list">
    ${S.sessions.length ? `<div class="right"><button class="link danger small" data-act="deleteAll">전부 지우기</button></div>` : `<div class="empty"><img src="img/char_${byId(S.profile?.character).id}.webp" alt=""><b>아직 저장된 대화가 없어요</b><span class="muted">친구와 이야기하면 여기에 남아요</span></div>`}
    ${S.sessions.map((s) => `<div class="card row hist">
      <button class="grow left hist-open" data-act="openSession" data-v="${s.id}"><span class="badge">${I("chat_bubble")}</span>
        <span class="hist-text"><b>${esc(S.previews[s.id] ?? "(내가 한 말 없음)")}</b><span class="muted small">${niceDate(s.started_at)}</span></span></button>
      <button class="iconbtn" data-act="deleteSession" data-v="${s.id}" aria-label="지우기">${I("delete_outline")}</button></div>`).join("")}
  </div>`;
}

async function loadHistory() {
  try { const [ss, pv] = await Promise.all([api.sessions(), api.firstLines()]); S.sessions = ss.filter((x) => x.preset_id !== "kids-demo"); S.previews = pv; } catch (e) { S.error = api.errText(e); }
  render();
}

// ---------------- 설정 ----------------
function section(key, title, summary, icon, body) {
  const open = S.open === key;
  return `<div class="card section ${open ? "open" : ""}">
    <button class="sec-head" data-act="section" data-v="${key}"><span class="badge">${I(icon)}</span>
      <span class="sec-t"><b>${title}</b>${summary ? `<span class="muted small">${esc(summary)}</span>` : ""}</span>${I("chevron_right", "chev")}</button>
    ${open ? `<div class="sec-body">${body}</div>` : ""}</div>`;
}
const toggle = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? "checked" : ""}><i></i></label>`;

function notifyBody() {
  const r = S.reminder ?? { on: false, hour: 20, minute: 0 };
  const why = push.blocker();
  const note = why === "ios_install"
    ? `<div class="note">아이폰은 Safari 아래쪽 <b>공유 버튼</b>을 누르고 <b>‘홈 화면에 추가’</b>로 bilody를 설치한 뒤, 홈 화면의 bilody를 열어 알림을 켜 주세요. 애플 정책상 설치한 웹앱만 알림을 받을 수 있어요(iOS 16.4 이상).</div>`
    : why === "denied" ? `<div class="note">이 기기에서 bilody 알림이 막혀 있어요. 휴대폰 설정에서 알림을 허용한 뒤 다시 켜 주세요.</div>`
    : why === "unsupported" ? `<div class="note">이 브라우저에서는 알림을 받을 수 없어요. 아이폰은 Safari, 안드로이드는 Chrome을 써 주세요.</div>` : "";
  return `<div class="row top"><span class="grow muted small">정한 시간에 하루 한 번 알림이 떠요. 오늘 5분을 채운 날에는 알림이 뜨지 않고, 이틀 넘게 쉬면 2·4·7일째에만 떠요.</span>
      ${why ? "" : toggle("remOn", r.on)}</div>
    ${note}
    ${why ? "" : `<button class="link" data-act="notifyTime">알림 시간 ${hhmm(r.hour, r.minute)} 바꾸기</button>`}`;
}

function renderSettings() {
  const p = S.profile ?? {}; const c = byId(p.character);
  const speed = pref.get("speed", 1), vol = pref.get("volume", 1), subs = pref.get("subtitles", false);
  const days = p.transcript_days ?? 30; const memOn = p.memory_enabled !== false;
  const r = S.reminder;
  const fname = p.friend_name ?? c.en;
  return `<div class="list">
    ${section("friend", "친구", `${c.ko} · 이름 ${fname} · 속도 ${speed.toFixed(1)}배`, "face", `
      <p class="muted small">함께 이야기할 친구를 골라요. 친구마다 성격과 목소리가 달라요. 바꿔도 기억과 대화 기록은 그대로예요.</p>
      ${charPicker(c.id)}
      <div class="row"><span class="grow">${esc(c.intro)}</span><button class="link" data-act="preview">▶ 목소리 듣기</button></div>
      <div class="row">${field("fname", "친구 이름", `maxlength="8"`, fname)}<button class="link" data-act="renameFriend">저장</button></div>
      <p class="muted tiny">한글이나 영어로 1~8자. 이름을 바꿔도 성격과 목소리는 그대로예요.</p>
      ${fname !== c.en ? `<button class="link" data-act="resetFriend">원래 이름(${esc(c.en)})으로</button>` : ""}
      <hr><b class="h">말 속도  <span id="speedV">${speed.toFixed(1)}</span>배</b>
      <p class="muted small">1.0배가 보통 원어민 대화 속도예요. 바꾸면 다음 문장부터 적용돼요.</p>
      <input type="range" id="speed" min="0.7" max="1.5" step="0.1" value="${speed}">
      <b class="h">목소리 크기</b><input type="range" id="volume" min="0.2" max="1" step="0.05" value="${vol}">`)}
    ${section("subs", "자막", subs ? "켜짐" : "꺼짐", "subtitles", `
      <div class="row top"><span class="grow"><b class="h">대화 중 자막</b><br><span class="muted small">켜면 나와 친구의 말이 대화 화면에 글자로 나와요. 꺼도 기록에는 남고, 따라 말하기·쉽게 다시 말하기 카드는 그대로 보여요.</span></span>
      ${toggle("subs", subs)}</div>`)}
    ${section("memory", "기억", `${memOn ? "켜짐" : "꺼짐"} · ${S.memories.length}개`, "psychology", `
      <div class="row top"><span class="grow muted small">내가 직접 말한 사실만 대화가 끝날 때 기억해요. 끄면 기억을 새로 만들거나 대화에 쓰지 않아요(지우지는 않아요).</span>
      ${toggle("memOn", memOn)}</div>
      ${S.memories.length ? S.memories.map((m) => `<div class="row"><span class="grow small">${esc(m.text)}</span><button class="link tiny" data-act="editMem" data-v="${m.id}">고치기</button><button class="link tiny" data-act="delMem" data-v="${m.id}">지우기</button></div>`).join("") : `<p class="small">아직 기억한 것이 없어요.</p>`}`)}
    ${section("records", "대화 기록 보관", days === 0 ? "저장 안 함" : `${days}일`, "description", `
      <p class="muted small">기간이 지난 대화 기록은 자동으로 지워져요. ‘저장 안 함’이면 새 대화를 기록하지 않고, 기억도 새로 만들지 않아요.</p>
      <div class="radios">${[[30, "30일"], [7, "7일"], [0, "저장 안 함"]].map(([d, l]) => `<button class="radio-btn ${days === d ? "on" : ""}" data-act="days" data-v="${d}"><i></i>${l}</button>`).join("")}</div>`)}
    ${section("notify", "알림", r?.on ? `매일 ${hhmm(r.hour, r.minute)}` : "꺼짐", "notifications", notifyBody())}
    ${section("league", "순위", p.league_opt_in !== false ? "참여" : "참여 안 함", "emoji_events", `
      <div class="row top"><span class="grow"><b class="h">이번 주 순위에 나오기</b><br><span class="muted small">다른 사람에게는 이름 첫 글자만 보여요.</span></span>
      ${toggle("league", p.league_opt_in !== false)}</div>`)}
    ${section("account", "계정", `내 이름 ${p.my_name ?? ""}`, "account_circle", `
      <p class="muted small">친구가 나를 부르는 이름이에요. 영어 글자로 써 주세요.</p>
      <div class="row">${field("myname", "내 이름", `maxlength="20"`, p.my_name ?? "")}<button class="link" data-act="renameMe">저장</button></div>
      <button class="link" data-act="signOut">로그아웃</button><br>
      <button class="link danger" data-act="deleteAccount">탈퇴하기</button>`)}
    ${section("help", "도움말", "사용 안내 · 문의하기", "support_agent", `
      <button class="link" data-act="guide">사용 안내 보기</button><br>
      <button class="link" data-act="inquiry">문의하기</button><br>
      <button class="link" data-act="openCheckin">오늘 대화 의견 남기기</button><br>
      <button class="link" data-act="showGuideCard">첫 화면 안내 다시 보기</button>
      <p class="muted tiny">앱을 쓸 수 없을 때는 초대해 준 운영자에게 연락해 주세요(삭제 요청 포함).</p>`)}
    <p class="version">bilody ${VERSION} · 비공개 시험판</p>
  </div>`;
}

// ---------------- 창(대화상자) ----------------
function renderDialog() {
  const d = S.dialog; if (!d) return "";
  const box = (inner) => `<div class="overlay" data-act="closeDialog"><div class="dialog" data-stop>${inner}</div></div>`;
  if (d.kind === "confirm") return box(`<h2>${esc(d.title)}</h2><p>${esc(d.text ?? "")}</p>
    <div class="row end"><button class="link" data-act="closeDialog">취소</button><button class="link ${d.danger ? "danger" : ""}" data-act="confirmYes">${esc(d.yes)}</button></div>`);
  if (d.kind === "guide") return `<div class="overlay full"><div class="guide-page">
    <div class="subhead"><button class="iconbtn" data-act="closeDialog" aria-label="닫기">${I("arrow_back")}</button><b>사용 안내</b></div>
    ${GUIDE.map((g, i) => `<details class="card" ${i === 0 ? "open" : ""}><summary><b>${esc(g.title)}</b>${I("chevron_right", "chev")}</summary><p>${esc(g.intro)}</p>
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
  if (d.kind === "postDone") return box(`<h2>마지막 설문</h2><p>이미 답해 주셨어요. 정말 고마워요! 🙏</p><div class="row end"><button class="link" data-act="closeDialog">닫기</button></div>`);
  if (d.kind === "post") return `<div class="overlay full"><div class="guide-page survey">
    <div class="subhead"><button class="iconbtn" data-act="closeDialog" aria-label="닫기">${I("arrow_back")}</button><b>bilody 1차 시험 마지막 설문</b></div>
    <p class="muted small">3분이면 끝나요. 답은 bilody를 고치는 데만 쓰고, 이름 없이 모아서 봐요.</p>
    ${POST_Q.map((q, n) => `<div class="card q"><b>${n + 1}. ${esc(q.t)}</b>
      ${q.type === "face" ? `<div class="faces">${["😣", "😕", "😐", "🙂", "😄"].map((f, i) => `<button class="face ${d.face === i + 1 ? "on" : ""}" data-act="pqFace" data-v="${i + 1}" aria-label="${i + 1}점">${f}</button>`).join("")}</div>`
        : q.type === "text" ? `<textarea data-pq="${q.id}" rows="3" maxlength="1000" placeholder="${esc(q.ph)}"></textarea>`
        : q.o.map(([v, l]) => `<label class="radio"><input type="${q.type === "many" ? "checkbox" : "radio"}" name="pq_${q.id}" value="${v}"> ${esc(l)}</label>`).join("")}
      ${q.note ? `<textarea data-pq="${q.note}" rows="2" maxlength="500" placeholder="${esc(q.ph)}"></textarea>` : ""}</div>`).join("")}
    <button class="pill primary" data-act="sendPost">보내기</button></div></div>`;
  if (d.kind === "editMem") return box(`<h2>기억 고치기</h2><textarea id="memText" rows="3">${esc(d.text)}</textarea>
    <div class="row end"><button class="link" data-act="closeDialog">취소</button><button class="link" data-act="saveMem">저장</button></div>`);
  if (d.kind === "board") return box(`<h2>이번 주 순위 🏆</h2><p class="muted small">5분 이상 이야기한 날 10점 + 1분마다 1점(하루 최대 30점). 매주 월요일에 새로 시작해요. 다른 사람 이름은 첫 글자만 보여요.</p>
    ${d.rows.length ? d.rows.map((r) => `<div class="row board ${r.me ? "me" : ""}"><span class="rank">${["🥇", "🥈", "🥉"][r.rank - 1] ?? r.rank}</span><i class="dot" style="background:${dotColor(r.color)}"></i><span class="grow">${esc(r.name)}${r.me ? " (나)" : ""}</span><b>${r.points}점</b></div>`).join("") : `<p>아직 이번 주 기록이 없어요. 오늘 5분이면 바로 올라가요!</p>`}
    <div class="row end"><button class="link" data-act="closeDialog">닫기</button></div>`);
  if (d.kind === "photoPick") return box(`<h2>사진 보여 주기</h2><p class="muted small">보여 준 사진은 저장하지 않아요. 사람 얼굴보다 물건이 잘 맞아요.</p>
    <button class="pill primary" data-act="camera">${I("photo_camera")}사진 찍기</button><button class="pill secondary" data-act="gallery">${I("photo_library")}앨범에서 고르기</button>
    <div class="row end"><button class="link" data-act="closeDialog">취소</button></div>`);
  if (d.kind === "report") return box(`<h2>이 답변의 문제 알리기</h2><p class="small">아래 문장만 운영자에게 보내져요. 다른 대화는 보내지 않아요.</p>
    ${d.lines.map((l) => `<p class="quote">${l.role === "user" ? "나" : "친구"}: ${esc(l.text)}</p>`).join("")}
    ${[["unsafe", "불쾌하거나 위험한 말"], ["wrong", "틀린 내용·잘못된 교정"], ["odd", "엉뚱한 대답"], ["other", "기타"]].map(([v, l], i) => `<label class="radio"><input type="radio" name="rcat" value="${v}" ${i === 1 ? "checked" : ""}> ${l}</label>`).join("")}
    <textarea id="rnote" rows="2" placeholder="덧붙일 말(선택)"></textarea>
    <label class="radio"><input type="checkbox" id="ragree"> 위 문장을 운영자에게 보내는 데 동의해요</label>
    <div class="row end"><button class="link" data-act="closeDialog">취소</button><button class="link" data-act="sendReport">보내기</button></div>`);
  if (d.kind === "notifyTime") return box(`<h2>알림 시간</h2><p class="muted small">정한 시간에 하루 한 번 알림이 떠요. 오늘 5분을 채운 날에는 뜨지 않아요.</p>
    ${push.blocker() === "ios_install" ? `<div class="note">아이폰은 Safari 아래쪽 <b>공유 버튼</b> → <b>‘홈 화면에 추가’</b>로 bilody를 설치한 뒤, 홈 화면의 bilody에서 알림을 켜 주세요(애플 정책).</div>`
      : `<input type="time" id="remTime" class="time" value="${hhmm(d.hour, d.minute)}">`}
    <div class="row end"><button class="link" data-act="closeDialog">취소</button>${push.blocker() === "ios_install" ? "" : `<button class="link" data-act="saveTime">확인</button>`}</div>`);
  if (d.kind === "storyPick") {
    const lib = d.lib; const pos = story.loadPosition(); const rb = pos && lib.stories.find((b) => b.id === pos.id);
    return box(`<h2>그림책 보기 · ${lib.stories.length}권</h2>
      <p class="warn small">⚠ 어른 목소리로만 시험해 주세요. 실제 아이 목소리는 승인 절차 전까지 외부로 보내면 안 돼요. 이 화면의 대화는 기록에 남기지 않아요. 한 권이 끝나면 다음 그림책으로 이어집니다.</p>
      <button class="pill dark" data-act="storyStart" data-v="resume">${rb ? `▶ 이어 듣기: ${esc(rb.titleKo)} (처음부터)` : "▶ 처음부터 듣기"}</button>
      <div class="book-list">${lib.stories.map((b) => `<button class="book" data-act="storyStart" data-v="${b.id}">
        ${story.thumbUrl(b.id) ? `<img src="${story.thumbUrl(b.id)}" alt="">` : ""}
        <span><b>${esc(b.titleKo)}</b><span class="muted tiny">${esc(b.title)} · ${b.pages.length}쪽</span><span class="credit">${esc(b.credit)}</span></span></button>`).join("")}</div>
      <div class="row end"><button class="link" data-act="closeDialog">닫기</button><button class="link" data-act="credits">그림 출처</button></div>`);
  }
  if (d.kind === "lessons") {
    const done = new Set(pref.get("lessonDone", []));
    const lv = d.level;
    const rb = d.lib.byId[d.resume]; const started = !!pref.get("lessonLast", null);
    return box(`<h2>교재로 배우기</h2>
    <button class="pill dark lesson-resume" data-act="lessonPick" data-v="${d.resume}">${I("play_arrow")}${started ? "이어서" : "처음부터"}: ${esc(rb?.title_ko ?? "")}</button>
    <p class="muted tiny center">${started ? "마지막으로 한 교재에서 이어 가요. 끝낸 교재면 다음 교재로 가요." : "1과부터 차례대로 해요."}</p>
    ${d.list ? `<div class="seg">${[["L1", "쉬움"], ["L2", "보통"], ["L3", "도전"]].map(([k, l]) => `<button class="${lv === k ? "on" : ""}" data-act="lessonLevel" data-v="${k}">${l}</button>`).join("")}</div>
    <div class="lesson-list">${d.lib.lessons.filter((l) => l.level === lv).map((l) => `<button class="lesson-item" data-act="lessonPick" data-v="${l.id}">
      <img src="lessons/img/${l.id}.webp" alt=""><span class="grow"><b>${esc(l.title_ko)}</b><span class="muted small">${esc(l.title_en)}</span></span>${done.has(l.id) ? I("check_circle", "accent") : I("chevron_right", "muted")}</button>`).join("")}</div>` : `<button class="link" data-act="lessonList">다른 교재 고르기</button>`}
    <div class="row end"><button class="link" data-act="closeDialog">닫기</button></div>`);
  }
  if (d.kind === "credits") return box(`<h2>단어 그림 출처</h2>
    <p class="muted small">단어 그림 대부분은 Microsoft Fluent Emoji(3D)를 썼어요. Copyright (c) Microsoft Corporation, MIT License — github.com/microsoft/fluentui-emoji. 배경 카드를 더하고 빨간 모자는 색을 바꿨어요. 벌집·탁자·베개·그네·모래성·풀 그림은 bilody가 직접 그렸어요.</p>
    ${(d.lib.photoCredits ?? []).map((c) => `<p class="tiny">${esc(c.word)} · ${esc(c.title)}${c.creator ? ` · ${esc(c.creator)}` : ""} · ${esc(c.license)} · ${esc(c.url)}</p>`).join("")}
    <div class="row end"><button class="link" data-act="closeDialog">닫기</button></div>`);
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
      if (v === "history" && S.story) await endStory();
      S.tab = v; S.error = null; S.turns = null; render();
      if (v === "history") loadHistory();
      if (v === "settings") { try { S.memories = await api.memories(); } catch { /* */ } render(); }
      break;
    }
    case "guideSeen": pref.set("guideSeen", true); render(); break;
    case "showGuideCard": pref.set("guideSeen", false); toast("대화 화면에 안내를 다시 띄웠어요."); break;
    case "board": S.dialog = { kind: "board", rows: await api.weeklyBoard() }; render(); break;
    case "start": await startChat(); break;
    // ---- 동화 듣기 ----
    case "storyPick": {
      try { const lib = await story.loadLib(); S.dialog = { kind: "storyPick", lib }; render(); await story.loadCommon(); if (S.dialog?.kind === "storyPick") render(); }
      catch { toast("그림책 목록을 불러오지 못했어요. 인터넷을 확인해 주세요."); }
      break;
    }
    case "credits": S.dialog = { kind: "credits", lib: await story.loadLib() }; render(); break;
    case "storyStart": await startStory(v); break;
    case "storyTap": {
      const st = S.story; if (!st) break;
      el.querySelector("span")?.classList.add("shown");     // 누른 단어는 이름이 보인다
      if (st.ui.image && !st.quizActive) zoomWord(v, el);
      st.tapPicture(v); break;
    }
    case "zoomClose": $("#zoom").innerHTML = ""; break;
    case "storyPause": S.story?.pause(); break;
    case "storyResume": S.story?.resume(); break;
    case "storyExit": await endStory(); break;
    // ---- 알림 ----
    case "notifyTime": { const r = S.reminder ?? { hour: 20, minute: 0 }; S.dialog = { kind: "notifyTime", hour: r.hour, minute: r.minute }; render(); break; }
    case "saveTime": {
      const [h, m] = ($("#remTime")?.value || "20:00").split(":").map(Number);
      S.dialog = null;
      try { await push.enable(h, m); S.reminder = { on: true, hour: h, minute: m }; pref.set("remHour", h); pref.set("remMinute", m); toast(`매일 ${hhmm(h, m)}에 알림이 떠요.`); }
      catch (err) { toast(api.errText(err)); }
      render(); break;
    }
    case "resetFriend": {
      const c = byId(p.character);
      await work(async () => { await api.saveProfile({ friendName: c.en, myName: p.my_name, presetId: p.preset_id, color: p.color, character: p.character }); S.profile = await api.loadProfile(); });
      toast("저장했어요."); break;
    }
    case "pause": S.chat?.stop(); break;
    case "restart": player.unlock(); await S.chat?.restart(); break;
    case "exit": await endChat(); break;
    case "lessonOpen": { const lib = await loadLessons(); const rid = lessonResume(pref); S.dialog = { kind: "lessons", lib, resume: rid, level: lib.byId[rid]?.level ?? "L1", list: false }; render(); break; }
    case "lessonList": if (S.dialog?.kind === "lessons") { S.dialog.list = true; render(); } break;
    case "lessonLevel": if (S.dialog?.kind === "lessons") { S.dialog.level = v; render(); } break;
    case "lessonPick": S.dialog = null; render(); S.lesson?.startNow(v); break;
    case "lessonBtn": S.lesson?.button(v); break;
    case "lessonInfo": toast(S.lesson?.lesson?.credit_ko ?? "bilody가 만든 대화예요"); break;
    case "send": { const i = $("#say"); if (!i.value.trim()) break; S.chat?.sendText(i.value); i.value = ""; el.disabled = true; break; }
    case "dismissCard": S.chat?.dismissCard(); break;
    case "dismissWebPicture": S.chat?.dismissWebPicture(); break;
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
    case "signOut": if (S.chat) await endChat(); if (S.story) await endStory(); api.signOut(); S.profile = null; S.stage = "auth"; render(); break;
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
    case "pqFace": { S.dialog.face = Number(v); document.querySelectorAll(".survey .face").forEach((b) => b.classList.toggle("on", b.dataset.v === v)); break; }
    case "sendPost": {
      const a = { overall: S.dialog.face || null };
      for (const q of POST_Q) {
        if (q.type === "many") a[q.id] = [...document.querySelectorAll(`input[name=pq_${q.id}]:checked`)].map((x) => x.value);
        else if (q.type === "one") a[q.id] = document.querySelector(`input[name=pq_${q.id}]:checked`)?.value ?? null;
        else if (q.type === "text") a[q.id] = (document.querySelector(`[data-pq=${q.id}]`)?.value ?? "").trim();
        if (q.note) a[q.note] = (document.querySelector(`[data-pq=${q.note}]`)?.value ?? "").trim();
      }
      const missing = POST_Q.filter((q) => q.type !== "text" && q.type !== "many" && !a[q.id]).length;
      if (missing) return toast(`아직 답하지 않은 질문이 ${missing}개 있어요.`);
      S.dialog = null;
      await work(() => api.savePostSurvey(a));
      if (!S.error) { S.dialog = { kind: "postDone" }; render(); }
      break;
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
  if (t.id === "remOn") {
    const r = S.reminder ?? { hour: 20, minute: 0 };
    try {
      if (t.checked) { await push.enable(r.hour, r.minute); S.reminder = { on: true, hour: r.hour, minute: r.minute }; toast(`매일 ${hhmm(r.hour, r.minute)}에 알림이 떠요.`); }
      else { await push.disable(); S.reminder = { ...r, on: false }; }
    } catch (err) { toast(api.errText(err)); }
    render();
  }
  if (t.id === "league") await work(async () => { await api.patchProfile({ league_opt_in: t.checked }); S.profile = await api.loadProfile(); });
  if (t.id === "camera" || t.id === "gallery") {
    const f = t.files?.[0]; t.value = "";
    S.chat?.holdForCamera(false);
    if (!f || !S.chat) return;
    try { const data = await preparePhoto(f, S.chat.maxMsg); S.chat.sendImage(data, data); } catch { toast("사진을 열지 못했어요."); }
  }
  void p;
});
app.addEventListener("input", (e) => {
  if (e.target.id === "speed") { const s = $("#speedV"); if (s) s.textContent = Number(e.target.value).toFixed(1); }
  if (e.target.id === "say") { const b = $("[data-act=send]"); if (b) b.disabled = !e.target.value.trim(); }
});
// 동화: 옆으로 밀면 쪽 넘기기(왼쪽으로 밀면 다음 쪽, 오른쪽으로 밀면 앞 쪽)
let swipeX = null;
app.addEventListener("touchstart", (e) => { swipeX = e.target.closest("#stMain") ? e.touches[0].clientX : null; }, { passive: true });
app.addEventListener("touchend", (e) => {
  if (swipeX == null || !S.story) return;
  const dx = e.changedTouches[0].clientX - swipeX; swipeX = null;
  if (dx < -60) S.story.turnPage(1); else if (dx > 60) S.story.turnPage(-1);
}, { passive: true });
app.addEventListener("keydown", (e) => { if (e.target.id === "say" && e.key === "Enter" && e.target.value.trim()) { S.chat?.sendText(e.target.value); e.target.value = ""; const b = $("[data-act=send]"); if (b) b.disabled = true; } });

// 다른 앱으로 나가면 대화와 마이크를 멈춘다(사진 고르러 간 경우는 제외). 돌아와도 저절로 말하지 않는다.
document.addEventListener("visibilitychange", () => { if (document.hidden) { S.chat?.pauseForBackground(); if (S.story && S.story.ui.state !== "stopped") S.story.pause(); } });
window.addEventListener("focus", () => { setTimeout(() => { if (S.chat?.cameraHold) S.chat.holdForCamera(false); }, 1500); });

push.register();
refresh();
