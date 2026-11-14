// 교재로 배우기(11/14, 운영자 계정만 먼저). 대화 중에 토리가 미리 만든 짧은 교재를 진행한다.
// 교재 동안에는 친구 AI가 대답하지 않고(rt.js lessonHold), 토리의 말은 앱이 정해진 문장으로 들려준다.
// 학습자 말은 기록(turns)에 남기지 않고, 끝나면 서버 대화 문맥에서도 지운다 → 기억·오늘 문맥에 들어가지 않음.
import * as api from "./api.js?v=0.8.8";
import { CHARACTERS } from "./characters.js?v=0.8.8";

const TORI_VOICE = CHARACTERS.find((c) => c.id === "tori").voice;
/** 11/14 실장님: 장면 대사는 캐릭터마다 자기 목소리로. */
const voiceOf = (who) => CHARACTERS.find((c) => c.id === who)?.voice ?? TORI_VOICE;
const KO_NAME = Object.fromEntries(CHARACTERS.map((c) => [c.id, c.ko]));
const NAMES = new Set(["tori", "moa", "nubi", "rino", "sola"]);
const FILLERS = new Set(["yes", "yeah", "oh", "okay", "ok", "um", "uh", "well", "hmm", "sure", "wow", "hi", "hello", "so", "no", "really", "great"]);
const NEGATIVE = /\b(no|not|never|cant|cannot|dont|busy|bad|terrible|boring|sorry)\b|아니|싫|안 돼|별로/;
const STOP = Symbol("stop");
const RESUME = /(let'?s (continue|go back|keep going|do it again|practice)|continue( the)? (practice|lesson|scene)|back to (the )?(practice|lesson|scene)|where were we|아까 (하던|그거)|다시 (하자|해|이어)|이어서 (하자|해)|계속 (하자|해)|표현 (익히기|연습))/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 11/14 헤니 검토 7: 분명한 위기 표현은 수업을 바로 멈추고 친구(안전 규칙)에게 넘긴다. 키워드만으로 안전을 보장하지는 않음.
const CRISIS = /\b(kill myself|end my life|want to die|wanna die|suicide|hurt myself|self harm|cut myself)\b|죽고 싶|죽을래|자살|자해|살기 싫|없어지고 싶/i;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------- 판정(교재 공통 v2와 같은 규칙) ----------------
export function normalize(s) {
  return String(s ?? "").normalize("NFC").replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/(\d):(\d)/g, "$1 $2")
    .toLowerCase().replace(/'/g, "").replace(/[^\p{L}\p{N}_\s]/gu, " ").replace(/\s+/g, " ").trim();
}
export function variants(n) {
  const out = [n]; const w = n.split(" ");
  if (w.length > 1 && NAMES.has(w[w.length - 1])) out.push(w.slice(0, -1).join(" "));
  if (w.length > 1 && NAMES.has(w[0])) out.push(w.slice(1).join(" "));
  const more = [];
  for (const v of out) { const ww = v.split(" "); if (ww.length > 1 && FILLERS.has(ww[0])) more.push(ww.slice(1).join(" ")); }
  return [...new Set([...out, ...more].filter(Boolean))];
}
const reCache = new Map();
const rx = (p) => { if (!reCache.has(p)) reCache.set(p, new RegExp(p)); return reCache.get(p); };
/** → { result: "ok"|"form_only"|"partial"|null, x, groups } */
export function judge(expr, text) {
  const vs = variants(normalize(text));
  for (const v of vs) {
    if (expr.accept?.includes(v)) return { result: "ok", x: null, groups: {} };
    if (expr.pattern) {
      const m = rx(expr.pattern).exec(v);
      if (m && m[0] === v) {
        const g = Object.fromEntries(Object.entries(m.groups ?? {}).filter(([, x]) => x));
        const x = (g.x ?? g.y ?? null)?.trim() ?? null;
        const sl = expr.slot;
        if (sl?.closed && sl.lexicon && x != null && !sl.lexicon.includes(x)) return { result: "form_only", x, groups: g };
        return { result: "ok", x, groups: g };
      }
    }
  }
  for (const v of vs) for (const p of expr.partial_patterns ?? []) { const m = rx(p).exec(v); if (m && m[0] === v) return { result: "partial", x: null, groups: {} }; }
  return { result: null, x: null, groups: {} };
}
const RANK = { ok: 3, form_only: 2, partial: 1 };

// ---------------- 교재 묶음 ----------------
let lib = null;
export async function loadLib() {
  if (lib) return lib;
  const idx = await fetch("lessons/index.json?v=0.8.8").then((r) => r.json());
  lib = { ...idx, byId: Object.fromEntries(idx.lessons.map((l) => [l.id, l])), cache: {} };
  return lib;
}
let upper = null;
/** 7단계 의견 과제·8~9단계 대화 주제(11/14 실장님: 모든 단계를 넣어 두기). */
export async function loadUpper() {
  if (upper) return upper;
  const [t, p] = await Promise.all([fetch("lessons/L7.json?v=0.8.8").then((r) => r.json()), fetch("lessons/L8L9.json?v=0.8.8").then((r) => r.json())]);
  upper = { tasks: t, topics: p, taskById: Object.fromEntries(t.tasks.map((x) => [x.id, x])), topicById: Object.fromEntries(Object.values(p.topics).flat().map((x) => [x.id, x])) };
  return upper;
}
async function loadLesson(id) {
  const l = await loadLib();
  if (!l.cache[id]) {
    const les = await fetch(`lessons/${id}.json?v=0.8.8`).then((r) => r.json());
    les.scene = les.scene.map((x) => ({ ...x, who: x.who === "tori" ? "tori" : les.partner }));   // 상대 줄은 상대 캐릭터 id(목소리)
    l.cache[id] = les;
  }
  return l.cache[id];
}

/** 이어 할 과: 기록이 없으면 첫 과, 마지막 과를 끝냈으면 그다음 과(마지막이면 그대로), 아니면 그 과. */
export function resumeId(store) {
  const list = lib?.lessons ?? []; if (!list.length) return null;
  const last = store.get("lessonLast", null);
  const i = last ? list.findIndex((l) => l.id === last.id) : -1;
  if (i < 0) return list[0].id;
  return last.done ? list[Math.min(i + 1, list.length - 1)].id : list[i].id;
}

// ---------------- 진행 ----------------
/**
 * 대화(Chat) 하나에 붙는 교재 관리자. ui: 화면에 그릴 교재 카드 상태(null이면 없음).
 * store: { get(k,d), set(k,v) } 이 기기 저장(완료 과·단계·다음 방문 떠올리기).
 */
export class LessonManager {
  constructor({ chat, player, speed = 1, store, onChange, toast }) {
    this.chat = chat; this.player = player; this.speed = speed; this.store = store; this.onChange = onChange; this.toast = toast;
    this.ui = null; this.active = false; this.offered = false; this.declined = false;
    this.silent = 0; this.learnerSaid = 0; this.recallTried = false;
    this.items = []; this.waiter = null; this.gen = 0; this.sayCache = new Map();
    chat.lessonHook = (t, itemId) => this.onLearner(t, itemId);
    chat.onLearnerText = (t) => this.observe(t);
    chat.onFriendDone = () => this.friendDone();
    chat.onSpeechStart = () => { this.silent = 0; clearTimeout(this.silenceTimer); };
    chat.onStopped = () => this.abort();
  }

  set(patch) { this.ui = patch === null ? null : { ...(this.ui ?? {}), ...patch }; this.onChange?.(); }
  log(kind, data = {}) { this.chat.log(kind, { ...data, lesson: this.lesson?.id ?? null }); }
  done() { return this.store.get("lessonDone", []); }
  /** 그림책처럼 이어 하기(11/14 실장님): 처음엔 1과, 다음엔 마지막으로 한 과에서. 그 과를 끝까지 했으면 다음 과. */
  resumeId() { return resumeId(this.store); }

  // ---------- 제안(도움 요청·긴 침묵 두 번·관련 화제, 대화당 한 번) ----------
  observe(t) {
    if (this.paused) { if (/\p{L}/u.test(t) && ++this.pauseTurns >= 5) this.dismiss(); return; }   // 멈춘 뒤 다른 이야기가 길어지면 카드를 치움
    if (this.active || !lib) return;
    if (/\p{L}/u.test(t)) { this.learnerSaid++; this.silent = 0; }
    if (this.offered || this.declined) return;
    const n = normalize(t);
    if (new RegExp(lib.help_request, "i").test(t)) return this.offer(this.resumeId(), "help");
    if (this.learnerSaid >= 3) {
      for (const l of lib.lessons) {
        if (this.done().includes(l.id)) continue;
        const c = lib.cache[l.id]; if (!c) continue;
        if (c.topics_en.some((k) => ` ${n} `.includes(` ${k} `))) return this.suggest(l.id);
      }
    }
  }
  friendDone() {
    if (this.active || this.paused) return;
    if (!this.recallTried) { this.recallTried = true; const r = this.store.get("lessonRecall", null); if (r && r.session !== this.chat.sessionId) return this.recall(r.id); }
    if (this.offered || this.declined) return;
    clearTimeout(this.silenceTimer);
    // 친구 말이 끝난 뒤 8초씩 두 번(약 16초) 아무 말이 없으면 제안. 학습자가 말을 시작하면 처음부터.
    const check = () => {
      if (this.active || this.offered || this.declined) return;
      if (this.chat.ui.speech || this.chat.resp || this.player.isPlaying) return;
      this.silent++;
      if (this.silent >= 2) return this.offer(this.resumeId(), "silence");
      this.silenceTimer = setTimeout(check, 8000);
    };
    this.silent = 0;
    this.silenceTimer = setTimeout(check, 8000);
  }
  async preload() { const l = await loadLib(); await Promise.all(l.lessons.map((x) => loadLesson(x.id).catch(() => null))); }

  async offer(id, why) {
    if (this.active || this.offered) return;
    this.offered = true; this.active = true; this.items = [];
    const g = ++this.gen; const conn = this.chat.connGen;
    const les = await loadLesson(id);
    if (!this.alive(g, conn)) return;   // 불러오는 사이 대화가 멈췄거나 바뀜(11/14 헤니 검토 3)
    this.lesson = les;
    this.chat.beginLessonHold();
    this.log("lesson_offer", { why });
    this.set({ phase: "offer", title: les.title_ko, offer: les.offer_ko, img: null });
    try {
      await this.speak("Want to try a short scene together?", g);   // 11/14 헤니 검토 11: 수업 느낌 덜하게
      const a = await this.wait(g, { kind: "offer" });
      if (a.type === "yes") { this.log("lesson_offer_answer", { a: "yes" }); return await this.run(les, g, "Great!"); }
      this.declined = true;
      this.log("lesson_offer_answer", { a: a.type });
      if (a.type === "other") return this.finish({ say: null, keepLast: true, g });
      await this.speak("Okay! Let’s keep talking.", g);
      this.finish({ say: null, g, note: "Note from the app: the learner said no to a short practice. Do not mention it. Keep talking about the same topic with one short, easy question." });
    } catch (e) { if (e !== STOP) throw e; }
  }

  /** ‘교재로 배우기’ 버튼(제안 없이 바로). */
  async startNow(id) {
    if (this.active) return;
    this.offered = true; this.active = true; this.items = [];
    const g = ++this.gen; const conn = this.chat.connGen;
    const les = await loadLesson(id);
    if (!this.alive(g, conn)) return;
    this.lesson = les;
    this.set({ phase: "starting", title: les.title_ko });
    await this.friendIdle();   // 친구 인사·대답을 문장 중간에 끊지 않는다
    if (!this.alive(g, conn)) return;
    this.chat.beginLessonHold();
    this.log("lesson_start", { via: "button" });
    try { await this.run(les, g, "Okay!"); } catch (e) { if (e !== STOP) throw e; }
  }
  /** 이 세대·이 연결의 수업이 아직 살아 있는지. 아니면 늦게 끝난 작업은 아무것도 바꾸지 않는다. */
  alive(g, conn) { return g === this.gen && this.active && conn === this.chat.connGen && !!this.chat.pc && !this.chat.closed; }

  // ---------- 본 진행 ----------
  async run(les, g, opener = "Okay!") {
    this.lesson = les; this.x = null; this.xRaw = null; this.results = {}; this.t0 = Date.now(); this.lastWhen = null; this.lastSay = ""; this.hard = false;
    const P = les.partner_name;
    const lines = les.scene.map((l) => ({ who: l.who === "tori" ? "Tori" : P, en: l.en, mine: false, st: "" }));
    this.store.set("lessonLast", { id: les.id, done: false, at: Date.now() });
    // 11/14 실장님: 바로 ‘Okay! Listen.’ 하면 어색함 → 친구처럼 오늘 할 표현을 먼저 말하고 시작
    // 11/14 실장님: 친구처럼 짧게 운을 떼고 바로 장면(말할 기회를 늘리려고 시작 말은 한 문장)
    const intro = `${opener} Let’s practice “${les.title_en}” together. Listen!`;
    this.set({ phase: "lesson", title: les.title_ko, step: "장면 듣기", img: les.img, lines, hint: null, blank: null, choices: null, role: false, notice: null, timeSkip: les.time_skip_before ?? null, ask: null, said: null });
    this.prefetch([[intro, "tori"], ...les.scene.map((l) => [l.en, l.who])], g);
    await this.speak(intro, g);
    // 1. 장면 듣기: 토리와 상대가 각자 목소리로
    for (let i = 0; i < lines.length; i++) { this.mark(i, "now"); await this.speak(les.scene[i].en, g, les.scene[i].who); this.mark(i, "done"); }
    // 2. 역할 맡아 읽기: 학습자를 상대 이름으로 부르지 않고 “○○ 역할을 해 볼래?” 묻고 기다린다
    const Pko = KO_NAME[les.partner] ?? P;
    this.set({ ask: { text: `${Pko} 역할을 맡아 읽어 볼래요?`, yes: "좋아요", no: "듣기만 할래요" } });
    await this.speak(`Can you be ${P}? You say ${P}’s lines.`, g);
    const be = await this.wait(g, { kind: "yesno" });
    this.set({ ask: null });
    if (be.type === "yes") {
      await this.readRound(les, g, "partner");
      this.set({ ask: { text: "이번엔 토리 역할도 해 볼래요? (선택)", yes: "해 볼래요", no: "넘어가기" } });
      await this.speak("Now can you be Tori?", g);
      const sw = await this.wait(g, { kind: "yesno" });
      this.set({ ask: null });
      if (sw.type === "yes") await this.readRound(les, g, "tori");
    }
    // 3. 내 이야기
    this.set({ step: "내 이야기", lines: null, notice: les.story_notice_ko, hint: null, blank: null });
    for (const t of les.story) await this.turn(les, t, g, "transfer");
    // 4. 토리에게 묻기
    this.set({ step: "토리에게 묻기", notice: null, hint: null, blank: null });
    for (const t of les.ask_me) await this.turn(les, t, g, "transfer");
    // 5. 다시 대화로
    await this.complete(g);
  }

  async readRound(les, g, learnerSide) {
    const P = les.partner_name;
    this.set({ step: learnerSide === "partner" ? `번갈아 읽기 · 나는 ${P}` : "역할 바꿔 읽기 · 나는 Tori",
      lines: les.scene.map((l) => ({ who: l.who === "tori" ? (learnerSide === "tori" ? "나" : "Tori") : (learnerSide === "partner" ? "나" : P), en: l.en, mine: (l.who === "tori") === (learnerSide === "tori"), st: "" })), said: null });
    await this.speak((les.scene[0].who === "tori") === (learnerSide === "tori") ? "Great! You start." : "Great! Listen first.", g);
    let praised = 0;
    for (let i = 0; i < les.scene.length; i++) {
      const l = les.scene[i]; const mine = (l.who === "tori") === (learnerSide === "tori");
      this.mark(i, "now");
      if (!mine) { await this.speak(l.en, g, l.who); this.mark(i, "done"); continue; }
      const chk = learnerSide === "partner" ? les.check.find((c) => c.line === i) : null;
      const expr = chk ? les.expressions.find((e) => e.id === chk.expression) : null;
      let tries = 0, res = null, help = false;
      for (;;) {
        const a = await this.wait(g, { kind: "read", line: l.en });
        if (a.type === "skip") { res = "skipped"; break; }
        this.set({ said: a.text });   // 들린 말을 보여 줘서 토리가 들었는지 알 수 있게
        const lineHit = chk && variants(normalize(a.text)).some((v) => chk.line_accept.includes(v));
        if (!lineHit && this.sensitive(a.text) && !this.sensitive(l.en)) { if (expr) this.record(expr.id, "skipped", "reading", false); return this.sensitiveFlow(g); }
        if (this.offTopic(a.text, l.en)) { await this.pause(a, g); this.mark(i, "now"); await this.speak("Your turn.", g); continue; }
        if (!chk) { res = "ok"; break; }
        const vs = variants(normalize(a.text));
        res = vs.some((v) => chk.line_accept.includes(v)) ? "ok" : judge(expr, a.text).result;
        if (res === "ok") break;
        if (++tries >= 2) {
          help = true;
          await this.speak(l.en, g, l.who === "tori" ? "tori" : les.partner);
          this.set({ said: null });
          const b = await this.wait(g, { kind: "read", line: l.en });
          res = b.type === "skip" ? "skipped" : "ok"; break;   // 같이 듣고 따라 하기는 시도 자체를 받아 줌
        }
        await this.speak(`Listen: “${l.en}”`, g);
        this.set({ said: null });
      }
      if (expr) this.record(expr.id, res, "reading", help || tries > 0 || this.helpUsed);
      this.mark(i, "done");
      if (res === "ok" && chk && praised++ % 2 === 0) await this.speak("Yes!", g);
    }
  }

  /** 내 이야기·토리에게 묻기의 한 차례. */
  async turn(les, t, g, kind) {
    if (t.only_if === "previous_default" && this.lastWhen !== "default") return;
    if (t.only_if === "previous_not_negative" && ["negative", "sensitive"].includes(this.lastWhen)) return;
    if (t.only_if === "asked_where" && !/where do you (work|study)/i.test(this.lastSay)) return;
    const hint = t.screen_hint_ko ? this.fill(t.screen_hint_ko) : null;
    // 4~6단계: 화면 힌트는 8초 뒤 또는 ‘힌트’를 눌렀을 때만(그 전에 답하면 힌트 없는 답으로 기록, 공통 transfer)
    this.set({ hint: les.hint_delay ? null : hint, pendingHint: les.hint_delay ? hint : null, blank: les.hint_delay ? null : t.screen_blank ?? null, pendingBlank: les.hint_delay ? t.screen_blank ?? null : null,
      role: !!t.role, said: null, choices: this.choicesFor(les, t), clock: t.clock ?? null, sub: t.screen_note_ko ?? null });
    if (t.en) await this.speak(this.fill(t.en), g);
    if (t.expect == null && !t.free_answer) { await sleep(250); return; }
    const exprs = [t.expect, ...(t.alt_expect ?? [])].map((id) => les.expressions.find((e) => e.id === id)).filter(Boolean);
    let tries = 0, retries = 0;
    const again = async (r) => (r === "retry" && retries++ < 2 ? "again" : r);
    for (;;) {
      const a = await this.wait(g, { kind: "answer", target: this.target(les, t, exprs[0]) });
      if (a.type === "skip") { if (exprs[0]) this.record(exprs[0].id, "skipped", kind, false); this.lastWhen = "skip"; return; }
      this.set({ said: a.text });
      if (this.sensitive(a.text)) { if (exprs[0]) this.record(exprs[0].id, "skipped", kind, false); return this.sensitiveFlow(g); }
      if (t.expect === "slot") { this.setSlot(les, a.text, null); this.lastWhen = "default"; return; }
      if (t.free_answer) { return this.reply(les, t, g, { text: a.text, result: null, matched: null }); }
      let best = { result: null }, bestExpr = exprs[0];
      for (const e of exprs) { const r = judge(e, a.text); if ((RANK[r.result] ?? 0) > (RANK[best.result] ?? 0)) { best = r; bestExpr = e; } }
      if (best.result === "ok" || best.result === "form_only") {
        if (best.x || bestExpr.slot || bestExpr.pattern?.includes("<x>")) this.setSlot(les, a.text, best.x);
        this.record(bestExpr.id, best.result, kind, tries > 0 || this.helpUsed);
        if (t.expect_slot && this.x && !new RegExp(`^(${t.expect_slot})$`).test(normalize(this.x))) {
          return this.reply(les, t, g, { text: a.text, result: best.result, matched: bestExpr.id, mismatch: true });
        }
        if (await again(await this.reply(les, t, g, { text: a.text, result: best.result, matched: bestExpr.id, groups: best.groups })) === "again") continue;
        return;
      }
      if (best.result === "partial") {
        const known = this.setSlot(les, a.text, null);
        this.record(bestExpr.id, "partial", kind, tries > 0 || this.helpUsed);
        if (t.model && known) await this.speak(`Okay! You can say, “${this.fill(t.model, true)}”`, g);
        return this.reply(les, t, g, { text: a.text, result: "partial", matched: bestExpr.id, unknown: !known });
      }
      // 거절(Sorry, I can’t.): 그 차례에 거절 분기가 있으면 대답으로 받아 줌(11/14 헤니 검토 9)
      if ((t.branches ?? []).some((b) => b.when === "declined") && NEGATIVE.test(normalize(a.text))) {
        this.record(exprs[0]?.id, "declined", kind, tries > 0 || this.helpUsed);
        return this.reply(les, t, g, { text: a.text, result: null, matched: null, declined: true });
      }
      // 정답과 상관없는 다른 이야기(질문·한국어 문장): 잠시 멈추고 평소 대화로(11/14 실장님)
      if (this.offTopic(a.text, this.target(les, t, exprs[0]))) {
        await this.pause(a, g);
        if (t.en) await this.speak(this.fill(t.en), g);
        continue;
      }
      // 판정 안 됨: 한 번 들려주고, 두 번째는 받아 주고 넘어감
      tries++;
      const target = this.target(les, t, exprs[0]);
      if (tries === 1) { this.useHelp(); this.set({ showHelp: true }); await this.speak(`Listen: “${target}”`, g); continue; }
      this.record(exprs[0]?.id, "tried", kind, true);
      await this.speak(`Good try! “${target}”`, g);
      return this.reply(les, t, g, { text: a.text, result: null, matched: null });
    }
  }

  /** 토리 다음 말(분기). */
  async reply(les, t, g, a) {
    const n = normalize(a.text);
    const x = this.x ? normalize(this.x) : "";
    const on = (w) => {
      if (w === "default") return true;
      if (w === "sensitive") return this.sensitive(a.text);
      if (w === "negative") return NEGATIVE.test(n) || NEGATIVE.test(a.text);
      if (w === "plural") return (les.plural_words ?? []).includes(x);
      if (w === "unknown_slot") return !!a.unknown;
      if (w === "declined") return !!a.declined;
      if (w === "slot_mismatch") return !!a.mismatch;
      const [k, v = ""] = w.split(":"); const opts = v.split("|");
      if (k === "matched") return opts.includes(a.matched);
      if (k === "matched_text") return opts.some((o) => ` ${n} `.includes(` ${o} `));
      if (k === "slot_in") return opts.includes(x);
      if (k === "slot_pair") { const gp = a.groups ?? {}; const s = new Set([normalize(gp.a ?? ""), normalize(gp.b ?? "")]); return opts.every((o) => s.has(o)); }
      return false;
    };
    const b = (t.branches ?? []).find((br) => on(br.when));
    this.lastWhen = b && (b.when === "negative" || b.when === "sensitive") ? b.when : (NEGATIVE.test(n) ? "negative" : "default");
    if (!b) return;
    if (b.say === "COMMON") return this.sensitiveFlow(g);
    const retry = b.say.startsWith("RETRY:");
    this.lastSay = this.fill(b.say.replace(/^RETRY:/, ""));
    await this.speak(this.lastSay, g);
    return retry ? "retry" : undefined;   // 다시 고르게(없는 색·바쁜 요일): 같은 차례를 한 번 더 기다림
  }

  async sensitiveFlow(g) {
    this.hard = true; this.lastWhen = "sensitive";
    this.log("lesson_sensitive", {});
    await this.speak("I’m sorry to hear that.", g);
    this.set({ ask: { text: "계속할까요, 그냥 이야기할까요?", yes: "계속하기", no: "그냥 대화하기" }, hint: null, blank: null });
    const a = await this.wait(g, { kind: "yesno" });
    this.set({ ask: null });
    if (a.type !== "yes") { this.finish({ say: "Okay.", reason: "sensitive", g }); throw STOP; }
  }

  // ---------- 7단계 의견 과제(공통 kinds.opinion_task, L7.json flow) ----------
  async startTask(id) {
    if (this.active) return;
    this.offered = true; this.active = true; this.items = [];
    const g = ++this.gen; const conn = this.chat.connGen;
    const up = await loadUpper(); const task = up.taskById[id];
    if (!task || !this.alive(g, conn)) { if (g === this.gen) this.active = false; return; }
    this.lesson = { id, title_ko: task.title_ko, title_en: task.claim_en, korean_map: {}, credit_ko: "bilody가 직접 만든 토론 주제예요." };
    this.results = {}; this.t0 = Date.now(); this.hard = false;
    this.set({ phase: "starting", title: task.title_ko });
    await this.friendIdle();
    if (!this.alive(g, conn)) return;
    this.chat.beginLessonHold();
    this.chat.privateTopic = true;   // 의견 연습은 기록·기억에 남기지 않음(헤니 검토·실장님 결정 3)
    this.log("task_start", { id });
    try { await this.runTask(task, g, up.tasks.markers); } catch (e) { if (e !== STOP) throw e; }
  }
  async runTask(task, g, markers) {
    const notice = `오늘의 질문: ${task.claim_ko}`;
    this.set({ phase: "lesson", title: task.title_ko, step: "7단계 · 의견 과제", img: null, lines: null, hint: null, blank: null, choices: null, role: false, notice, ask: null, said: null });
    await this.speak("Want to talk about this together? I can take the other side, or just chat.", g);
    this.set({ ask: { text: "어떻게 할까요?", opts: [{ v: "against", label: "토리가 반대편" }, { v: "same", label: "같은 편으로" }, { v: "chat", label: "그냥 이야기" }, { v: "no", label: "다음에" }] } });
    const c = await this.wait(g, { kind: "choice", opts: [{ v: "against", re: "other side|against|disagree with me|반대" }, { v: "same", re: "same side|with me|같은 편|같은편" }, { v: "chat", re: "just chat|just talk|그냥" }] });
    this.set({ ask: null });
    this.log("task_mode", { mode: c.v });
    if (c.v === "no") { await this.speak("Okay! Let’s keep talking.", g); return this.finish({ say: null, g, note: "Note from the app: the learner chose not to do a discussion task now. Keep talking about what you were talking about." }); }
    if (c.v === "chat") return this.finish({ say: null, g, note: `Note from the app: the learner wants to just chat about this question: "${task.claim_en}". Ask what they think in one short question, listen, and share a balanced view. Do not argue. Real or made-up examples are both fine. Their opinions here are practice, not facts about them.` });
    const used = new Set(); const words = [];
    const ask = async (label, hint) => {
      this.set({ step: `7단계 · ${label}`, hint, said: null });
      let a = await this.wait(g, { kind: "free" });
      if (a.type === "skip") return "";
      if (a.text.split(/\s+/).length <= 5) { await this.speak("Can you tell me a bit more?", g); const b = await this.wait(g, { kind: "free" }); if (b.type !== "skip") a = { text: `${a.text} ${b.text}` }; }
      this.set({ said: a.text });
      if (this.sensitive(a.text)) await this.sensitiveFlow(g);
      const n = normalize(a.text); words.push(n.split(" ").filter(Boolean).length);
      for (const [k, m] of Object.entries(markers)) if (m.patterns.some((p) => new RegExp(p).test(n))) used.add(k);
      return n;
    };
    await this.speak(`Today’s question: ${task.claim_en} What do you think?`, g);
    const first = await ask("내 생각과 이유", "도움 표현(선택): I partly agree, but… / The main reason is that…");
    const personal = /\b(allergic|allergy|allergies|cant afford|no money|my health|my doctor|small apartment|my landlord|my family needs)\b/.test(first);
    const disagree = /\b(disagree|dont agree|do not agree|not sure i agree|dont think so|i dont think|no way|not really)\b/.test(first);
    const partly = /\b(partly|partially|to some extent|kind of agree|sort of agree|depends)\b/.test(first);
    if (personal) {
      await this.speak("That makes sense. Thanks for sharing. What else do you think about it?", g);
    } else {
      // 반대편: 학습자와 다른 쪽 논거 / 같은 편: 학습자와 같은 쪽 논거. 일부 동의는 ‘동의’ 쪽으로 봄
      const learnerAgrees = !disagree || partly;
      const opposite = learnerAgrees ? task.counter_for_agree : task.counter_for_disagree;
      const sameSide = learnerAgrees ? task.counter_for_disagree : task.counter_for_agree;
      const line = c.v === "against" ? `I see. Here’s another way to look at it. ${opposite[0]}` : `I agree with you! Also, ${sameSide[0].replace(/^But /, "")}`;
      await this.speak(line, g);
    }
    await ask("토리 말에 답하기", "도움 표현(선택): I see your point, but… / For example, …");
    await this.speak("Good point. So what’s your final answer?", g);
    await ask("정리", "도움 표현(선택): Overall, I think… / It depends on…");
    const tipFor = [["example", "For example, …"], ["contrast", "I see your point, but …"], ["reason", "The main reason is that …"], ["conclusion", "Overall, I think …"]].find(([k]) => !used.has(k));
    this.log("task_result", { id: task.id, mode: c.v, markers: [...used], words, ms: Date.now() - this.t0 });
    const say = tipFor ? `Great talk! Next time, try “${tipFor[1]}”` : "Great talk! You explained your ideas really well.";
    return this.finish({ say, g, toast: "토론 연습은 기록·기억에 남기지 않았어요",
      note: `Note from the app: the learner just finished a short practice discussion about "${task.claim_en}". The opinions in it were practice and may not be their real views; do not treat them as facts about the learner. Go back to what you were talking about before, or ask one short, easy question.` });
  }

  // ---------- 8~9단계 대화 주제(교재 없음, 친구에게 주제와 대화 방식을 건넴) ----------
  async startTopic(id) {
    const up = await loadUpper(); const tp = up.topicById[id]; if (!tp || !this.chat.pc) return;
    const lv = id.slice(0, 2); const st = up.topics.style[lv]; const both = up.topics.style.both;
    this.chat.privateTopic = true;
    this.log("topic_start", { id });
    this.toast?.("이 주제 대화는 기록·기억에 남기지 않아요");
    this.chat.topicNote(`Note from the app: the learner chose a ${st.cefr}-level talk topic. For the rest of this call, follow these style notes: ${st.friend_style.join(" ")} ` +
      `Start now by saying once that real or made-up examples are both fine, then ask: "${tp.opener_en}". Possible follow-ups: ${tp.follow_ups_en.join(" / ")}. ` +
      "Never ask for real names, company names, amounts of money, or health details. Things the learner says while arguing a side or practicing a tone are practice, not their real beliefs.");
  }

  // ---------- 다음 방문 떠올리기 ----------
  async recall(id) {
    if (this.active) return;
    this.active = true; this.items = [];
    const g = ++this.gen; const conn = this.chat.connGen;
    const les = await loadLesson(id);
    if (!this.alive(g, conn)) return;
    this.lesson = les;
    this.chat.beginLessonHold();
    this.results = {}; this.t0 = Date.now();
    const expr = les.expressions.find((e) => e.id === les.recall.expect);
    this.set({ phase: "recall", title: les.title_ko, step: "지난번 표현 떠올리기", img: les.img, lines: null, hint: null, blank: null, notice: null, ask: null });
    const hintTimer = setTimeout(() => this.set({ hint: les.recall.hint_ko }), 6000);
    try {
      await this.speak(les.recall.voice, g);
      const a = await this.wait(g, { kind: "answer", target: expr.en });
      clearTimeout(hintTimer);
      if (a.type !== "skip" && this.sensitive(a.text)) { this.store.set("lessonRecall", null); return this.finish({ say: "I’m sorry to hear that.", reason: "sensitive", g }); }
      const r = a.type === "skip" ? { result: "skipped" } : judge(expr, a.text);
      const withHint = !!this.ui?.hint;
      this.log("lesson_recall", { result: r.result ?? "none", hint: withHint });
      this.store.set("lessonRecall", null);
      await this.speak(r.result === "ok" ? "Yes! Great memory." : `Good try! “${this.target(les, { screen_hint_ko: les.recall.hint_ko }, expr)}”`, g);
      this.finish({ say: null, note: "The learner just did a quick review of an expression. Continue the conversation naturally.", g });
    } catch (e) { clearTimeout(hintTimer); if (e !== STOP) throw e; }
  }

  // ---------- 끝내기 ----------
  complete(g) {
    const summary = Object.fromEntries(Object.entries(this.results).map(([k, v]) => [k, v]));
    this.log("lesson_result", { results: summary, ms: Date.now() - this.t0, hard: this.hard });
    const done = new Set(this.done()); done.add(this.lesson.id); this.store.set("lessonDone", [...done]);
    this.store.set("lessonLast", { id: this.lesson.id, done: true, at: Date.now() });
    this.store.set("lessonRecall", { id: this.lesson.id, session: this.chat.sessionId, at: Date.now() });
    return this.finish({ say: this.hard ? "Thanks for practicing. Let’s just talk." : "That was fun! Let’s keep talking.", toast: "오늘 익힌 표현을 기록에 남겼어요", g });
  }

  async finish({ say, toast, reason, keepLast = false, note, g }) {
    const gen = g ?? this.gen; const conn = this.chat.connGen;
    if (!this.alive(gen, conn)) return;
    if (say) { try { await this.speak(say, gen); } catch { /* 멈춤 */ } }
    if (!this.alive(gen, conn)) return;   // 말하는 사이 멈춤·다른 끝내기가 먼저 됨: 마이크·문맥을 건드리지 않음(11/14 헤니 검토 3)
    const items = keepLast ? this.items.slice(0, -1) : this.items;
    this.items = []; this.active = false; this.waiter = null; this.gen++;
    this.chat.setLessonMic(true);
    this.set(null);
    if (toast) this.toast?.(toast);
    const baseNote = reason === "sensitive"
      ? "Note from the app: the learner stopped a short practice after sharing something hard. Be gentle and kind. Do not mention the practice. Ask one soft, easy question or just listen."
      : note ?? "Note from the app: the learner just finished a short practice with you. Role-play names, cities and facts in the practice are not about the learner. Go back to the topic you were talking about before the practice and ask one short, easy question about it. If there was no topic yet, ask one easy question about something new. Do not ask how their day is going.";
    this.chat.endLessonHold({ deleteItems: items, note: keepLast ? null : baseNote, respond: true });
    if (reason) this.log("lesson_stop", { reason });
  }

  /** 대화가 멈추거나 끊김: 마지막으로 끝난 단계까지만 기록하고 닫는다(재접속 뒤 자동으로 다시 열지 않음). */
  abort() {
    clearTimeout(this.silenceTimer); clearTimeout(this.dismissTimer);
    if (!this.active) return;
    if (this.paused) { this.paused = false; const pw = this.pauseWaiter; this.pauseWaiter = null; pw?.reject(STOP); }
    this.log("lesson_stop", { reason: "call_stopped", results: this.results ?? {} });
    this.active = false; this.gen++; this.items = [];
    const w = this.waiter; this.waiter = null; if (w) w.reject(STOP);
    this.chat.lessonHold = false;
    this.set(null);
  }

  /** ‘그만하고 대화하기’ 또는 그만하자는 말. */
  stopByUser() {
    if (!this.active) return;
    const w = this.waiter; this.waiter = null;
    this.gen++; this.player.stop();
    if (w) w.reject(STOP);
    if (this.paused) { this.paused = false; const pw = this.pauseWaiter; this.pauseWaiter = null; pw?.reject(STOP); }
    this.log("lesson_stop", { reason: "user", results: this.results ?? {} });
    this.finish({ say: "Okay!", g: this.gen });
  }
  /** 위기 표현: 수업을 바로 닫고 그 말을 친구에게 그대로 넘긴다(지우지 않음). */
  crisis(text, itemId) {
    const w = this.waiter; this.waiter = null;
    this.gen++; this.player.stop(); if (w) w.reject(STOP);
    if (this.paused) { this.paused = false; const pw = this.pauseWaiter; this.pauseWaiter = null; pw?.reject(STOP); }
    const del = this.items.filter((id) => id !== itemId); this.items = [];
    this.active = false; this.waiter = null; this.gen++;
    this.log("lesson_stop", { reason: "safety" });
    this.set(null);
    this.chat.setLessonMic(true);
    this.chat.endLessonHold({ deleteItems: del, userText: itemId ? null : text, respond: true,
      note: "Note from the app: the practice was stopped because the learner may have said something about being in danger or hurting themselves. Follow your safety rules first. Be warm and calm. Do not mention the practice." });
  }

  /** 친구(대화 AI)의 인사·대답이 끝날 때까지 기다린다(최대 8초). 연결 중이면 연결·인사가 끝날 때까지. */
  async friendIdle() {
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const c = this.chat;
      if (c.greeted && c.pc && !c.resp && !this.player.isPlaying && !c.ui.speech) return;
      await sleep(150);
    }
  }
  /** 대화 화제와 맞는 과가 있을 때: 말로 끊지 않고 화면에 작은 제안만(30초 뒤 사라짐, 대화당 한 번). */
  suggest(id) {
    if (this.suggested || this.active || this.ui) return;
    this.suggested = true;
    const meta = lib.byId[id];
    this.log("lesson_suggest", { id });
    this.set({ phase: "suggest", title: meta.title_ko, suggestId: id });
    setTimeout(() => { if (this.ui?.phase === "suggest") this.set(null); }, 30000);
  }

  // ---------- 잠시 멈춤·이어 하기(11/14 실장님) ----------
  /** 정답과 상관없는 다른 이야기인지: 질문, 한국어 문장, 목표 문장과 거의 안 겹치는 긴 영어. 짧게 틀린 답은 아님. */
  offTopic(text, target) {
    // 11/14 헤니 검토 2: 겹치는 낱말이 적다는 것만으로는 다른 이야기로 보지 않는다(‘My name is Moa and I work in Busan’은 역할극 답).
    // 다른 이야기로 보는 것: 한국어 문장, 또는 질문·끼어들기 말로 시작하고 목표 문장과 거의 안 겹치는 말.
    const t = String(text ?? "").trim();
    const hangul = (t.match(/[가-힣]/g) ?? []).length;
    if (hangul >= 6 && !Object.keys(this.lesson?.korean_map ?? {}).some((k) => t.includes(k))) return true;
    const n = normalize(t); const w = n.split(" ").filter(Boolean);
    const tw = new Set(normalize(target ?? "").split(" "));
    const overlap = w.filter((x) => tw.has(x)).length / Math.max(1, w.length);
    const asks = /\?$/.test(t) || /^(what|why|how|where|when|who|which|can you|could you|do you|did you|are you|is it|is there|would you|tell me)\b/.test(n);
    const breaks = /^(by the way|wait|hold on|actually|excuse me|can i ask|let me ask|i have a question|one question)\b/.test(n);
    return (asks || breaks) && w.length >= 3 && overlap < 0.5;
  }
  /** 멈춤: 카드를 작게 접고, 방금 말은 평소 대화로 넘겨 친구가 대답하게 한다. 이어 하기 전까지 여기서 기다림. */
  async pause(a, g) {
    this.paused = true; this.pauseTurns = 1; this.savedUi = this.ui;
    this.items = this.items.filter((id) => id !== a.itemId);
    if (a.itemId) this.chat.lessonItems?.delete(a.itemId);   // 친구가 대답할 말이라 서버 문맥에는 남김
    this.chat.addLine("user", a.text);   // 화면에만. 수업 중에 한 말이라 기록(turns)·기억에는 넣지 않음(11/14 헤니 검토 2)
    const del = this.items; this.items = [];
    this.log("lesson_pause", {});
    this.set({ phase: "paused" });
    this.chat.endLessonHold({ deleteItems: del, respond: true, userText: a.itemId ? null : a.text,
      note: "Note from the app: the learner paused the expression practice to talk about something else. Reply naturally to what they just said. Do not mention the practice unless they ask. Role-play names and facts in the practice are not about the learner." });
    clearTimeout(this.dismissTimer);
    this.dismissTimer = setTimeout(() => this.dismiss(), 120000);   // 약 2분 지나면 카드를 치움
    await new Promise((resolve, reject) => { this.pauseWaiter = { resolve, reject }; });
    if (g !== this.gen) throw STOP;
    await this.speak("Okay! Where were we?", g);
  }
  /** 다른 이야기가 길어짐: 카드를 화면에서 치운다(‘표현 익히기’를 누르거나 다시 하자고 하면 돌아옴). */
  dismiss() {
    if (!this.paused || !this.ui) return;
    clearTimeout(this.dismissTimer);
    this.log("lesson_dismiss", { turns: this.pauseTurns });
    this.set(null);
  }
  resume() {
    if (!this.paused) return;
    clearTimeout(this.dismissTimer);
    this.paused = false;
    this.chat.beginLessonHold();
    this.log("lesson_resume", {});
    this.ui = this.savedUi; this.set({ said: null });
    const w = this.pauseWaiter; this.pauseWaiter = null; w?.resolve();
  }
  /** 멈춘 카드 닫기: 이번 표현 익히기를 끝낸다(대화는 그대로). */
  closePaused() {
    if (!this.paused) return;
    clearTimeout(this.dismissTimer);
    this.paused = false; this.active = false; this.gen++;
    const w = this.pauseWaiter; this.pauseWaiter = null; w?.reject(STOP);
    this.log("lesson_stop", { reason: "closed_while_paused", results: this.results ?? {} });
    this.set(null);
  }

  // ---------- 학습자 입력 ----------
  /** rt.js가 부름: 교재 중이면 true(기록하지 않고 여기서 처리). */
  onLearner(text, itemId) {
    if (!this.active) return false;
    if (this.paused) {
      if (RESUME.test(text) || RESUME.test(normalize(text))) { if (itemId) this.items.push(itemId); this.resume(); return true; }
      return false;   // 평소 대화로(기록·친구 대답)
    }
    if (CRISIS.test(text) || CRISIS.test(normalize(text))) { this.crisis(text, itemId); return true; }
    if (itemId) this.items.push(itemId);
    const n = normalize(text);
    if (this.wantsStop(n)) { this.stopByUser(); return true; }
    const w = this.waiter; if (!w) return true;
    if (w.spec.kind === "choice") {
      const hit = (w.spec.opts ?? []).find((o) => o.re && new RegExp(o.re, "i").test(n));
      if (hit) return this.resolve({ type: "opt", v: hit.v, text });
      if (lib.no.some((y) => n === normalize(y) || n.startsWith(normalize(y) + " "))) return this.resolve({ type: "opt", v: "no", text });
      if (lib.yes.some((y) => n === normalize(y) || n.startsWith(normalize(y) + " "))) return this.resolve({ type: "opt", v: w.spec.opts?.[0]?.v, text });
      return true;   // 못 알아들음: 버튼을 기다림
    }
    if (w.spec.kind === "offer" || w.spec.kind === "yesno") {
      const yes = lib.yes.some((y) => n === normalize(y) || n.startsWith(normalize(y) + " "));
      const no = lib.no.some((y) => n === normalize(y) || n.startsWith(normalize(y) + " "));
      if (yes && !no) return this.resolve({ type: "yes", text });
      if (no) return this.resolve({ type: "no", text });
      if (w.spec.kind === "offer") return this.resolve({ type: /\p{L}{2,}/u.test(text) ? "other" : "unclear", text });
      return this.resolve({ type: "no", text });
    }
    if (!/[\p{L}\p{N}]/u.test(text)) return true;   // 소리만(잡음): 기다림 계속
    return this.resolve({ type: "speech", text, itemId });
  }
  resolve(v) { const w = this.waiter; this.waiter = null; w?.resolve(v); return true; }
  /** 그만하자는 말: 그 말로 시작하거나 그 말뿐일 때만(‘Please do not stop’·‘I can’t stop laughing’은 아님). 11/14 헤니 검토 7 */
  wantsStop(n) {
    const w = n.split(" ").filter(Boolean);
    if (w.length > 6 || /\b(dont|do not|not|never|cant|cannot)\b/.test(n)) return false;
    return lib.stop.some((s) => { const k = normalize(s); return n === k || n.startsWith(k + " ") || n.endsWith(" " + k); });
  }

  button(act) {
    const w = this.waiter;
    if (act === "stop") return this.stopByUser();
    if (act === "resume") return this.resume();
    if (act === "close") return this.closePaused();
    if (act === "replay") { const t = this.ui?.lastTori; if (t && w) { this.useHelp(); this.speak(t, this.gen, this.ui?.lastWho ?? "tori", true).catch(() => {}); } return; }
    if (act === "suggestYes") { const id = this.ui?.suggestId; this.set(null); if (id) this.startNow(id); return; }
    if (act === "suggestNo") { this.set(null); this.log("lesson_suggest_answer", { a: "no" }); return; }
    if (!w) return;
    if (act.startsWith("opt:")) return this.resolve({ type: "opt", v: act.slice(4), text: "" });
    if (act === "yes" || act === "no") return this.resolve({ type: act, text: "" });
    if (act === "skip" || act === "next") return this.resolve({ type: "skip", text: "" });
    if (act === "hint") { this.useHelp(); return this.set({ showHelp: true }); }
  }

  wait(g, spec) {
    if (g !== this.gen) return Promise.reject(STOP);
    this.chat.setLessonMic(true);
    this.helpUsed = !!(this.ui?.hint && (spec.kind === "answer"));   // 처음부터 화면 힌트가 보이면 힌트를 본 답(guided)
    this.set({ waiting: spec.kind, showHelp: false });
    return new Promise((resolve, reject) => {
      const timers = [];
      // 기다림이 끝나면 곁말(다시 듣기·자동 힌트)도 멈춰 다음 말과 겹치지 않게(11/14 헤니 검토 6)
      const done = (fn) => (v) => { timers.forEach(clearTimeout); if (this.sidePlaying) this.player.stop(); this.set({ waiting: null }); fn(v); };
      this.waiter = { spec, resolve: done(resolve), reject: done(reject) };
      if (spec.kind === "answer" || spec.kind === "read") {
        timers.push(setTimeout(() => { if (this.waiter?.spec === spec) { this.useHelp(); this.set({ showHelp: true }); } }, 8000));
        timers.push(setTimeout(() => { if (this.waiter?.spec === spec && spec.target) { this.useHelp(); this.speak(`Listen: “${spec.target}”`, g, "tori", true).catch(() => {}); } }, 16000));
        timers.push(setTimeout(() => { if (this.waiter?.spec === spec) this.resolve({ type: "skip", text: "" }); }, 60000));
      }
      if (spec.kind === "free") timers.push(setTimeout(() => { if (this.waiter?.spec === spec) this.resolve({ type: "skip", text: "" }); }, 90000));
      if (spec.kind === "offer") timers.push(setTimeout(() => { if (this.waiter?.spec === spec) this.resolve({ type: "unclear", text: "" }); }, 20000));
    });
  }

  // ---------- 말하기 ----------
  /** 미리 만들기: [글, 누구] 목록. 목소리 서비스가 막히지 않게 한 번에 2개씩만(11/14 기록: 9개 동시 → 429). */
  prefetch(items, g = this.gen) { items.forEach(([t, who]) => this.audio(t, who, g).catch(() => {})); }
  audio(text, who = "tori", g = this.gen) {
    const key = `${who}|${text}`;
    if (!this.sayCache.has(key)) {
      // 차례를 기다리는 사이 수업이 멈췄으면 목소리를 만들지 않는다(11/14 헤니 검토 8)
      const p = this.slot(() => { if (g !== this.gen) throw STOP; return api.say(text, voiceOf(who), this.speed, this.chat.sessionId); }); p.catch(() => this.sayCache.delete(key));
      this.sayCache.set(key, p);
      if (this.sayCache.size > 80) this.sayCache.delete(this.sayCache.keys().next().value);
    }
    return this.sayCache.get(key);
  }
  async slot(fn) {
    this.busy = this.busy ?? 0; this.queue = this.queue ?? [];
    if (this.busy >= 2) await new Promise((r) => this.queue.push(r));
    this.busy++;
    try { return await fn(); } finally { this.busy--; this.queue.shift()?.(); }
  }
  /** side=true: 다시 듣기·자동 힌트(곁말). 주 진행 말이 나오면 곁말을 끊고, 주 말이 나오는 중이면 곁말은 하지 않는다. */
  async speak(text, g, who = "tori", side = false) {
    if (g !== this.gen) throw STOP;
    if (this.chat.limitReached) { this.chat.afterFriendFinished(); throw STOP; }   // 오늘 한도: 수업 중에도 바로 멈춤(헤니 검토 8)
    if (side && this.mainPlaying) return;
    if (!side && this.sidePlaying) this.player.stop();
    this.chat.setLessonMic(false);
    if (!side) this.set({ tori: text.replace(/[“”]/g, "\""), lastTori: text, lastWho: who, speaker: who });
    else this.set({ speaker: who });
    let s;
    try { s = await this.audio(text, who, g); } catch { if (g === this.gen && !side) { this.set({ notice: "목소리를 만들지 못했어요. 글로 보고 이어 가요." }); await sleep(1200); } }
    if (g !== this.gen) throw STOP;
    if (side && (this.mainPlaying || !this.waiter)) return;
    if (s) {
      this.chat.noteHeard(text);
      if (side) this.sidePlaying = true; else this.mainPlaying = true;
      try { await this.player.play(s.pcm, s.rate); } finally { if (side) this.sidePlaying = false; else this.mainPlaying = false; }
    }
    if (g !== this.gen) throw STOP;
    if (this.waiter) this.chat.setLessonMic(true);   // 기다리는 중에 들려준 도움말이면 마이크를 다시 연다
  }
  useHelp() {
    this.helpUsed = true;
    if (this.ui?.pendingHint || this.ui?.pendingBlank) this.set({ hint: this.ui.pendingHint ?? this.ui.hint, blank: this.ui.pendingBlank ?? this.ui.blank, pendingHint: null, pendingBlank: null });
  }

  // ---------- 도우미 ----------
  mark(i, st) { if (this.ui?.lines) this.set({ lines: this.ui.lines.map((l, j) => (j === i ? { ...l, st } : l.st === "now" ? { ...l, st: "done" } : l)) }); }
  record(id, result, step, help) {
    if (!id) return;
    const k = `${id}_${step}`; const prev = this.results[k];
    const order = { ok: 6, form_only: 5, partial: 4, declined: 3, tried: 2, skipped: 1 };
    if (!prev || (order[result] ?? 0) > (order[prev.r] ?? 0)) this.results[k] = { r: result, help };
  }
  sensitive(t) {
    // 11/14 헤니 확장 검토 7: 낱말 단위, 바로 앞 not·never·no면 아님(not sad), 일터로 쓴 hospital은 아님
    const raw = String(t); const n = ` ${normalize(raw).replace(/\b(work|works|worked|working|job|nurse|doctor) (at|in) (a |the )?hospital\b/g, "workplace")} `;
    return lib.sensitive.some((k) => {
      if (!/[a-z]/i.test(k)) return raw.includes(k);
      const m = new RegExp(`(^|\\s)(\\S+\\s)?${escRe(normalize(k))}(\\s|$)`).exec(n);
      if (!m) return false;
      return !/^(not|never|no|isnt|wasnt|arent|dont)\s$/.test(m[2] ?? "");
    });
  }
  /** 학습자 말에서 슬롯 단어를 정한다. 한국어 지도에 있으면 바꾸고, 모르는 한국어면 기본값을 몰래 쓰지 않는다. 반환: 알아낸 단어가 있는지. */
  setSlot(les, text, x) {
    const map = les.korean_map ?? {};
    const keys = Object.keys(map).sort((a, b) => b.length - a.length);
    const k = keys.find((key) => text.includes(key) || normalize(text).split(" ").includes(key.toLowerCase()));
    if (k) { this.x = map[k]; this.xRaw = k; return true; }
    if (x) { this.x = x; this.xRaw = null; return true; }
    if (/[가-힣]/.test(text)) { this.set({ notice: `영어 단어를 몰라도 괜찮아요. 장면 속 말(${les.fallback ?? "예시"})로 해 볼게요.` }); this.x = les.fallback; this.xRaw = null; return false; }
    const n = normalize(text).replace(/^(?:(?:my|the|a|an|its|it is|im|i am|i like|i can|i went to|i get up at|from)\s+)+/, "").replace(/\s+please$/, "");
    if (n && n.split(" ").length <= 3) { this.x = n; this.xRaw = null; return true; }
    return false;
  }
  fill(s, model = false) {
    let x = this.x ?? this.lesson?.fallback ?? "";
    const known = Object.values(this.lesson?.korean_map ?? {}).find((v) => v.toLowerCase() === x.toLowerCase());
    if (known) x = known;
    else if (this.lesson && ["L1-01", "L1-02"].includes(this.lesson.id)) x = x.replace(/(^|\s)(\p{L})/gu, (m, a, c) => a + c.toUpperCase());
    if (model && this.lesson?.plural_words?.includes(x)) s = s.replace("Where is my", "Where are my");
    if (model && this.lesson?.model_an && /^[aeiou]/i.test(x)) s = s.replace("I’m a ", "I’m an ");
    if (model && this.lesson?.id === "L2-03" && x === "walk") return "I walk.";
    return s.replaceAll("{x_ko}", this.xRaw ?? x).replaceAll("{x}", x);
  }
  target(les, t, expr) {
    if (t.model) return this.fill(t.model, true);
    const h = t.screen_hint_ko ?? "";
    const i = h.indexOf(":");
    if (i >= 0) {
      // 앞의 한국어 설명(‘역할극: 이번엔 …: ’, ‘지도: 쭉 가서 → ’)은 떼고 영어 문장만(파이썬 검사기와 같은 규칙)
      const eng = h.slice(i + 1).replace(/\([^)]*\)/g, "").split(/\s\/\s|아니면|안 되면/)[0].replace(/^[^A-Za-z]*/, "").trim();
      if (/[A-Za-z]/.test(eng) && !eng.includes("___")) return eng;
    }
    return (expr?.en ?? "").split(" / ")[0].replaceAll("___", this.x ?? les.fallback ?? "");
  }
  choicesFor(les, t) {
    const e = les.expressions.find((x) => x.id === t.expect);
    return e ? { blank: e.help.blank, choices: e.help.choices, ko: e.ko } : null;
  }
}

