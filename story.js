// 동화 듣기(안드로이드 RealtimeController의 동화 부분을 옮김). 시험자는 마이크 없이 터치로만 논다(OPS-004).
// 소리·그림은 story/*.pack 묶음에서 꺼내 쓴다(안드로이드 res/raw·drawable-nodpi와 같은 자료).
import * as api from "./api.js?v=0.8.3";
import { Chat } from "./rt.js?v=0.8.3";
import { byId } from "./characters.js?v=0.8.3";

const KIDS_PRESET = "kids-demo";
let libP = null;
export const loadLib = () => (libP ??= fetch("story/lib.json").then((r) => r.json()));

// ---------- 묶음 파일 ----------
const packs = new Map();
const urls = new Map();
function loadPack(id) {
  if (!packs.has(id)) {
    packs.set(id, fetch(`story/${id}.pack`).then((r) => { if (!r.ok) throw new Error("pack"); return r.arrayBuffer(); }).then((buf) => {
      const n = new DataView(buf).getUint32(0, true);
      const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
      return { buf, base: 4 + n, head };
    }).catch((e) => { packs.delete(id); throw e; }));
  }
  return packs.get(id);
}
function bytes(p, name) { const e = p.head[name]; return e ? p.buf.slice(p.base + e[0], p.base + e[0] + e[1]) : null; }
/** 묶음 안의 그림을 화면에 쓸 주소로(한 번 만든 주소는 다시 쓴다). */
function url(p, name) {
  if (!p?.head[name]) return null;
  if (!urls.has(name)) urls.set(name, URL.createObjectURL(new Blob([bytes(p, name)], { type: name.startsWith("p/") || name.startsWith("i/") || name.startsWith("t/") ? "image/webp" : "application/octet-stream" })));
  return urls.get(name);
}
let common = null;
export async function loadCommon() { common = await loadPack("common"); return common; }
export const thumbUrl = (id) => url(common, `t/${id}`);
export const picUrl = (pic) => url(common, `p/${pic}`);

// ---------- 마지막으로 듣던 자리 ----------
const posKey = () => `bilody_${api.userId() ?? "anon"}_story_pos`;
export function loadPosition() { try { return JSON.parse(localStorage.getItem(posKey()) || "null"); } catch { return null; } }
function savePosition(id, page) { try { localStorage.setItem(posKey(), JSON.stringify({ id, page })); } catch { /* */ } }

const NARR = { INTRO: 1, TITLE: 2, PAGE: 3, BACK: 4, NEXT: 5, WORD: 6, QUIZ_START: 7, QUIZ_ASK: 8, QUIZ_YES: 9, QUIZ_NO: 10, QUIZ_SHOW: 11, QUIZ_END: 12 };
const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

export class StoryPlayer {
  constructor({ player, onChange }) {
    this.player = player; this.onChange = onChange;
    this.ui = { state: "connecting", title: "", titleEn: "", page: 1, pages: 1, image: null, picture: null, pictureSeq: 0, quiz: null,
      canRestart: false, notice: null, line: "", credit: "", bg: "#EEF0F6", storyId: null };
    this.closed = false; this.sessionId = null;
    this.book = null; this.pack = null; this.page = 0; this.storyStarted = false; this.narrInterrupted = false;
    this.epoch = 0; this.sources = []; this.timers = new Set(); this.resumeTimer = null; this.narrKind = NARR.INTRO; this.playing = false;
    this.quizQs = []; this.quizIdx = -1; this.quizTries = 0; this.quizStars = 0; this.quizDoneFor = null; this.quizBusy = false; this.quizMiss = 0; this.quizWait = null;
    this.tapped = new Set(); this.decoded = new Map();
    this.meterAt = 0; this.meterTimer = null; this.limitReached = false;
  }
  set(p) { Object.assign(this.ui, p); this.onChange?.(); }
  log(kind, data = {}) { api.logEvent(this.sessionId, kind, { ...data, web: true }); }
  get quizActive() { return this.quizIdx >= 0; }

