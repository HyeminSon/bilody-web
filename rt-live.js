// 11/21 실장님: GPT-Live 비교 시험판(live.html). 0.8.12 웹 앱의 수업·대화 흐름(rt.js의 Chat)을 그대로 쓰고,
// 말하는 엔진만 gpt-realtime(글 대답 + ElevenLabs 목소리) 대신 GPT-Live(선생님이 제 목소리로 바로 말함)로 바꾼다.
// 앱 쪽 진행(단계 넘기기, lesson-check 확인, 빠진 것 다시 시키기, 역할 읽기 한 줄씩, 장면 재생, 침묵 재촉)은 rt.js 그대로다.
// 바꾼 것만 여기 있다:
//  - 연결: gpt-live-session(서버)이 같은 지시문으로 GPT-Live 세션을 만들고 SDP answer를 돌려준다.
//  - 앱이 보내는 메모: system 메모 + response.create → session.instructions.append(지금 말하게), 대답을 청하지 않는 메모 → session.thinking.append(조용히 알기만).
//  - 차례 판단: GPT-Live는 ‘말 끝’ 신호가 없다. 선생님 말은 받아쓰기가 0.9초 멈추고 소리가 0.7초 조용하면 끝, 학습자 말은 받아쓰기가 1.2초 멈추면 끝으로 본다.
//  - 선생님 목소리는 GPT-Live 소리를 그대로 튼다(문장별 안전검사·한국어 거르기·군말 지우기는 할 수 없음: 이미 소리로 나간 뒤라서).
//  - 장면 재생 중에는 선생님 소리를 끄고 그동안 받아쓰기는 버린다.
import { Chat } from "./rt.js?v=0.8.15";
import * as api from "./api.js?v=0.8.11";
import { SUPABASE_URL, ANON_KEY } from "./config.js?v=0.8.11";
import { takeSentences } from "./text.js?v=0.8.11";

const FN = SUPABASE_URL + "/functions/v1/gpt-live-session";
const TEACHER_END_MS = 900, AUDIO_QUIET_MS = 700, LEARNER_END_MS = 1200, LEVEL = 0.012;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// GPT-Live 메모 한 번은 500토큰까지. 한글은 글자마다, 나머지는 4글자를 1토큰으로 어림해 420토큰씩 자른다.
const toks = (s) => (String(s).match(/[ㄱ-힣]/g)?.length ?? 0) + Math.ceil(String(s).replace(/[ㄱ-힣]/g, "").length / 4);
function chunks(text, max = 420) {
  const out = []; let buf = "";
  for (const line of String(text).split("\n")) {
    const next = buf ? buf + "\n" + line : line;
    if (toks(next) <= max) { buf = next; continue; }
    if (buf) out.push(buf);
    if (toks(line) <= max) { buf = line; continue; }
    // 한 줄이 너무 길면 문장 단위로
    buf = "";
    for (const s of line.split(/(?<=[.!?])\s+/)) { const n2 = buf ? buf + " " + s : s; if (toks(n2) <= max) buf = n2; else { if (buf) out.push(buf); buf = s.slice(0, max * 3); } }
  }
  if (buf) out.push(buf);
  return out;
}
// 11/21 시험: GPT-Live는 처음 지시문의 ‘권별 한국어 규칙’을 잘 따르지 않았다(Book 1인데 영어만). 그 자리에서 하라는 구체적 지시는 따른다.
// 그래서 앱 메모(말하게 하는 메모)마다 끝에 한 줄로 다시 알리고, 학습자가 말하기 시작할 때도 조용한 메모로 한 번 더 알린다(Book 1~4만).
const KO_NOW = (book) => book <= 2
  ? "Language for this beginner learner: whenever you explain, give an instruction, ask them to say or answer something, or check an answer, say it in one very short English sentence and then the same meaning in one short Korean sentence (해요체). Do this even when they answer in English. Small talk and quick praise stay in English."
  : book <= 4 ? "Language for this learner: when you explain a new meaning or grammar point or start a new kind of activity, add one short Korean sentence (해요체) right after the English. Otherwise speak simple English." : "";