// ---------------- 교재 카드 그림(app.js가 씀) ----------------
// 11/14 실장님: 대사가 넘어갈 때마다 카드가 통통 튐 → 겉틀(제목·그림)은 한 번만 그리고 안쪽만 바꾼다.
/** 겉틀: 교재가 바뀌거나 제안→진행으로 넘어갈 때만 새로 그림. */
export function lessonShell(u, esc, I, enter) {
  if (u.phase === "suggest") return `<div class="card lesson paused ${enter ? "enter" : ""}"><div class="lesson-h"><span class="tag">표현 익히기</span><b class="grow">‘${esc(u.title)}’ 해 볼래요?</b>
    <button class="pill primary compact" data-act="lessonBtn" data-v="suggestYes">해 보기</button><button class="iconbtn sm" data-act="lessonBtn" data-v="suggestNo" aria-label="닫기">${I("close")}</button></div></div>`;
  if (u.phase === "starting") return `<div class="card lesson paused ${enter ? "enter" : ""}"><div class="lesson-h"><span class="tag">표현 익히기</span><b class="grow">${esc(u.title)} · 토리 말이 끝나면 시작해요</b></div></div>`;
  if (u.phase === "paused") return `<div class="card lesson paused ${enter ? "enter" : ""}"><div class="lesson-h"><span class="tag">표현 익히기</span><b class="grow">${esc(u.title)} · 잠시 멈춤</b>
    <button class="pill primary compact" data-act="lessonBtn" data-v="resume">이어 하기</button><button class="iconbtn sm" data-act="lessonBtn" data-v="close" aria-label="닫기">${I("close")}</button></div></div>`;
  return `<div class="card lesson ${u.phase} ${enter ? "enter" : ""}">
    <div class="lesson-h"><span class="tag">표현 익히기</span><b class="grow">${esc(u.title)}</b><span class="lesson-role"></span>
      <button class="iconbtn sm" data-act="lessonInfo" aria-label="출처">${I("info", "", true)}</button></div>
    <img class="lesson-img" alt="" hidden>
    <div class="lesson-body"></div></div>`;
}
/** 겉틀 안의 그림만 바꾼다(같은 그림이면 그대로 둬서 다시 불러오지 않음). */
export function lessonImage(root, u) {
  const img = root.querySelector(".lesson-img"); if (!img) return;
  const want = u.phase !== "offer" && u.img ? u.img : "";
  if (img.dataset.src !== want) { img.dataset.src = want; if (want) img.src = want; img.hidden = !want; }
  img.classList.toggle("small", !u.lines);
  const role = root.querySelector(".lesson-role"); const rk = u.role ? "1" : "";
  if (role && role.dataset.k !== rk) { role.dataset.k = rk; role.innerHTML = u.role ? `<span class="tag role">역할극</span>` : ""; }
}
/** 안쪽: 단계·대사·힌트·버튼. */
export function lessonBody(u, mic, esc, I, hearing = false) {
  if (u.phase === "offer") return `<p class="lesson-offer">${esc(u.offer)}</p>
      <div class="row gap"><button class="pill primary compact grow" data-act="lessonBtn" data-v="yes">좋아요</button><button class="pill secondary compact grow" data-act="lessonBtn" data-v="no">다음에</button></div>`;
  const lessonLines = (u.lines ?? []).map((l, i) => `${u.timeSkip === i ? `<div class="ln skip">· · · 잠시 뒤 · · ·</div>` : ""}
    <div class="ln ${l.mine ? "mine" : ""} ${l.st}"><span class="w">${esc(l.who)}</span><span>${esc(l.en)}</span></div>`).join("");
  const blank = u.blank ? `<div class="lesson-blank">${esc(u.blank).replace(/___/g, "<u>&nbsp;</u>")}</div>` : "";
  const help = u.showHelp && u.choices ? `<div class="lesson-help"><span class="muted tiny">${esc(u.choices.ko)}</span>
    ${u.blank ? "" : `<div class="lesson-blank small">${esc(u.choices.blank).replace(/___/g, "<u>&nbsp;</u>")}</div>`}
    <div class="lesson-chips">${u.choices.choices.map((c) => `<span>${esc(c)}</span>`).join("")}</div></div>` : "";
  return `<div class="lesson-step">${esc(u.step ?? "")}</div>
    ${u.clock ? `<div class="lesson-clock">${I("schedule")} ${esc(u.clock)}</div>` : ""}
    ${lessonLines ? `<div class="lesson-lines">${lessonLines}</div>` : ""}
    ${u.notice ? `<p class="lesson-notice">${esc(u.notice)}</p>` : ""}
    ${u.tori && !u.lines ? `<div class="lesson-tori"><b>Tori</b> ${esc(u.tori)}</div>` : ""}
    ${u.sub ? `<p class="muted tiny">${esc(u.sub)}</p>` : ""}
    ${u.hint ? `<div class="lesson-hint">${esc(u.hint)}</div>` : ""}
    ${blank}${help}
    ${u.said ? `<div class="lesson-said">나: ${esc(u.said)}</div>` : ""}
    ${u.ask ? `<div class="lesson-ask"><span>${esc(u.ask.text)}</span><div class="row gap wrap">${u.ask.opts ? u.ask.opts.map((o, i) => `<button class="pill ${i === 0 ? "primary" : "secondary"} compact grow" data-act="lessonBtn" data-v="opt:${o.v}">${esc(o.label)}</button>`).join("") : `<button class="pill primary compact grow" data-act="lessonBtn" data-v="yes">${esc(u.ask.yes)}</button><button class="pill secondary compact grow" data-act="lessonBtn" data-v="no">${esc(u.ask.no)}</button>`}</div></div>` : ""}
    <div class="lesson-foot"><span class="mic ${mic ? "on" : ""}">${hearing ? `${I("graphic_eq")}듣고 있어요…` : mic ? `${I("mic")}내 차례 · 말해 보세요` : `${I("volume_up")}${esc(SPEAKER[u.speaker] ?? "토리")} 말하는 중`}</span><span class="grow"></span>
      <button class="link tiny" data-act="lessonBtn" data-v="replay">${I("replay")}다시 듣기</button>
      ${u.waiting && !["offer", "yesno", "choice"].includes(u.waiting) ? `<button class="link tiny" data-act="lessonBtn" data-v="hint">힌트</button><button class="link tiny" data-act="lessonBtn" data-v="skip">건너뛰기</button>` : ""}</div>
    ${mic ? `<p class="muted tiny lesson-tip">시끄러우면 아래 칸에 글로 써도 돼요</p>` : ""}
    <button class="pill secondary compact lesson-stop" data-act="lessonBtn" data-v="stop">그만하고 대화하기</button>`;
}
const SPEAKER = { tori: "토리", moa: "모아", nubi: "누비", rino: "리노", sola: "솔라" };