  /** storyId가 "resume"이면 마지막으로 듣던 동화를 처음부터(앱과 같음). */
  async start(storyId) {
    this.player.unlock();
    try {
      const lib = this.lib = await loadLib();
      await loadCommon();
      const pos = loadPosition();
      const id = storyId === "resume" ? (pos?.id ?? lib.stories[0].id) : storyId;
      await this.openBook(lib.stories.find((b) => b.id === id) ?? lib.stories[0], 0);
      this.sessionId = await api.startSession(KIDS_PRESET).catch(() => null);
      if (this.closed) return;
      this.set({ state: "listening", canRestart: false, notice: null });
      this.startMeter();
      this.startStory();
      this.connectTalk();
    } catch (e) {
      this.set({ state: "stopped", canRestart: true, notice: "그림책을 불러오지 못했어요. 인터넷을 확인하고 이어서를 눌러 주세요." });
    }
  }

  async openBook(b, page) {
    this.book = b; this.page = page;
    this.pack = await loadPack(b.id);
    savePosition(b.id, page);
    this.set({ title: b.titleKo, titleEn: b.title, pages: b.pages.length, page: page + 1, image: null, picture: null, storyId: b.id, bg: b.bg,
      credit: (b.credit.split(" 바꾼 점")[0].split(", via StoryWeaver")[0]) });
  }
  // ---------- 동화 중 대화(11/13: 시험자도 마이크로 대화, 앱과 같음) ----------
  /** 토리와 말로 이야기하는 연결을 연다. 마이크를 못 쓰면 동화는 터치로 계속된다. */
  connectTalk() {
    if (this.chat || this.closed) return;
    const pics = new Set(this.lib.pics);
    this.chat = new Chat({
      voiceId: byId("tori").voice, speed: 1, saveTranscripts: false, player: this.player, presetId: KIDS_PRESET, sessionId: this.sessionId,
      // 동화 화면에는 '다시 시작' 버튼이 없으므로, 연결 실패는 동화 화면에 맞는 말로 바꿔 보여 준다(하루 한도 안내는 그대로)
      onChange: (u) => this.set({ micOn: !!u.micOn, talkNotice: !u.notice ? null : (u.state === "stopped" || /마이크/.test(u.notice)) ? u.notice
        : "말로 이야기하는 연결이 끊겼어요. 그림책은 계속 볼 수 있어요. ‘일시정지’ 뒤 ‘이어서’를 누르면 다시 연결해요." }),
      story: {
        onSpeechStart: () => this.pauseNarration(),
        onReplyDone: () => { if (this.quizActive) this.later(1500, () => { if (this.quizActive && !this.quizBusy) this.askQuiz(); }); else this.scheduleResume(2500); },
        onNoise: () => { if (this.quizActive) return this.later(600, () => { if (this.quizActive && !this.quizBusy) this.askQuiz(); }); this.narrInterrupted = false; this.scheduleResume(600); },
        onCue: (pic) => this.set({ picture: pic, pictureSeq: this.ui.pictureSeq + 1 }),
        isNarrating: () => this.playing,
        pictureFor: (w) => { const p = this.lib.match[w.toLowerCase().replace(/^'+|'+$/g, "")]; return p && pics.has(p) ? p : null; },
      },
    });
    this.syncTalk();
    this.chat.start();
  }
  /** 아이 모드 지시문(앱 kidsInstructions와 같은 규칙). 쪽이 바뀔 때마다 그 쪽 글을 담아 보낸다. */
  kidsInstructions(extra = "") {
    const b = this.book; if (!b) return null;
    const p = b.pages[this.page]?.text ?? "";
    const words = [...new Set(this.lib.pics ?? [])].filter((w) => w.length > 2).join(", ");
    return [
      `You are Tori, a gentle, playful friend reading the picture book "${b.title}" with a toddler (about 2 to 3 years old) and a parent nearby.`,
      "Rules:",
      "- Speak only English. Reply with 1 or 2 very short sentences, 2 to 6 words each. Present tense, here and now.",
      "- React warmly to what the child says. If the child names something (even in Korean), say the English word clearly, for example: Yes! A dog. Woof, woof.",
      `- When it fits, use words that have pictures: ${words}.`,
      "- If you cannot understand the sound, give a short kind reaction like \"Oh!\" or \"I hear you.\" Never pretend to understand.",
      "- Never quiz, never ask them to repeat, never correct, never say you can see them. (You only see photos they choose to show you.)",
      "- Do not continue the story yourself and do not say goodbye. The app keeps reading after you.",
      "- No emojis, lists, or stage directions.",
      `The page being read now: "${p}"`,
    ].join("\n") + extra;
  }
  syncTalk(extra = "") { const t = this.kidsInstructions(extra); if (t && this.chat) this.chat.setInstructions(t); }