export const liveVoiceFor = (teacher) => { try { return localStorage.getItem("bilody_live_voice_" + teacher) || null; } catch { return null; } };

async function freshToken() {
  // api.js가 토큰을 갱신·저장하게 한 번 부른 뒤(갱신 토큰을 두 곳에서 쓰지 않게) 저장된 토큰을 쓴다
  try { await api.rest("profiles?select=user_id&limit=1"); } catch { /* */ }
  let t = null; try { t = JSON.parse(localStorage.getItem("bilody_tokens") || "null"); } catch { /* */ }
  if (!t?.access_token) throw new api.ApiError("not_logged_in");
  return t.access_token;
}

export class LiveChat extends Chat {
  constructor(opts) {
    super(opts);
    this.notesBuf = []; this.speakWanted = false; this.flushQueued = false;
    this.tAcc = null; this.lAcc = ""; this.lastOutAt = 0; this.lastInAt = 0; this.lastAudioAt = 0; this.respN = 0;
    this.liveUsage = null; this.audioEl = null; this.analyser = null; this.ticker = null;
  }

  // ---------------- 연결 ----------------
  async connect(first) {
    const gen = ++this.connGen;
    const stale = () => this.closed || gen !== this.connGen;
    this.set({ state: "connecting", notice: null, canRestart: false });
    if (!this.story && first) this.player.jingle();
    const t0 = Date.now();
    let stream = null, pc = null;
    const abandon = () => { stream?.getTracks().forEach((t) => t.stop()); try { pc?.close(); } catch { /* */ } };
    try {
      if (!this.sessionId) this.sessionId = await api.startSession(this.presetId, (this.lesson ? "+lesson" : this.placement ? "+placement" : "") + "+live");
      if (stale()) return abandon();
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
      catch (e) { stream = null; this.set({ notice: "마이크를 쓸 수 없어요. 브라우저에서 마이크를 허용해 주세요." }); }
      if (stale()) return abandon();
      this.stream = stream;
      pc = new RTCPeerConnection(); this.pc = pc;
      // GPT-Live는 들어오는 소리(RTP)가 끊기면 지시를 처리하지 않고 30초 뒤 세션을 닫는다(11/21 시험: 소리 없는 트랙은 패킷 0개).
      // 그래서 마이크를 끄지 않고 웹 오디오로 소리 크기만 0으로 줄이고, 들리지 않을 만큼 작은 잡음을 늘 함께 보낸다.
      this.addSendTrack(pc, stream);
      pc.ontrack = (e) => this.attachAudio(e.streams[0]);
      pc.onconnectionstatechange = () => { if (["failed", "disconnected"].includes(pc.connectionState) && this.pc === pc) this.lost(); };
      const dc = pc.createDataChannel("oai-events"); this.dc = dc;
      dc.onopen = () => { this.startTicker(); this.requestGreeting(); };
      dc.onmessage = (m) => { try { this.onEvent(JSON.parse(m.data)); } catch { /* 깨진 메시지 무시 */ } };
      this.greeted = false;
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      await new Promise((ok) => { if (pc.iceGatheringState === "complete") ok(); else { pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && ok(); setTimeout(ok, 3000); } });
      if (stale()) return abandon();
      const res = await fetch(FN, {
        method: "POST", headers: { Authorization: "Bearer " + await freshToken(), apikey: ANON_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          presetId: this.presetId, speed: this.speed, sdp: pc.localDescription.sdp, liveVoice: liveVoiceFor(this.character ?? "grace"),
          features: ["picture", "word", ...(this.lesson?.info && !/^K\d/.test(String(this.lesson.info.id ?? "")) ? ["lesson_app_led", "lesson_role_app", ...(/^MY-/.test(String(this.lesson.info.id ?? "")) ? ["study_way"] : [])] : [])],
          ...(this.character ? { character: this.character } : {}), ...(this.lesson ? { mode: "lesson", lesson: this.lesson.info } : this.placement ? { mode: "placement" } : {}), sessionId: this.sessionId,
        }),
      });
      const key = await res.json().catch(() => ({}));
      if (stale()) return abandon();
      if (!res.ok || !key.sdp) throw new api.ApiError(key.error || `live_${res.status}`, res.status);
      if (this.placement && !this.plStart) this.plStart = Date.now();
      this.appLed = !!this.lesson && key.appLed === true;
      this.todayCtx = key.hasTodayContext === true;
      this.liveVoice = key.liveVoice;
      this.updateRemaining(key.todaySeconds, key.limitSeconds);
      await pc.setRemoteDescription({ type: "answer", sdp: key.sdp });
      if (stale()) return abandon();
      this.log("rt_connected", { connect_ms: Date.now() - t0, first, mic: !!this.stream, live: true, voice: key.liveVoice, live_session: key.liveSession });
      if (!this.story) this.startMeter();
    } catch (e) {
      if (stale()) return abandon();
      this.teardown();
      const code = e?.code ?? e?.name ?? "error";
      const msg = { daily_limit: "오늘 대화 시간을 모두 썼어요. 자정이 지나면 다시 이야기할 수 있어요.", forbidden: "GPT-Live 시험판은 운영자 계정만 쓸 수 있어요." }[code]
        ?? `GPT-Live 연결에 실패했어요. 다시 시작을 눌러 주세요. (${code})`;
      this.set({ state: code === "daily_limit" ? "stopped" : "disconnected", micOn: false, canRestart: code !== "daily_limit", notice: msg });
      this.log("rt_connect_failed", { code, live: true });
    }
  }

  addSendTrack(pc, stream) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = this.player.ctx ?? (this.sendCtx ??= new AC());
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    const dest = ctx.createMediaStreamDestination();
    const nb = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.0005;
    const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true; noise.connect(dest); noise.start();
    let gain = null;
    if (stream) { const src = ctx.createMediaStreamSource(stream); gain = ctx.createGain(); gain.gain.value = 0; src.connect(gain); gain.connect(dest); }
    this.liveSend = { noise, dest, gain, track: dest.stream.getAudioTracks()[0] };
    pc.addTrack(this.liveSend.track, dest.stream);
    // rt.js는 track.enabled로 마이크를 켜고 끈다 → 소리 크기(0/1)로 바꿔 준다
    this.track = gain ? { on: false, get enabled() { return this.on; }, set enabled(v) { this.on = !!v; gain.gain.setTargetAtTime(v ? 1 : 0, ctx.currentTime, 0.02); }, stop() {} } : null;
  }

  attachAudio(stream) {
    if (!this.audioEl) { this.audioEl = document.createElement("audio"); this.audioEl.autoplay = true; this.audioEl.style.display = "none"; document.body.appendChild(this.audioEl); }
    this.audioEl.srcObject = stream; this.audioEl.muted = !!this.ui.lessonScene; this.audioEl.volume = Math.min(1, this.player.volume ?? 1);
    this.audioEl.play?.().catch(() => {});
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.levelCtx = this.player.ctx ?? (this.levelCtx ?? new AC());
      if (this.levelCtx.state === "suspended") this.levelCtx.resume().catch(() => {});
      const src = this.levelCtx.createMediaStreamSource(stream);
      this.analyser = this.levelCtx.createAnalyser(); this.analyser.fftSize = 512; src.connect(this.analyser);
      this.levelBuf = new Float32Array(this.analyser.fftSize);
    } catch { this.analyser = null; }
  }
  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.levelBuf); let s = 0;
    for (const v of this.levelBuf) s += v * v;
    return Math.sqrt(s / this.levelBuf.length);
  }

  startTicker() {
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick(), 150);
  }
  tick() {
    if (this.closed || !this.pc) return;
    const now = Date.now();
    if (this.audioEl) this.audioEl.muted = !!this.ui.lessonScene;   // 장면 재생 중에는 선생님 소리를 끈다
    if (this.level() > LEVEL) this.lastAudioAt = now;
    // 선생님 말 끝
    if (this.resp?.live && now - this.lastOutAt > TEACHER_END_MS && now - this.lastAudioAt > AUDIO_QUIET_MS) this.endTeacher();
    // 학습자 말 끝
    if (this.lAcc && now - this.lastInAt > LEARNER_END_MS) this.endLearner();
  }

  // ---------------- 앱 → 선생님(메모 바꾸기) ----------------
  raw(obj) { const d = this.dc; if (!d || d.readyState !== "open") return false; try { d.send(JSON.stringify(obj)); return true; } catch { return false; } }
  send(obj) {
    const d = this.dc; if (!d || d.readyState !== "open") return false;
    const t = obj?.type;
    if (t === "conversation.item.create") {
      const it = obj.item ?? {};
      const text = (it.content ?? []).map((c) => c.text ?? "").join(" ").trim();
      if (it.type === "message" && it.role === "system" && text) { this.notesBuf.push(text); this.queueFlush(); }
      else if (it.type === "message" && it.role === "user" && text) { this.notesBuf.push(`(The learner typed this instead of speaking: ${text})`); this.queueFlush(); }
      // 도구 결과(사진·글 카드·찾아보기·단어 표시)는 위임받은 도우미 모델에게 돌려주고 이어서 하게 한다(도우미가 선생님에게 결과를 알림)
      if (it.type === "function_call_output") {
        this.raw({ type: "response.item.create", item: { type: "function_call_output", call_id: it.call_id, output: String(it.output ?? "{}") } });
        this.raw({ type: "response.create" });
        this.swallowCreate = true; queueMicrotask(() => { this.swallowCreate = false; });
      }
      return true;   // assistant 고치기는 GPT-Live에 없음
    }
    if (t === "response.create") { if (this.swallowCreate) return true; this.speakWanted = true; this.queueFlush(); return true; }
    if (t === "response.cancel" || t === "conversation.item.delete" || t === "session.update") return true;
    return this.raw(obj);
  }
  queueFlush() { if (this.flushQueued) return; this.flushQueued = true; queueMicrotask(() => { this.flushQueued = false; this.flushNotes(); }); }
  flushNotes() {
    const notes = this.notesBuf.splice(0), speak = this.speakWanted; this.speakWanted = false;
    if (!notes.length && !speak) return;
    const text = notes.length ? notes.join("\n\n") : "It is your turn to speak now. Continue naturally, following your instructions and the latest notes.";
    const ko = this.lesson ? KO_NOW(Number(this.lesson.info?.book ?? 9)) : "";
    const parts = chunks(text);
    if (!speak) { parts.forEach((p) => this.raw({ type: "session.thinking.append", content: p, delegation_id: null })); this.log("live_note", { speak: false, n: parts.length }); return; }
    if (parts.length === 1 && toks(parts[0] + ko) <= 480) this.raw({ type: "session.instructions.append", content: parts[0] + (ko ? "\n" + ko : ""), delegation_id: null });
    else {
      parts.forEach((p, k) => this.raw({ type: "session.thinking.append", content: `App note, part ${k + 1} of ${parts.length}:\n${p}`, delegation_id: null }));
      this.raw({ type: "session.instructions.append", content: "Now do what the app note you just received says, in your own natural words. Never read the note aloud." + (ko ? " " + ko : ""), delegation_id: null });
    }
    this.lastAskAt = Date.now();
    this.log("live_note", { speak: true, n: parts.length });
  }

  // ---------------- GPT-Live → 앱(차례 만들기) ----------------
  onEvent(ev) {
    if (this.closed) return;
    switch (ev.type) {
      case "session.input_transcript.delta": this.learnerDelta(String(ev.delta ?? "")); break;
      case "session.output_transcript.delta": this.teacherDelta(String(ev.delta ?? "")); break;
      case "response.event": this.delegated(ev); break;
      case "session.usage.updated": this.liveUsage = ev.usage ?? this.liveUsage; break;
      case "session.closed": this.liveUsage = ev.usage ?? this.liveUsage; if (this.pc && !this.closed) this.lost(); break;
      case "error": this.log("rt_error", { code: ev.error?.code ?? "error", msg: String(ev.error?.message ?? "").slice(0, 160), live: true }); break;
      default:
        // 11/21 실장님 시험: 사진을 말해 놓고 안 띄움 → 맡긴 일(위임)이 어떻게 됐는지 기록한다
        if (/^session\.delegation\./.test(ev.type)) this.log("live_delegation", { type: ev.type.split(".").pop(), id: ev.delegation?.id ?? ev.delegation_id ?? null });
        break;
    }
  }

  /** 11/21: 선생님이 도우미에게 맡긴 일(사진·글 카드·찾아보기·단어 표시). 도우미가 도구를 부르면 지금 앱과 같은 코드(runTool·runLessonTool)로 실행한다. */
  delegated(ev) {
    const e = ev.event ?? {};
    if (e.type === "response.output_item.done" && e.item?.type === "function_call") {
      const c = { callId: e.item.call_id, name: e.item.name, args: e.item.arguments ?? "{}", at: Date.now(), r: this.resp, withText: true };
      this.log("live_tool", { name: c.name, args: String(c.args).slice(0, 120) });
      if (this.lesson && ["highlight_word", "highlight_line", "change_study_way"].includes(c.name)) this.runLessonTool(c);
      else this.runTool(c);
    } else if (e.type === "response.completed") this.log("live_deleg_done", { id: ev.delegation_id ?? null });
    else if (e.type === "error" || e.type === "response.failed") this.log("live_tool_error", { type: e.type, msg: String(e.error?.message ?? e.response?.error?.message ?? "").slice(0, 160) });
  }

  learnerDelta(d) {
    if (!d) return;
    if (this.ui.lessonScene) return;   // 장면 중(마이크 꺼짐)에 들어온 것은 버린다
    const now = Date.now();
    if (!this.lAcc) {
      this.startedWhileTeacher = !!this.resp || now - this.lastAudioAt < 400;   // 11/22: 앱과 같게 반향 거르기
      this.lastSpeechStart = now; clearTimeout(this.idleTimer); clearTimeout(this.quietTimer); this.onSpeechStart?.();
      const ko = this.lesson ? KO_NOW(Number(this.lesson.info?.book ?? 9)) : "";
      if (ko && this.lessonStep >= 0) this.raw({ type: "session.thinking.append", content: "Reminder for your next reply. " + ko, delegation_id: null });
      this.set({ state: "listening", speech: true });
    }
    this.lAcc += d; this.lastInAt = now;
  }
  endLearner() {
    const t = this.lAcc.replace(/\s+/g, " ").trim(); this.lAcc = "";
    this.tSpeechStopped = Date.now();
    this.set({ speech: false, ...(this.resp ? {} : { state: "thinking" }) });
    if (!t) return;
    // 11/22(앱 LiveController와 같음): 선생님 목소리가 스피커에서 마이크로 되돌아와 받아쓰기된 것은 학습자 말로 남기지 않는다
    if (this.startedWhileTeacher && this.looksLikeEcho(t)) { this.log("rt_echo", { words: t.split(" ").length, live: true }); return; }
    // rt.js가 받아쓰기 완료를 처리하는 길을 그대로 탄다(기록·자막·단계 확인·역할 읽기 판정)
    super.onEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: t });
    // 11/21 실장님 시험: 학습자가 말을 마쳤는데 선생님이 27초 넘게 아무 말도 안 함 → 7초 동안 조용하면 대답하라고 알린다(한 번)
    clearTimeout(this.stallTimer);
    const at = Date.now();
    this.stallTimer = setTimeout(() => {
      if (this.closed || !this.pc || this.lastOutAt > at || this.resp || this.lAcc || this.ui.lessonScene) return;
      this.log("live_stall", { waited_ms: Date.now() - at });
      this.raw({ type: "session.instructions.append", content: "The learner has finished speaking and is waiting for you. Reply to what they just said now, in your own words.", delegation_id: null });
    }, 7000);
  }

  teacherDelta(d) {
    if (!d) return;
    if (this.ui.lessonScene) { this.log("live_talk_in_scene", { len: d.length }); return; }
    const now = Date.now(); this.lastOutAt = now; this.lastAudioAt = Math.max(this.lastAudioAt, now);
    let r = this.resp;
    if (!r || !r.live) {
      if (r) this.finishReply(r, false);
      clearTimeout(this.idleTimer); clearTimeout(this.quietTimer);
      this.epoch++;
      r = this.resp = { id: "live" + (++this.respN), epoch: this.epoch, text: "", pending: "", done: false, played: [], chain: Promise.resolve(), itemId: null, first: true, hadText: false, live: true, startedAt: now };
      const lat = this.tSpeechStopped ? now - this.tSpeechStopped : null;
      this.set({ state: "speaking", lastLatencyMs: lat ?? this.ui.lastLatencyMs, notice: null });
      this.log("turn", { speech_stop_to_first_audio_ms: lat ?? -1, live: true });
      this.tSpeechStopped = 0;
    }
    r.text += d; if (d.trim()) r.hadText = true;
    const cut = takeSentences(r.pending + d, false); r.pending = cut.rest;
    cut.sentences.forEach((s) => this.showSentence(r, s));
  }
  showSentence(r, s) {
    if (!s.trim()) return;
    // 학습자 말이 아직 열려 있는데 선생님이 제대로 대답하기 시작했으면(맞장구가 아니면) 학습자 말을 먼저 닫아 순서를 맞춘다
    if (r.first && this.lAcc && (s.trim().split(/\s+/).length >= 3 || /\?/.test(s))) this.endLearner();
    if (r.first) { r.first = false; this.addLine("assistant", s, true); } else this.appendAssistant(s);
    r.played.push(s);
    this.recentFriend = (this.recentFriend + " " + s).slice(-400);
    if (this.lesson && this.appLed && this.rp?.step === this.lessonStep) this.rpSpeakHi(s, r);
  }
  endTeacher() {
    const r = this.resp; if (!r?.live || r.done) return;
    takeSentences(r.pending, true).sentences.forEach((s) => this.showSentence(r, s));
    r.pending = ""; r.done = true;
    // 학습자가 말하는 사이에 끼어든 짧은 맞장구(Mm., Right.)는 대답으로 치지 않는다
    if (this.lAcc && r.text.trim().split(/\s+/).length <= 2 && !/\?/.test(r.text)) {
      this.epoch++; this.resp = null; this.log("live_backchannel", { text: r.text.slice(0, 40) });
      const lines = [...this.ui.lines]; const k = lines.map((l) => l.role === "assistant" && l.pending).lastIndexOf(true);
      if (k !== -1) { lines.splice(k, 1); this.set({ lines }); }   // 화면 자막에서도 맞장구는 뺀다
      return;
    }
    this.lessonPrecheck(r);
    this.onReplyPlayed(r);
  }

  /** 끼어들기·넘기기: GPT-Live 말을 앱이 멈출 수는 없다. 지금까지 나온 말만 기록하고 다음 말은 새 대답으로 받는다. */
  interruptReply() {
    const r = this.resp; if (!r) return;
    this.epoch++; this.player.stop();
    if (r.live) { takeSentences(r.pending, true).sentences.forEach((s) => this.showSentence(r, s)); r.pending = ""; r.done = true; }
    this.finishReply(r, !r.live);
    this.resp = null;
    this.log("rt_barge_in", { live: true });
  }

  slowAgain() {
    if (!this.lesson || this.closed || !this.pc || this.ui.lessonScene || this.ui.lessonDone) return;
    this.interruptReply();
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: "(App: the learner tapped the slowly-again button. Say your last sentence again, word for word, slowly and clearly, and add nothing else.)" }] } });
    this.send({ type: "response.create" }); this.set({ state: "thinking" });
    this.log("lesson_slow", { step: this.lessonStep });
  }

  setVolume(v) { if (this.audioEl) this.audioEl.volume = Math.min(1, v); }

  teardown() {
    clearInterval(this.ticker); this.ticker = null; clearTimeout(this.stallTimer);
    if (this.dc?.readyState === "open") this.raw({ type: "session.close" });
    if (this.liveUsage) this.log("live_usage", { ...this.liveUsage, voice: this.liveVoice ?? null });
    if (this.audioEl) { try { this.audioEl.srcObject = null; } catch { /* */ } }
    this.analyser = null; this.lAcc = "";
    if (this.liveSend) { try { this.liveSend.noise.stop(); this.liveSend.gain?.disconnect(); this.liveSend.track.stop(); } catch { /* */ } this.liveSend = null; }
    super.teardown();
  }
}
