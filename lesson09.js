// 0.9 1:1 수업(앱 lesson/Textbook.kt·ui/Lessons.kt의 웹판, 11/17).
// 교재 글은 이 사이트의 tb/*.json, 그림은 Supabase 공개 보관함(tb), 권 PDF는 lessons/pdf.
import * as api from "./api.js?v=0.8.4";
import { byId, sceneVoice, teacherImg, TEACHERS } from "./characters.js?v=0.8.4";

export const IMG = "https://rhozyegydubhtovrfrmo.supabase.co/storage/v1/object/public/tb/";
export const imgUrl = (p) => (p ? IMG + String(p).replace(/^img\//, "") : "");
export const pdfUrl = (p) => (p?.startsWith("pdf/") ? "lessons/" + p : p);

// 0.8.2: 받은 교재는 10분만 기억한다(탭을 오래 열어 두면 새로 올린 교재가 반영되지 않았음). 다시 받지 못하면 갖고 있던 것을 쓴다.
const cache = {};
async function getJson(path) {
  const c = cache[path];
  if (c && Date.now() - c.at < 600000) return c.data;
  try {
    const r = await fetch(path, { cache: "no-cache" });
    if (!r.ok) throw new Error(`http_${r.status}`);
    const data = await r.json(); cache[path] = { data, at: Date.now() }; return data;
  } catch (e) { if (c) return c.data; throw e; }
}
export const loadIndex = () => getJson("tb/index.json");
export const loadBook = (file) => getJson(`tb/${file}`);
// 0.8.3(11/19 실장님): 동영상 강의(문법 강의 등). 목록 파일만 올리면 앱·웹에 나타난다(앱을 새로 내지 않음).
export const loadVideos = () => getJson("videos/index.json");

const plain = (s) => String(s ?? "").replace(/\{\{|\}\}|\*/g, "").trim();

/** 11/18 실장님 결정: 교재 표기는 영어로 통일(Book 1 · Unit 1 · Lesson 1 · Part 1 · p. 6). 설명 문장은 한국어. */
export const T = { book: (n, kids = false) => `${kids ? "Kids Book" : "Book"} ${n ?? 1}`, lesson: (n) => `Lesson ${n ?? 1}`, unit: (n) => `Unit ${n ?? 1}`, part: (n) => `Part ${n ?? 1}`, page: (p) => `p. ${p}` };

/** 교재 한 회차(Part) 실행 정보(앱 LessonRun과 같음). */
export function makeRun(book, L, session) {
  const sessions = L.sessions ?? [];
  const sess = sessions.find((x) => x.n === session) ?? sessions[0];
  session = sess?.n ?? 1;   // 없는 회차 번호는 실제로 여는 회차 번호로(헤니 검토)
  const steps = sess?.steps ?? [];
  const expressions = sessions.flatMap((x) => x.steps).filter((x) => x.type === "card").map((x) => plain(x.en));
  const run = { id: L.id, kids: L.kind === "kids", title: L.title ?? "", titleEn: L.title_en ?? "", koreanOk: true /* 0.9.3: 한국어 정도는 서버가 권에 따라 정함 */, steps, expressions, session,
    bookId: book.id, bookNo: book.no, no: L.no, sessionCount: sessions.length || 1, teacher: L.teacher, letter: L.letter, lesson: L,
    unitNo: L.unit ?? null, unitTitle: (book.units ?? []).find((u) => u.no === L.unit)?.title ?? null };
  run.bookLabel = T.book(book.no, run.kids);
  run.info = { id: run.id, session, title: run.title, title_en: run.titleEn, goal: L.goal ?? "", book: book.no, korean_ok: run.koreanOk, expressions };
  return run;
}

// ---------- 진도(이 기기에 저장) ----------
export const progress = {
  next(store, bookId) { const v = store.get(`lp_${bookId}`, "1:1").split(":"); return [Number(v[0]) || 1, Number(v[1]) || 1]; },
  done(store, run) {
    const [n, s] = run.session < run.sessionCount ? [run.no, run.session + 1] : [run.no + 1, 1];
    const [cn, cs] = this.next(store, run.bookId);
    if (n > cn || (n === cn && s > cs)) store.set(`lp_${run.bookId}`, `${n}:${s}`);
    store.set("lp_last", run.bookId);
  },
  lastBook: (store) => store.get("lp_last", "A1"),
  teacher: (store) => store.get("lp_teacher", "grace"),
};

/** {{표현}} 밑줄·굵게, *굵게* */
export function marked(s, esc) {
  return esc(s ?? "").replace(/\{\{(.+?)\}\}/g, '<u class="hl">$1</u>').replace(/\*(.+?)\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
}

const STEP_LABEL = { intro: "오늘 배울 것", card: "오늘의 표현", tf: "맞으면 T, 틀리면 F", frame: "문장 틀", grammar: "핵심 문법·자주 틀리는 표현", drill: "이럴 땐 뭐라고 해요?",
  done: "마무리", review: "지난 시간 복습", more: "같이 익히는 표현", tips: "알아 두면 좋은 것", pics: "낱말 그림", words: "낱말", my: "내 이야기", read: "읽을거리", can: "오늘 할 수 있게 된 것" };
Object.assign(STEP_LABEL, { k_letter: "오늘의 글자", k_words: "그림 낱말", k_chant: "챈트", k_pick: "그림 고르기", k_hunt: "글자 찾기", k_say: "말해 보기", k_stars: "오늘 할 일 끝" });
export const stepLabel = (s) => (s?.type === "dialogue" ? (s.play ? "장면 듣기" : "역할 읽기") : s?.type === "card" ? `오늘의 표현 ${s.n ?? ""}` : STEP_LABEL[s?.type] ?? "");

// ---------- 수업 홈 ----------
export function renderHome(H, esc, I) {
  if (H.error) return `<div class="lh"><div class="lh-top"><h2>1:1 수업</h2><button class="link lh-home" data-act="lhClose">${I("home")}처음 화면</button></div><p class="error">${esc(H.error)}</p></div>`;
  if (!H.index) return `<div class="lh"><div class="lh-top"><h2>1:1 수업</h2><button class="link lh-home" data-act="lhClose">${I("home")}처음 화면</button></div><div class="spinner"></div></div>`;
  // 0.8.3(11/19 실장님): 어린이 교재도 1:1 수업 안에서 고른다. 권 이름은 모두 보이게(줄바꿈), 어른 Book 다음에 Kids Book.
  const books = [...H.index.books.filter((b) => b.kind !== "kids"), ...H.index.books.filter((b) => b.kind === "kids")]; const book = books.find((b) => b.id === H.bookId) ?? books[0];
  const kids = book.kind === "kids";
  const [nn, ns] = H.next;
  // 마지막 과까지 마치면 1과로 되돌아가 보이지 않게(헤니 검토)
  const done = book.lessons.length > 0 && nn > Math.max(...book.lessons.map((x) => x.no));
  const L = book.lessons.find((x) => x.no === nn) ?? book.lessons[0];
  const nextBook = books[books.indexOf(book) + 1];
  const t = byId(H.teacher);
  return `<div class="lh">
    <div class="lh-top"><h2>1:1 수업</h2><button class="link lh-home" data-act="lhClose">${I("home")}처음 화면</button></div>
    <p class="muted small">중학생~어른은 Book, 초등 저학년은 Kids Book</p>
    ${H.rec ? `<p class="small pl-line"><b class="accent">${esc(byId(H.rec.teacher).ko)} 선생님 추천</b> Book ${H.rec.book}${(() => { const rb = H.index.books.find((x) => x.kind !== "kids" && x.no === H.rec.book); return rb ? ` ‘${esc(rb.title_ko)}’` : ""; })()} <button class="link small" data-act="plIntro">다시 받기</button></p>`
      : `<p class="small pl-line"><button class="link small" data-act="plIntro">어느 Book부터 할지 추천 받기</button></p>`}
    <div class="lh-chips">${books.map((b) => `<button class="lh-chip ${b.id === book.id ? "on" : ""}" data-act="lhBook" data-v="${b.id}">${T.book(b.no, b.kind === "kids")}</button>`).join("")}</div>
    <p class="muted small">${esc(kids ? `${book.title_ko} · 초등 저학년 · 그림과 노래로` : `${book.title_ko} · ${book.cefr ?? ""} ${book.level_ko ?? ""}`)}</p>
    ${kids ? `<p class="error small">⚠ 시험 기간에는 어른 목소리로만 시험해 주세요. 아이 목소리는 아직 보내면 안 돼요.</p>` : ""}
    ${done ? `<div class="card today"><div class="today-title">${T.book(book.no, kids)}을 모두 마쳤어요!</div><p class="muted small">아래 ‘다른 Lesson 고르기’에서 복습할 Lesson을 고르거나 다음 Book으로 넘어가요.</p>
      ${nextBook && nextBook.kind === book.kind ? `<button class="pill primary" data-act="lhBook" data-v="${nextBook.id}">${T.book(nextBook.no, kids)}로 넘어가기</button>` : `<button class="pill secondary" data-act="lhAll">Lesson 목록 펼치기</button>`}</div>` : `<div class="card today">
      <div class="row"><b class="accent small grow">오늘 할 분량</b><span class="muted small">약 10분</span></div>
      <div class="lh-row"><img class="today-img" src="${imgUrl(`img/s/${L.id}.jpg`)}" alt="">
        <div class="grow"><div class="muted small">${kids ? T.lesson(L.no) : `${T.book(book.no)} · ${T.lesson(L.no)} · ${T.part(ns)}`}</div><div class="today-title">${esc(L.title)}</div>${L.title_en ? `<div class="muted small">${esc(L.title_en)}</div>` : ""}</div></div>
      ${`<div class="my-teacher"><img src="${teacherImg(t.id)}" alt=""><span class="grow">내 선생님 <b>${esc(t.ko)}</b></span><button class="link" data-act="lhTeacher">바꾸기</button></div>`}
      <button class="pill primary" data-act="lhStart" data-v="${L.id}" data-s="${kids ? 1 : ns}" ${H.busy ? "disabled" : ""}>${I("play_arrow")}${H.busy ? "불러오는 중…" : "수업 시작"}</button>
    </div>`}
    ${book.pdf ? `<a class="pill secondary pdf" href="${esc(pdfUrl(book.pdf))}" target="_blank" rel="noopener" download>${I("download")}${T.book(book.no, kids)} PDF 받기</a>` : ""}
    <div class="row"><b class="grow">다른 Lesson 고르기</b><button class="link" data-act="lhAll">${H.all ? "접기" : "펼치기"}</button></div>
    ${H.all ? `<div class="lh-list">${book.lessons.map((x, i) => `${x.unit != null && (i === 0 || book.lessons[i - 1].unit !== x.unit) ? `<div class="lh-unit">${T.unit(x.unit)} · ${esc((book.units ?? []).find((u) => u.no === x.unit)?.title ?? "")}</div>` : ""}<button class="lh-item" data-act="lhStart" data-v="${x.id}" data-s="1"><b>${T.lesson(x.no)}</b><span class="grow">${esc(x.title)}</span>${x.no < nn ? I("check", "ok") : ""}</button>`).join("")}</div>` : ""}
  </div>`;
}

export function renderTeacherPick(sel, esc) {
  return `<p class="muted small">진도와 익힌 표현은 그대로 남아요. 선생님마다 나와 나눈 이야기는 따로 기억해요.</p>${TEACHERS.map((t) => `<button class="tpick ${t.id === sel ? "on" : ""}" data-act="lhPickTeacher" data-v="${t.id}">
    <img src="${teacherImg(t.id)}" alt=""><span class="grow"><b>${esc(t.ko)} (${esc(t.en)})</b><br><span class="small">${esc(t.intro)}</span><br><span class="muted tiny">이런 분께: ${esc(t.forWhom)}</span></span></button>`).join("")}`;
}

// ---------- 어른 수업 화면 ----------
export function renderStageShell(run, I, esc) {
  return `<div class="ls">
    <div class="ls-nav"><button class="nav-pill" data-act="lsExit">${I("arrow_back")}교재 목록</button><span class="grow"></span>
      <a class="ls-pg" id="lsPage" target="_blank" rel="noopener" href="lessons/pdf/bilody_${run.kids ? "kids_" : ""}${run.bookNo}.pdf"></a>
      <button class="nav-pill" data-act="lsHome">${I("home")}처음 화면</button></div>
    <div class="ls-top"><div class="grow"><b class="ls-title">${run.bookLabel} · ${T.lesson(run.no)} · ${esc(run.title)}</b><div class="muted tiny" id="lsSub"></div></div></div>
    <div class="ls-bar"><i id="lsBar"></i></div>
    <div class="ls-body" id="lsBody"></div>
    <p id="lsNotice" class="error small"></p>
    <div class="ls-teacher"><div class="ls-bubble grow"><b id="lsTurn" class="small"></b><div id="lsSay"></div></div>
      <div class="ls-face"><img id="lsFace" alt=""><span id="lsState" class="tiny b"></span></div></div>
    <div class="ls-ctl" id="lsCtl"></div>
  </div>`;
}

export function stepHtml(s, u, run, esc, I) {
  const m = (x) => marked(x, esc);
  const card = (inner) => `<div class="card ls-card">${inner}</div>`;
  switch (s?.type) {
    case "intro": return `<img class="ls-scene" src="${imgUrl(s.scene)}" alt="">${card(`<div class="ls-en">${esc(s.title_en)}</div><div class="muted">${esc(s.title)}</div><div class="accent small b">오늘의 목표 · ${esc(s.goal)}</div>`)}`;
    case "card": return card(`<div class="accent small b">오늘의 표현 ${esc(s.n)}</div><div class="ls-big">${m(s.en)}</div><div class="ls-ko">${esc(s.ko)}</div><hr><div class="muted small">${m(s.when)}</div><div class="muted small">${m(s.extra)}</div>`);
    case "dialogue": {
      const play = !!s.play;
      return `${play ? `<img class="ls-scene" src="${imgUrl(`img/s/${run.id}.jpg`)}" alt="">` : ""}${s.title ? `<div class="accent small b">${esc(s.title)}</div>` : ""}
        ${(s.lines ?? []).map((ln, i) => { const mine = !play && ln.who?.code === "J"; const hi = i === u.lessonHiLine;
          return `<div class="ls-line ${hi ? "hi" : ""} ${mine ? "mine" : ""}"><img src="${imgUrl(`img/f/${ln.who?.id ?? "grace"}.jpg`)}" alt=""><div class="grow">
            <div class="tiny b ${mine ? "ok" : "accent"}">${esc(ln.who?.en ?? "")}${mine ? " · 내 차례" : ""}</div><div class="ls-l-en">${m(ln.en)}</div><div class="muted small">${esc(ln.ko)}</div></div></div>`; }).join("")}`;
    }
    case "tf": return card(`<div class="accent small b">맞으면 T, 틀리면 F</div>${(s.items ?? []).map((q, i) => `<div class="ls-q">${i + 1}. ${esc(q)}</div>`).join("")}`);
    case "frame": return card((s.frame ?? []).map((f) => `<div class="muted tiny">${esc(f[0])}</div><div class="ls-q b">${m(f[1])}</div>`).join("")) +
      card(`<table class="ls-tb"><tr>${(s.head ?? []).map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${(s.rows ?? []).map((r) => `<tr>${r.map((c) => `<td>${m(c)}</td>`).join("")}</tr>`).join("")}</table>`);
    case "grammar": return (s.items ?? []).map((g) => card(`<b class="accent">${esc(g[0])}</b><div>${m(g[1])}</div>`)).join("") +
      card(`<div class="accent small b">자주 틀리는 표현</div>${(s.errors ?? []).map((e) => `<div><s class="bad">${esc(e[0])}</s> → <b class="ok">${esc(e[1])}</b></div><div class="muted tiny">${m(e[2])}</div>`).join("")}`);
    case "drill": return card(`<div class="accent small b">${m(s.note)}</div>${(s.items ?? []).map((d, i) => `<div class="ls-q b">${i + 1}. ${esc(d[0])}</div><div class="muted tiny">${esc(d[1] ?? "")}</div>`).join("")}`);
    case "review": return card(`<div class="accent small b">지난 시간에 배운 표현</div>${(s.cards ?? []).map((x) => `<div class="ls-q b">${m(x)}</div>`).join("")}`);
    case "more": return (s.groups ?? []).map((g) => card(`<div class="accent small b">${esc(g[0])}</div>${(g[1] ?? []).map((x) => `<div class="row"><b class="grow">${esc(x[0])}</b><span class="muted small">${esc(x[1])}</span><span class="tag">${esc(x[2] ?? "")}</span></div>`).join("")}`)).join("");
    case "tips": return (s.boxes ?? []).map((b) => card(`<b class="accent">${esc(b[0])}</b><div>${m(b[1])}</div>`)).join("") + card(`<div class="accent small b">빈칸을 채워 대화를 완성해요</div><div class="ls-q">${m(s.blank)}</div>`);
    case "pics": return `<div class="ls-pics">${(s.items ?? []).map((p) => { const hi = u.lessonHiWord && u.lessonHiWord.toLowerCase() === String(p.en).toLowerCase(); const c = p.cell ?? 0;
      return `<div class="ls-pic ${hi ? "hi" : ""}"><div class="sprite" style="background-image:url('${imgUrl(p.sprite)}');background-position:${(c % 4) * 100 / 3}% ${Math.floor(c / 4) * 50}%"></div><b>${esc(p.en)}</b><span class="muted tiny">${esc(p.ko)}</span></div>`; }).join("")}</div>`;
    case "words": return card((s.items ?? []).map((w) => `<div><b>${esc(w[0])}</b> ${esc(w[1])}</div><div class="muted tiny">${esc(w[2] ?? "")}</div>`).join(""));
    case "my": return (s.role ? card(`<b class="accent">역할 카드로 연습해요</b><div class="small">${m(s.role)}</div>`) : "") + card((s.items ?? []).map((q, i) => `<div class="ls-q b">${i + 1}. ${esc(q[0])}</div><div class="muted tiny">도움: ${esc(q[1] ?? "")}</div>`).join(""));
    case "read": return card(`<div class="row"><b class="ls-q grow">${esc(s.title)}</b>${s.face ? `<img class="face" src="${imgUrl(s.face)}" alt="">` : ""}</div><div class="ls-read">${m(s.text)}</div><div class="muted tiny">${esc(s.gloss)}</div>${(s.questions ?? []).map((q, i) => `<div class="accent b small">Q${i + 1}. ${esc(q)}</div>`).join("")}`);
    case "can": return card(`<div class="accent small b">오늘 할 수 있게 된 것</div>${(s.items ?? []).map((x) => `<div>${I("check", "ok")} ${esc(x)}</div>`).join("")}`);
    // 0.9.4 어린이 수업(AI 선생님이 듣고 가르침). 누른 것은 선생님에게 (App: …) 메모로.
    case "k_letter": return `<img class="ls-scene" src="${imgUrl(s.scene)}" alt=""><div class="k-letter">${esc(s.letter)} ${esc(String(s.letter).toLowerCase())}</div><p class="center-text accent">${esc(s.name_ko)} · 소리 ‘${esc(s.sound_ko ?? "")}’</p>`;
    case "k_words": case "k_pick": {
      const pick = s.type === "k_pick"; const t = run.kTap ??= {}; const picked = t[s.id] ??= [];
      return `${pick ? `<p class="center-text b accent">${esc(s.say)}</p>` : ""}<div class="k-grid">${(s.items ?? []).map((w) => { const on = pick && picked.includes(w.en);
        const hi = u.lessonHiWord && u.lessonHiWord.toLowerCase() === String(w.en).toLowerCase();
        return `<button class="k-word ${on ? (w.ok ? "good" : "bad") : ""} ${hi ? "hi" : ""}" data-act="lkTap" data-v="${esc(w.en)}"><img src="${imgUrl(w.img)}" alt="">${!pick || on ? `<b>${esc(w.en)}</b>` : ""}${pick ? "" : `<span class="muted tiny">${esc(w.ko)}</span>`}</button>`; }).join("")}</div>`;
    }
    case "k_chant": return card((s.lines ?? []).map((l) => `<div class="k-chant">${esc(l)}</div>`).join(""));
    case "k_hunt": {
      const t = run.kTap ??= {}; const found = t[s.id] ??= []; const tg = String(s.target).toLowerCase();
      const all = (s.grid ?? []).flat().filter((c) => c.toLowerCase() === tg).length;
      return `<p class="center-text small">${m(s.say)}</p><div class="k-hunt">${(s.grid ?? []).map((row, r) => row.map((ch, c) => { const key = `${r}:${c}`; const on = found.includes(key); const hit = ch.toLowerCase() === tg;
        return `<button class="k-cell ${on && hit ? "hit" : ""}" data-act="lkHunt" data-v="${key}">${esc(ch)}</button>`; }).join("")).join("")}</div>${found.length >= all && all ? `<p class="ok b center-text">다 찾았어요! ${esc(s.answer ?? "")}</p>` : ""}`;
    }
    case "k_say": return card(`<div class="accent small b">${esc(s.say)}</div><div class="k-model">${esc(s.model)}</div>${s.hint ? `<div class="muted small">${esc(s.hint)}</div>` : ""}`);
    case "k_stars": return card(`<h2>오늘 할 일 끝!</h2>${(s.items ?? []).map((x) => `<div>⭐ ${esc(x)}</div>`).join("")}<hr><b class="accent small">보호자께</b>${(s.home ?? []).map((x) => `<div class="muted small">· ${esc(x)}</div>`).join("")}`);
    default: return card(`<div class="accent small b">마무리</div>${run.expressions.map((x) => `<div class="ls-q b">${esc(x)}</div>`).join("")}`);
  }
}

export function renderDone(run, d, esc, I) {
  return `<div class="ls-done">
    <div class="done-ic">${I("check")}</div><h2>오늘 할 일 끝!</h2>
    <p class="muted">${run.bookLabel} · ${T.lesson(run.no)} · ${T.part(run.session)}을 마쳤어요</p>
    <div class="done-stats">${[[d.practiced.length, "익힌 표현"], [d.said, "말한 문장"], [`${d.minutes}분`, "수업 시간"]].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join("")}</div>
    <div class="card"><b>오늘 익힌 표현</b>${d.practiced.map((x) => `<div class="b">${esc(x)}</div>`).join("")}
      ${d.fixed.length ? `<hr><div class="muted small">고친 문장</div>${d.fixed.map((x) => `<div>${esc(String(x).replace("->", "→"))}</div>`).join("")}` : ""}</div>
    <button class="pill primary" data-act="lsTalk">대화하며 써 보기</button>
    <button class="link" data-act="lsExit">끝내기</button>
  </div>`;
}

// ---------- 어린이 수업(마이크 없이 듣고 누르기) ----------
const KID_SOUND = { A: "ah", B: "buh", C: "kuh", D: "duh", E: "eh", F: "fff", G: "guh", H: "huh", I: "ih", J: "juh", K: "kuh", L: "lll", M: "mmm", N: "nnn", O: "aw", P: "puh",
  Q: "kwuh", R: "rrr", S: "sss", T: "tuh", U: "uh", V: "vvv", W: "wuh", X: "ks", Y: "yuh", Z: "zzz" };

export class KidsRun {
  constructor(run, player, speed, onChange) {
    this.run = run; this.player = player; this.speed = Math.min(speed, 0.95); this.onChange = onChange;
    this.i = 0; this.gen = 0; this.speaking = false; this.bubble = ""; this.stars = 0; this.hiLine = -1; this.picked = []; this.found = [];
    this.letter = run.letter ?? "A"; this.snd = KID_SOUND[this.letter.toUpperCase()] ?? this.letter;
    this.voice = byId(run.teacher ?? "grace").voice;
    // X처럼 끝소리를 배우는 과: 고르기 정답 낱말이 글자로 시작하지 않으면 "end with"로 안내(헤니 검토)
    const pick = run.steps.find((x) => x.type === "k_pick");
    this.endSound = !!pick && (pick.items ?? []).filter((w) => w.ok).every((w) => !String(w.en).toLowerCase().startsWith(this.letter.toLowerCase()));
  }
  get step() { return this.run.steps[this.i]; }
  tts(t) { return String(t).replace(/\/[^/]+\//g, this.snd); }
  /** 하던 소리를 끊고 새 차례 번호를 받는다(헤니 검토: 한 번에 한 소리만, 나가면 0개) */
  cut() { this.gen++; this.player.stop(); this.speaking = false; return this.gen; }
  async say(text, voice = this.voice, gen = this.gen) {
    if (!text || gen !== this.gen) return;
    this.bubble = text; this.onChange();
    let s; try { s = await api.say(text, voice, this.speed, null); } catch { return; }
    if (gen !== this.gen) return;
    this.speaking = true; this.onChange();
    await this.player.play(s.pcm, s.rate);
    if (gen === this.gen) { this.speaking = false; this.onChange(); }
  }
  async go(n) {
    const gen = this.cut();
    this.i = Math.max(0, Math.min(n, this.run.steps.length - 1)); this.hiLine = -1; this.picked = []; this.found = []; this.speaking = false; this.onChange();
    const s = this.step; const say = (t, v) => this.say(t, v, gen);
    switch (s.type) {
      case "k_letter": for (const t of s.say ?? []) await say(t); await say(`${this.letter} says ${this.snd}.`); break;
      case "dialogue": for (let k = 0; k < (s.lines ?? []).length; k++) { if (gen !== this.gen) return; this.hiLine = k; this.onChange(); await say(this.tts(plain(s.lines[k].en)), sceneVoice(s.lines[k].who?.id)); } if (gen === this.gen) { this.hiLine = -1; this.onChange(); } break;
      case "k_words": await say("Let's learn some words!"); for (const w of s.items ?? []) await say(w.en); break;
      case "k_chant": for (const l of s.lines ?? []) await say(this.tts(l)); break;
      case "k_pick": await say(`Tap the pictures that ${this.endSound ? "end" : "start"} with ${this.snd}!`); break;
      case "k_hunt": await say(`Find all the big ${this.letter} and little ${this.letter.toLowerCase()}!`); break;
      case "k_say": await say("Say it with me!"); await say(String(s.model ?? "").replace("___", "Haru")); break;
      case "k_stars": await say("Great job today! See you next time!"); break;
    }
  }
  tapWord(en) { const gen = this.cut(); this.say(en, this.voice, gen); }
  pick(en, ok) { if (this.picked.includes(en)) return; this.picked.push(en); const gen = this.cut(); this.onChange(); (async () => { await this.say(en, this.voice, gen); await this.say(ok ? "Yes!" : `Hmm, listen: ${en}.`, this.voice, gen); })(); }
  hunt(key, ch) { if (this.found.includes(key)) return; this.found.push(key); this.onChange(); if (ch.toLowerCase() === this.letter.toLowerCase()) { const gen = this.cut(); this.say(ch, this.voice, gen); } }
  next() { if (["k_pick", "k_hunt", "k_say"].includes(this.step?.type)) this.stars = Math.min(3, this.stars + 1); this.go(this.i + 1); }
  stop() { this.cut(); }
}

/** 숨은 글자를 모두 찾았는지(답은 그때만 보여 준다, 헤니 검토) */
function huntDone(s, k) {
  const t = String(s.target).toLowerCase(); const all = (s.grid ?? []).flat().filter((c) => c.toLowerCase() === t).length;
  const hits = k.found.filter((key) => { const [r, c] = key.split(":").map(Number); return String(s.grid?.[r]?.[c] ?? "").toLowerCase() === t; }).length;
  return all > 0 && hits >= all;
}

export function renderKids(k, esc, I) {
  const s = k.step; const run = k.run; const m = (x) => marked(x, esc);
  let body = "";
  switch (s?.type) {
    case "k_letter": body = `<img class="ls-scene" src="${imgUrl(s.scene)}" alt=""><div class="k-letter">${esc(s.letter)} ${esc(s.letter.toLowerCase())}</div>
      <div class="center-text">${esc(s.name_ko)} · 소리 ${esc(s.sound_ko)}</div><p class="muted small center-text">${esc(s.mouth)}</p>`; break;
    case "dialogue": body = (s.lines ?? []).map((ln, i) => `<div class="ls-line ${i === k.hiLine ? "hi" : ""}"><img src="${imgUrl(`img/f/${ln.who?.id ?? "grace"}.jpg`)}" alt=""><div class="grow"><div class="tiny b accent">${esc(ln.who?.ko ?? "")}</div><div class="k-en">${m(ln.en)}</div><div class="muted small">${esc(ln.ko)}</div></div></div>`).join(""); break;
    case "k_words": body = `<div class="k-grid">${(s.items ?? []).map((w) => `<button class="k-word" data-act="kWord" data-v="${esc(w.en)}"><img src="${imgUrl(w.img)}" alt=""><b>${esc(w.en)}</b><span class="muted tiny">${esc(w.ko)}</span></button>`).join("")}</div>`; break;
    case "k_chant": body = (s.lines ?? []).map((l) => `<div class="k-chant">${esc(l)}</div>`).join(""); break;
    case "k_pick": body = `<p class="center-text small">${m(s.say)}</p><div class="k-grid">${(s.items ?? []).map((w) => { const on = k.picked.includes(w.en);
      return `<button class="k-word ${on ? (w.ok ? "good" : "bad") : ""}" data-act="kPick" data-v="${esc(w.en)}" data-ok="${w.ok ? 1 : 0}"><img src="${imgUrl(w.img)}" alt=""><b>${esc(w.en)}</b></button>`; }).join("")}</div>`; break;
    case "k_hunt": body = `<p class="center-text small">${m(s.say)}</p><div class="k-hunt">${(s.grid ?? []).map((row, r) => row.map((ch, c) => { const key = `${r}:${c}`; const on = k.found.includes(key); const hit = ch.toLowerCase() === String(s.target).toLowerCase();
      return `<button class="k-cell ${on ? (hit ? "hit" : "miss") : ""}" data-act="kHunt" data-v="${key}" data-ch="${esc(ch)}">${esc(ch)}</button>`; }).join("")).join("")}</div>${huntDone(s, k) && s.answer ? `<p class="ok small b center-text">다 찾았어요! ${esc(s.answer)}</p>` : ""}`; break;
    case "k_say": body = `<p class="center-text small">${m(s.say)}</p><div class="k-model">${esc(s.model)}</div>${s.hint ? `<p class="muted small center-text">${esc(s.hint)}</p>` : ""}<p class="ok small b center-text">소리 내어 따라 말해 보세요. (마이크는 쓰지 않아요)</p>`; break;
    case "k_stars": body = `<h2 class="center-text">오늘 할 일 끝!</h2>${(s.items ?? []).map((x) => `<div>⭐ ${esc(x)}</div>`).join("")}<hr><b class="accent small">보호자께</b>${(s.home ?? []).map((x) => `<div class="muted small">· ${esc(x)}</div>`).join("")}`; break;
  }
  const last = k.i >= run.steps.length - 1;
  return `<div class="ls kids">
    <div class="ls-top"><button class="round lilac" data-act="kExit" aria-label="교재 목록으로">${I("arrow_back")}</button><b class="grow">Kids Book ${run.bookNo} · ${esc(run.title)}</b>
      <span class="k-stars">${[0, 1, 2].map((x) => `<span class="${x < k.stars ? "on" : ""}">★</span>`).join("")}</span>
      <button class="round lilac" data-act="kHome" aria-label="처음 화면으로">${I("home")}</button></div>
    <div class="ls-bar"><i style="width:${((k.i + 1) / run.steps.length) * 100}%"></i></div>
    <div class="ls-body">${body}</div>
    <div class="ls-teacher"><div class="ls-bubble grow">${esc(k.bubble)}</div>
      <div class="ls-face"><img src="${teacherImg(run.teacher, k.speaking ? "speak" : "idle")}" alt=""></div></div>
    <div class="ls-ctl two"><button class="pill secondary compact" data-act="kPrev" ${k.i > 0 ? "" : "disabled"}>이전</button>
      ${last ? `<button class="pill primary compact" data-act="kDone">끝내기</button>` : `<button class="pill primary compact" data-act="kNext">다음</button>`}</div>
  </div>`;
}

// ---------- 동영상 강의(0.8.3) ----------
// videos/index.json: { "series": [ { "id", "title", "desc", "videos": [ { "id", "title", "sub", "minutes", "url", "poster" } ] } ] }
export function renderVideos(V, esc, I) {
  const top = `<div class="lh-top"><h2>동영상 강의</h2><button class="link lh-home" data-act="vClose">${I("home")}처음 화면</button></div>`;
  if (V.error) return `<div class="lh">${top}<p class="error">${esc(V.error)}</p></div>`;
  if (!V.index) return `<div class="lh">${top}<div class="spinner"></div></div>`;
  const series = (V.index.series ?? []).filter((x) => x && x.title);
  const any = series.some((x) => (x.videos ?? []).some((v) => v.url));
  return `<div class="lh">${top}
    <p class="muted small">교재 공부를 돕는 짧은 강의 · 무료</p>
    ${series.map((x) => `<div class="card vseries"><b class="accent">${esc(x.title)}</b>${x.desc ? `<p class="muted small">${esc(x.desc)}</p>` : ""}
      ${(x.videos ?? []).filter((v) => v.url).length ? `<div class="lh-list">${x.videos.filter((v) => v.url).map((v) => `<button class="vitem" data-act="vPlay" data-v="${esc(v.id)}">
        ${v.poster ? `<img src="${esc(v.poster)}" alt="">` : `<span class="vthumb">${I("play_circle")}</span>`}
        <span class="grow"><b>${esc(v.title)}</b>${v.sub ? `<br><span class="muted small">${esc(v.sub)}</span>` : ""}</span>${v.minutes ? `<span class="muted small">${esc(String(v.minutes))}분</span>` : ""}</button>`).join("")}</div>`
        : `<p class="muted small">첫 강의를 준비하고 있어요. 곧 올라와요.</p>`}</div>`).join("")}
    ${!series.length && !any ? `<div class="card"><p class="muted">강의를 준비하고 있어요. 곧 올라와요.</p></div>` : ""}
  </div>`;
}
export const findVideo = (V, id) => { for (const x of V?.index?.series ?? []) for (const v of x.videos ?? []) if (v.id === id && v.url) return v; return null; };

// ---------- 0.8.4 처음 이야기(레벨 확인) 뒤 추천 ----------
// Book마다 ‘이 Book에서 익힐 것’(단원 제목에서). 안드로이드 Placement.kt와 같은 글.
export const PL_LEARN = {
  1: "만나서 반가워요, 꼭 필요한 말처럼 가장 기본적인 말부터, 한국어 설명과 함께 천천히",
  2: "나의 하루, 동네, 쇼핑처럼 일상을 짧은 문장으로 말하기",
  3: "일상 대화, 부탁과 약속, 추천과 비교처럼 내 이야기를 조금 더 길게 하는 말",
  4: "여행 준비와 여행 중에 묻고 부탁하고, 다녀온 이야기를 하는 말",
  5: "일상 문제 풀기, 마음 나누기처럼 생각과 경험을 이어서 말하기",
  6: "회의와 발표처럼 함께 일하며 의견을 나누고 이끄는 말",
  7: "선택, 일하는 방식, 사회처럼 내 생각을 근거와 함께 말하는 법",
  8: "삶과 가치, 기술과 미래처럼 깊은 주제를 자연스럽게 이야기하는 법",
  9: "말투와 격식, 뉘앙스처럼 내 의견을 상황에 맞게 다듬어 말하는 법",
};
export const plStore = {
  get: (store) => { const b = Number(store.get("pl_book", 0)); return b >= 1 && b <= 9 ? { book: b, teacher: store.get("pl_teacher", "grace") } : null; },
  set: (store, book, teacher) => { store.set("pl_book", book); store.set("pl_teacher", teacher); store.set("pl_at", Date.now()); },
};
/** 처음 이야기 안내 창 */
export function renderPlIntro(t, esc) {
  return `<div class="pl-head"><img src="${teacherImg(t.id)}" alt=""><h2>${esc(t.ko)} 선생님과 5분 이야기해 볼까요?</h2></div>
    <p>영어로 편하게 이야기하면, 1:1 수업을 어느 Book부터 하면 좋을지 알려 드릴게요.</p>
    <p class="muted small">잘 못해도 괜찮아요. 모르면 한국어로 말해도 돼요. 고쳐 주지 않고 이야기만 나눠요.</p>
    <button class="pill primary" data-act="plStart">이야기 시작하기</button>
    <div class="row end"><button class="link" data-act="plLater">나중에 할게요</button></div>`;
}
/** 추천 결과 창(11/19 실장님 확정 문구) */
export function renderPlResult(d, t, books, esc) {
  const b = d.book; const book = books?.find((x) => x.kind !== "kids" && x.no === b);
  const title = book?.title_ko ? ` ‘${book.title_ko}’` : "";
  const nm = d.name ? `${esc(d.name)} 님, ` : "";
  const head = b === 1 ? `${nm}영어로 대답해 줘서 고마워요!` : b === 9 ? `${nm}영어로 생각을 꽤 자유롭게 말하네요!` : `${nm}오늘 이야기 나눠서 즐거웠어요!`;
  const rec = b === 1 ? `Book 1${esc(title)}부터 같이 시작해요.` : b === 9 ? `Book 9${esc(title)}에서 더 자연스럽게 다듬어 봐요.` : `Book ${b}${esc(title)}부터 시작하면 딱 좋겠어요.`;
  const gk = String(d.good_ko ?? "").trim().replace(/[.!]*$/, "");
  const good = d.quote ? `“${esc(d.quote)}”처럼 ${esc(gk || "영어로 잘 말했어요")}.` : b === 1 ? "영어로 이야기해 보려고 끝까지 함께해 줬어요." : "";
  const foot = b === 9 ? "대화하기로 마음껏 이야기해도 좋아요." : "조금 쉽다 싶은 데서 시작해야 오래 가요. 맞지 않으면 언제든 다른 Book으로 바꿀 수 있어요.";
  return `<div class="pl-head"><img src="${teacherImg(t.id)}" alt=""><h2>${head}</h2></div>
    <p class="pl-rec">${rec}</p>
    ${good ? `<p><b class="accent">좋았던 점</b> ${good}</p>` : ""}
    <p><b class="accent">이 Book에서 익힐 것</b> ${esc(PL_LEARN[b] ?? "")}</p>
    <p class="muted small">${foot}</p>
    <button class="pill primary" data-act="plGo" data-v="${b}">Book ${b} Lesson 1 시작하기</button>
    <button class="pill secondary" data-act="plBrowse" data-v="${b}">다른 Book 둘러보기</button>
    <div class="row end"><button class="link" data-act="closeDialog">지금은 대화만 할게요</button></div>`;
}