  /** 말소리가 들리면 읽던 동화를 멈춘다(대답이 끝나면 '어디까지 했지' 말과 함께 그 쪽을 다시 읽는다). */
  pauseNarration() {
    clearTimeout(this.resumeTimer); clearTimeout(this.quizWait);
    if (this.playing) { this.stopAudio(); this.narrInterrupted = true; }
    this.quizBusy = false;
    this.set({ state: "listening" });
  }
  get talkBusy() { const c = this.chat; return !!c && (!!c.resp || !!c.ui.speech || this.player.isPlaying); }

  pageImg(name) { return url(this.pack, `i/${name}`); }

  // ---------- 소리 ----------
  async decode(name) {
    if (this.decoded.has(name)) return this.decoded.get(name);
    const p = name.startsWith(`story_${this.book?.id}_`) ? this.pack : common;
    const data = bytes(p, `a/${name}`) ?? bytes(this.pack, `a/${name}`);
    if (!data) return null;
    const ctx = this.player.ctx;
    const buf = await new Promise((res, rej) => { const r = ctx.decodeAudioData(data, res, rej); if (r && r.catch) r.catch(() => {}); }).catch(() => null);
    if (buf) this.decoded.set(name, buf);
    return buf;
  }
  hasClip(name) { return !!(common?.head[`a/${name}`] || this.pack?.head[`a/${name}`]); }

  stopAudio() {
    this.epoch++;
    for (const s of this.sources) { try { s.onended = null; s.stop(); } catch { /* */ } }
    this.sources = []; this.playing = false;
    for (const t of this.timers) clearTimeout(t); this.timers.clear();
  }
  later(ms, f) { const t = setTimeout(() => { this.timers.delete(t); f(); }, ms); this.timers.add(t); return t; }

  /** 소리 여러 개를 0.25초 쉬고 이어 들려준다. 끝나면 onNarrationDone. cues: 단어 그림이 튀어 오를 시각. */
  async playNarration(kind, text, names, cues = [], fallbackMs = 1500) {
    if (this.closed) return;
    clearTimeout(this.resumeTimer);
    this.stopAudio();
    const ep = this.epoch;
    this.narrKind = kind;
    const bufs = (await Promise.all(names.map((n) => this.decode(n)))).filter(Boolean);
    if (ep !== this.epoch || this.closed) return;
    // 소리를 풀지 못하는 브라우저: 글자만 보여 주고 읽는 시간만큼 기다린다(쪽이 휙휙 넘어가지 않게)
    if (!bufs.length) { this.set({ state: "speaking", line: text }); this.later(fallbackMs, () => { if (ep === this.epoch) this.onNarrationDone(); }); return; }
    const ctx = this.player.ctx; let t = ctx.currentTime + 0.05;
    bufs.forEach((b, i) => {
      const s = ctx.createBufferSource(); s.buffer = b; s.connect(this.player.gain); s.start(t); t += b.duration + (i < bufs.length - 1 ? 0.25 : 0);
      this.sources.push(s);
      if (i === bufs.length - 1) s.onended = () => { if (ep === this.epoch) { this.playing = false; this.sources = []; this.onNarrationDone(); } };
    });
    this.playing = true;
    if (text) this.chat?.noteHeard(text);
    this.set({ state: "speaking", line: text });
    for (const c of cues) this.later(c.t + 50, () => { if (ep === this.epoch && this.playing) this.set({ picture: c.pic, pictureSeq: this.ui.pictureSeq + 1 }); });
  }

  playLine(key, kind) { const l = this.lib.lines[key]; if (l) this.playNarration(kind, l.text, [l.res]); else this.onNarrationDone(); }

  // ---------- 동화 흐름(앱과 같음) ----------
  startStory() {
    if (!this.storyStarted) { this.storyStarted = true; this.playLine("intro", NARR.INTRO); }
    else this.playLine("back", NARR.BACK);
  }

  playTitleOrPage() {
    const b = this.book;
    if (this.page === 0 && b.titleRes) {
      this.set({ image: b.pages[0]?.img ?? null, page: 1 });
      this.playNarration(NARR.TITLE, b.title, [b.titleRes]);
    } else this.playPage(this.page);
  }

  playPage(i) {
    const b = this.book; const p = b.pages[i];
    if (!p) { if (!this.startQuiz()) this.nextStory(); return; }
    this.page = i;
    savePosition(b.id, i);
    if (this.limitReached) {
      this.pause("오늘 들을 수 있는 시간을 모두 썼어요. 자정이 지나면 이 쪽부터 이어서 들려줄게요.", false);
      return;
    }
    this.narrInterrupted = false;
    this.syncTalk();
    this.set({ page: i + 1, image: p.img ?? null, picture: p.img ? null : (p.key ?? this.ui.picture), pictureSeq: this.ui.pictureSeq + 1 });
    this.playNarration(NARR.PAGE, p.text, [p.res], p.cues ?? [], p.ms || 2500);
  }

  async nextStory() {
    const cur = this.book; const lib = this.lib;
    const nb = lib.stories[(lib.stories.findIndex((s) => s.id === cur.id) + 1) % lib.stories.length];
    this.log("story_next", { from: cur.id, to: nb.id });
    this.endQuizState(); this.tapped.clear(); this.decoded.clear();
    try { await this.openBook(nb, 0); } catch { this.pause("다음 그림책을 불러오지 못했어요. 이어서를 눌러 주세요."); return; }
    if (this.closed || this.ui.state === "stopped") return;
    if (lib.lines.next) this.playLine("next", NARR.NEXT); else this.playTitleOrPage();
  }

  /** 그림을 누름: 읽던 소리를 멈추고 그 단어를 말한 뒤, 읽던 쪽을 처음부터 다시 읽는다. */
  tapPicture(pic) {
    if (this.closed || this.ui.state === "stopped") return;
    const w = this.lib.words[pic]; if (!w) return;
    if (this.quizActive) { this.quizTap(pic); return; }
    this.tapped.add(pic);
    clearTimeout(this.resumeTimer);
    this.chat?.interruptReply();   // 토리가 대답하던 중이면 멈추고 누른 단어부터
    this.log("story_word", { pic });
    this.set({ picture: pic, pictureSeq: this.ui.pictureSeq + 1 });
    this.playNarration(NARR.WORD, w.text, [w.res]);
  }

  /** 옆으로 밀기: +1 다음 쪽, -1 앞 쪽. 일시정지 중이면 쪽만 바꿔 둔다. */
  async turnPage(delta) {
    if (this.closed || this.quizActive || !this.book) return;
    const b = this.book;
    const shown = Math.min(Math.max(this.ui.page - 1, 0), b.pages.length - 1);
    const target = shown + delta;
    this.log("story_swipe", { from: shown, delta });
    clearTimeout(this.resumeTimer); this.stopAudio(); this.narrInterrupted = false;
    if (this.ui.state !== "stopped") { if (target >= b.pages.length) this.nextStory(); else this.playPage(Math.max(0, target)); return; }
    if (target >= b.pages.length) {
      const lib = this.lib; const nb = lib.stories[(lib.stories.findIndex((s) => s.id === b.id) + 1) % lib.stories.length];
      await this.openBook(nb, 0); this.set({ image: nb.pages[0]?.img ?? null });
    } else {
      this.page = Math.max(0, target); savePosition(b.id, this.page);
      const p = b.pages[this.page]; this.set({ page: this.page + 1, image: p.img ?? null, picture: p.img ? null : p.key });
    }
  }

  // ---------- 그림 찾기 놀이 ----------
  startQuiz() {
    const b = this.book;
    if (this.quizDoneFor === b.id) return false;
    this.quizDoneFor = b.id;
    const qs = this.pickQuiz(b);
    if (!qs.length) return false;
    this.quizQs = qs; this.quizIdx = 0; this.quizTries = 0; this.quizStars = 0; this.quizMiss = 0;
    const lib = this.lib; savePosition(lib.stories[(lib.stories.findIndex((s) => s.id === b.id) + 1) % lib.stories.length].id, 0);
    this.log("quiz_start", { story: b.id, n: qs.length, tapped: qs.filter((q) => this.tapped.has(q.pic)).length });
    this.showQuizPage();
    this.playNarration(NARR.QUIZ_START, "", ["quiz_line_start"]);
    return true;
  }
  pickQuiz(b) {
    const pics = new Set(this.lib.pics);
    const cands = shuffle(b.pages.flatMap((pg, i) => {
      if (!pg.img) return [];
      const ps = [...new Set([...(pg.cues ?? []).map((c) => c.pic), ...(pg.see ?? [])])].filter((p) => pics.has(p));
      return ps.length < 2 ? [] : ps.filter((p) => this.hasClip(`quiz_ask_${p}`)).map((p) => ({ page: i, pic: p }));
    }));
    const ordered = [...cands].sort((a, z) => (this.tapped.has(z.pic) ? 1 : 0) - (this.tapped.has(a.pic) ? 1 : 0));
    const picked = [];
    for (const strict of [true, false]) for (const q of ordered) {
      if (picked.length >= 3) break;
      if (picked.some((x) => x.pic === q.pic) || (strict && picked.some((x) => x.page === q.page))) continue;
      picked.push(q);
    }
    return picked.sort((a, z) => a.page - z.page);
  }
  showQuizPage() {
    const q = this.quizQs[this.quizIdx]; if (!q) return;
    this.page = q.page; const pg = this.book.pages[q.page];
    this.syncTalk(`\nRight now the app is playing a find-the-picture game. The child is looking for: ${q.pic}. If the child talks, react in 2 to 4 words and gently encourage them to touch the picture. Never say where it is.`);
    this.set({ page: q.page + 1, image: pg.img, picture: null, pictureSeq: this.ui.pictureSeq + 1, quiz: { round: this.quizIdx, rounds: this.quizQs.length, stars: this.quizStars, done: false } });
  }
  nextQuizOrEnd() {
    this.quizIdx += 1; this.quizTries = 0;
    if (this.quizIdx < this.quizQs.length) { this.later(700, () => { if (this.quizActive && !this.closed) { this.showQuizPage(); this.askQuiz(); } }); return; }
    this.set({ quiz: { ...this.ui.quiz, done: true } });
    if (this.quizStars === this.quizQs.length) { this.quizBusy = true; this.playNarration(NARR.QUIZ_END, "", ["quiz_line_end"]); }
    else if (this.quizStars > 0) { this.quizBusy = true; this.playNarration(NARR.QUIZ_END, "", ["quiz_line_yes2"]); }
    else { this.narrKind = NARR.QUIZ_END; this.onNarrationDone(); }
  }
  waitForTap() {
    clearTimeout(this.quizWait);
    const idx = this.quizIdx;
    this.quizWait = setTimeout(() => {
      if (this.closed || !this.quizActive || this.quizIdx !== idx || this.quizBusy || this.ui.state === "stopped") return;
      const q = this.quizQs[this.quizIdx]; if (!q) return;
      this.quizMiss += 1;
      this.log("quiz_answer", { ok: false, timeout: true, tries: this.quizTries });
      this.quizBusy = true;
      this.set({ picture: q.pic, pictureSeq: this.ui.pictureSeq + 1 });
      this.playNarration(NARR.QUIZ_SHOW, "", [this.lib.words[q.pic]?.res].filter(Boolean));
    }, 5000);
  }
  askQuiz() { const q = this.quizQs[this.quizIdx]; if (q) this.playNarration(NARR.QUIZ_ASK, "", [`quiz_ask_${q.pic}`]); }
  quizTap(pic) {
    const q = this.quizQs[this.quizIdx]; if (!q || this.quizBusy) return;
    clearTimeout(this.quizWait); this.quizMiss = 0; clearTimeout(this.resumeTimer);
    this.quizBusy = true;
    if (pic === q.pic) {
      this.quizStars += 1;
      this.log("quiz_answer", { ok: true, tries: this.quizTries + 1 });
      this.set({ picture: pic, pictureSeq: this.ui.pictureSeq + 1, quiz: { ...this.ui.quiz, stars: this.quizStars } });
      const yes = ["quiz_line_yes1", "quiz_line_yes2", "quiz_line_yes3"][(this.quizIdx + this.quizStars) % 3];
      this.playNarration(NARR.QUIZ_YES, "", [yes, this.lib.words[pic]?.res].filter(Boolean));
    } else {
      this.quizTries += 1;
      this.log("quiz_answer", { ok: false, tries: this.quizTries });
      // 틀렸다고 하지 않는다: 누른 그림 이름을 알려 주고 다시 묻는다. 두 번째부터 정답 그림이 튄다.
      this.set({ picture: this.quizTries >= 2 ? q.pic : null, pictureSeq: this.ui.pictureSeq + 1 });
      this.playNarration(NARR.QUIZ_NO, "", [this.lib.words[pic]?.res].filter(Boolean));
    }
  }
  endQuizState() {
    clearTimeout(this.quizWait);
    this.quizQs = []; this.quizIdx = -1; this.quizTries = 0; this.quizBusy = false; this.quizMiss = 0;
    if (this.ui.quiz) this.set({ quiz: null });
  }

  onNarrationDone() {
    if (this.closed) return;
    this.set({ state: "listening" });
    switch (this.narrKind) {
      case NARR.INTRO: case NARR.NEXT: return this.playTitleOrPage();
      case NARR.TITLE: case NARR.BACK: return this.playPage(this.page);
      case NARR.WORD: this.narrInterrupted = false; return this.scheduleResume(900, true);
      case NARR.QUIZ_START: case NARR.QUIZ_NO: this.quizBusy = false; return this.askQuiz();
      case NARR.QUIZ_ASK: this.quizBusy = false; return this.waitForTap();
      case NARR.QUIZ_SHOW:
        this.quizBusy = false;
        // 두 문제 연달아 아무것도 누르지 않으면(아주 어린 아이) 놀이를 마치고 다음 동화로
        if (this.quizMiss >= 2) { this.log("quiz_end", { stars: this.quizStars, of: this.quizQs.length, why: "no_tap" }); return this.later(1200, () => this.nextStory()); }
        return this.nextQuizOrEnd();
      case NARR.QUIZ_YES: this.quizBusy = false; return this.nextQuizOrEnd();
      case NARR.QUIZ_END: this.quizBusy = false; this.log("quiz_end", { stars: this.quizStars, of: this.quizQs.length }); return this.later(1500, () => this.nextStory());
      case NARR.PAGE: {
        const p = this.book.pages[this.page];
        this.page += 1;
        // 물음이 있던 쪽 뒤에는 조금 더 기다린다. 원본 그림이 있는 쪽은 그림을 볼 시간을 준다(쪽마다 최소 5.5초).
        const base = p?.text?.includes("?") ? 4000 : 1200;
        return this.scheduleResume(p?.img ? Math.max(base, 5500 - p.ms) : base, true);
      }
    }
  }
  scheduleResume(ms, fresh = false) {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      if (this.closed || this.ui.state === "stopped") return;
      if (this.playing || this.talkBusy) return this.scheduleResume(1500, fresh);
      if (this.narrInterrupted && !fresh) this.playLine("back", NARR.BACK); else this.playPage(this.page);
    }, ms);
  }

  // ---------- 일시정지·이어서·나가기 ----------
  pause(notice = null, canRestart = true) {
    if (this.closed) return;
    clearTimeout(this.resumeTimer); clearTimeout(this.quizWait);
    if (this.playing) this.narrInterrupted = true;
    this.stopAudio();
    // 놀이 중에 멈추면 이어서 할 때 다음 동화부터(앱과 같음)
    if (this.quizActive) { this.endQuizState(); this.skipToNext = true; }
    this.flushMeter(); clearInterval(this.meterTimer); this.meterTimer = null;
    if (this.chat?.pc) this.chat.stopInternal("USER_STOP", null);   // 멈춘 동안 마이크도 끈다
    this.log("story_pause", { page: this.page + 1 });
    this.set({ state: "stopped", canRestart, notice });
  }
  resume() {
    if (this.closed) return;
    this.player.unlock();
    if (!this.book) return this.start("resume");
    this.set({ state: "listening", canRestart: false, notice: null });
    this.startMeter();
    if (this.chat) this.chat.restart(); else this.connectTalk();
    if (this.skipToNext) { this.skipToNext = false; return this.nextStory(); }
    this.startStory();
  }
  async close() {
    if (this.closed) return;
    this.flushMeter();
    this.closed = true;
    clearTimeout(this.resumeTimer); clearTimeout(this.quizWait); clearInterval(this.meterTimer);
    this.stopAudio();
    if (this.chat) await this.chat.close();   // 대화 연결을 닫고 대화 번호를 마무리한다
    else if (this.sessionId) await api.finishSession(this.sessionId);
  }

  // ---------- 이용 시간(앱과 같이 15초마다) ----------
  startMeter() {
    clearInterval(this.meterTimer);
    this.meterAt = Date.now();
    this.meterTimer = setInterval(() => this.flushMeter(), 15000);
  }
  flushMeter() {
    if (!this.meterAt) return;
    const now = Date.now(); const sec = Math.min(60, Math.floor((now - this.meterAt) / 1000));
    if (sec <= 0) return;
    this.meterAt = now;
    api.addActiveSeconds(sec, KIDS_PRESET).then((u) => {
      if (u && u.limit_seconds > 0 && u.today_seconds >= u.limit_seconds) this.limitReached = true;
    });
  }
}
