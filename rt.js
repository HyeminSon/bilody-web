// 실시간 대화(안드로이드 RealtimeController의 웹판, A3: 글 대답 → 문장마다 안전검사 + 캐릭터 목소리).
// 친구는 글로 대답하고, 문장이 끝날 때마다 tts-say로 소리를 만들어 차례로 들려준다.
// 끝까지 들려준 문장만 기록하고(REQ-OPS-013), 사용자가 말을 시작하면 친구가 멈춘다.
import * as api from "./api.js?v=0.8.6";
import { PRESET } from "./config.js?v=0.8.6";
import { takeSentences, decideCard, confused, wantsText, lastQuote, hasPracticeQuote } from "./text.js?v=0.8.6";
import { sceneVoice } from "./characters.js?v=0.8.6";
import { applyMyPlan, MY_READY, MY_FAILED, MY_STILL } from "./lesson09.js?v=0.8.6";

const PHOTO_HINT = "(The learner is showing you this photo. In simple English, say what the main thing is, teach one or two useful English words for it, then ask one short, easy question about it. " +
  "If you are not sure, say so honestly and guess kindly. If it shows a person, do not comment on their looks and do not guess who they are.)";

export class Chat {
  /**
   * story: 동화 듣기 중 대화(앱과 같음, 11/13). { onSpeechStart, onReplyDone, onNoise, onCue(pic), isNarrating(), pictureFor(word) }
   * 동화 모드에서는 인사·도움 카드·기록 저장·쉬는 시간 멈춤이 없고, 이용 시간은 동화 쪽이 잰다.
   */
  constructor({ voiceId, speed, saveTranscripts, player, onChange, presetId = PRESET, sessionId = null, story = null, character = null, lesson = null, placement = false }) {
    this.voiceId = voiceId; this.speed = speed; this.saveTranscripts = saveTranscripts;
    // 0.9 1:1 수업: lesson = lesson09.js의 run(교재 한 회차). character = 대화 상대(선생님이면 선생님 말투)
    this.character = character; this.lesson = lesson; this.lessonStep = -1; this.lessonSaid = 0;
    // 0.8.4 처음 이야기(레벨 확인): 선생님과 짧게 이야기하고, 끝내는 때는 앱이 정한다(placementDone). 끝나면 onPlacementDone(오간 말)
    this.placement = !!placement; this.plLog = []; this.plStart = 0; this.plWrap = null; this.plWrapRid = null;
    // 0.9.12: 어른 수업은 앱이 넘기기를 맡는다(선생님에게 next_step을 주지 않음, 서버에 lesson_app_led로 알림). 어린이 수업은 그대로.
    this.appLed = false;   // 서버가 받아들였을 때(key.appLed)만 켠다

    this.player = player; this.onChange = onChange; this.presetId = presetId; this.story = story;
    this.connGen = 0;
    this.ui = { state: "idle", micOn: false, lines: [], card: null, notice: null, remainingMinutes: null, lastLatencyMs: null, canRestart: false, speech: false, photo: null,
      lessonStep: -1, lessonHiLine: -1, lessonHiWord: null, lessonScene: false, lessonDone: null };
    this.sessionId = sessionId; this.seq = 0; this.closed = false;
    this.pc = null; this.dc = null; this.stream = null; this.track = null;
    this.epoch = 0; this.resp = null; this.greeted = false;
    this.recentFriend = ""; this.practiceTarget = null; this.helpWanted = false;
    this.soft = false; this.softHeld = false; this.ignoredResp = null; this.ignoreUntil = 0;
    this.tSpeechStopped = 0; this.lastSpeechStart = 0; this.startedDuringPlayback = false;
    this.maxMsg = 65536; this.limitReached = false; this.cameraHold = false;
    this.slots = 0; this.waiters = []; this.sceneGen = 0; this.lessonGen = 0;
    this.stepLog = []; this.quietCount = 0; this.sceneIntro = null; this.quietMs = 12000;   // 0.8.2 수업: 이 부분에서 오간 말, 침묵 횟수, 장면 앞 이어 주는 말
    this.lessonItems = new Map(); this.holdSeq = 0; this.lessonMicOn = false;   // 말 id → 그 말을 시작한 수업 번호(수업 밖이면 -1)
  }

  set(patch) { Object.assign(this.ui, patch); this.onChange?.(this.ui); }
  log(kind, data = {}) { api.logEvent(this.sessionId, kind, { ...data, web: true }); }

  // ---------------- 연결 ----------------
  async start() { await this.connect(true); }
  async restart() { if (!this.closed) { this.set({ notice: null, canRestart: false }); await this.connect(false); } }

  async connect(first) {
    // 11/13 헨니 검토: 연결 중에 화면을 나가면(멈춤·닫기) 늦게 끝난 연결이 마이크를 다시 켜던 문제 → 연결마다 번호를 붙여, 그사이 멈췄으면 잡은 것을 모두 놓고 끝낸다
    const gen = ++this.connGen;
    const stale = () => this.closed || gen !== this.connGen;
    this.set({ state: "connecting", notice: null, canRestart: false });
    if (!this.story) this.player.jingle();
    const t0 = Date.now();
    let stream = null, pc = null;
    const abandon = () => { stream?.getTracks().forEach((t) => t.stop()); try { pc?.close(); } catch { /* */ } };
    try {
      if (!this.sessionId) this.sessionId = await api.startSession(this.presetId, this.lesson ? "+lesson" : this.placement ? "+placement" : "");
      if (stale()) return abandon();
      const key = await api.realtimeKey(this.presetId, this.speed, this.character, this.lesson?.info ?? null, this.sessionId, this.placement ? "placement" : null);
      if (this.placement && !this.plStart) this.plStart = Date.now();
      if (stale()) return abandon();
      if (key.voice) this.voiceId = key.voice;
      this.appLed = !!this.lesson && key.appLed === true;
      this.updateRemaining(key.todaySeconds, key.limitSeconds);
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e) {
        stream = null;
        this.set({ notice: micHelp(e) });
      }
      if (stale()) return abandon();
      this.stream = stream;
      pc = new RTCPeerConnection(); this.pc = pc;
      if (this.stream) { this.track = this.stream.getAudioTracks()[0]; this.track.enabled = false; pc.addTrack(this.track, this.stream); }
      else pc.addTransceiver("audio", { direction: "recvonly" });
      pc.onconnectionstatechange = () => { if (["failed", "disconnected"].includes(pc.connectionState) && this.pc === pc) this.lost(); };
      const dc = pc.createDataChannel("oai-events"); this.dc = dc;
      dc.onopen = () => { if (this.instr) this.setInstructions(this.instr); this.requestGreeting(); };
      dc.onmessage = (m) => { try { this.onEvent(JSON.parse(m.data)); } catch { /* 깨진 메시지 무시 */ } };
      this.greeted = false;
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      if (stale()) return abandon();
      const res = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST", headers: { Authorization: `Bearer ${key.value}`, "Content-Type": "application/sdp" }, body: offer.sdp,
      });
      const answer = await res.text();
      if (stale()) return abandon();
      if (!res.ok) {
        const credit = res.status === 429 && /insufficient_quota|credit/i.test(answer);
        throw new api.ApiError(credit ? "ai_credit" : `sdp_${res.status}`, res.status);
      }
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
      if (stale()) return abandon();
      const m = /a=max-message-size:(\d+)/.exec(answer);
      this.maxMsg = Math.min(pc.sctp?.maxMessageSize || (m ? Number(m[1]) || 1_000_000 : 65536), 1_000_000);
      this.log("rt_connected", { connect_ms: Date.now() - t0, first, mic: !!this.stream, story: !!this.story });
      if (!this.story) this.startMeter();
    } catch (e) {
      if (stale()) return abandon();
      this.teardown();
      const code = e?.code ?? e?.name ?? "error";
      const msg = {
        daily_limit: "오늘 대화 시간을 모두 썼어요. 자정이 지나면 다시 이야기할 수 있어요.",
        service_paused: "지금은 잠시 대화를 쉬고 있어요. 나중에 다시 시도해 주세요.",
        ai_credit: "AI 서비스 사용료(크레딧)가 떨어져서 연결하지 못했어요. 운영자에게 알려 주세요.",
        sdp_429: "지금 연결이 몰려서 잠시 밀렸어요. 조금 뒤 다시 시작을 눌러 주세요. (429)",
      }[code] ?? `실시간 연결에 실패했어요. 인터넷을 확인하고 다시 시작을 눌러 주세요. (${code})`;
      this.set({ state: code === "daily_limit" || code === "service_paused" ? "stopped" : "disconnected", micOn: false, canRestart: code !== "daily_limit", notice: msg });
      this.log("rt_connect_failed", { code });
    }
  }

  /** 동화 듣기: 그 쪽 내용을 담은 아이 모드 지시문으로 바꾼다(앱 updateKidsInstructions와 같음). 연결 전이면 열릴 때 보낸다. */
  setInstructions(text) {
    this.instr = text;
    if (this.dc?.readyState === "open") this.send({ type: "session.update", session: { type: "realtime", instructions: text } });
  }

  requestGreeting() {
    if (this.story) { this.openMic(); return; }
    if (this.lesson) {   // 수업: 첫 단계부터. 끊겼다 이어지면 장면 단계는 장면을 처음부터(마이크는 끝난 뒤), 나머지는 하던 단계를 다시
      this.greeted = true;
      const cur = this.lesson.steps[this.lessonStep];
      if (this.lessonStep < 0) this.startLessonStep(0);
      else if (cur?.type === "dialogue" && cur.play) this.playScene(cur);
      else { this.openMic(); this.sendStepTeach(this.lessonStep, true); }
      return;
    }   // 동화: 인사 없이 바로 마이크(동화는 이미 흐르고 있다)
    this.send({ type: "response.create" });
    setTimeout(() => { if (!this.greeted) this.openMic(); }, 8000);
  }

  openMic() {
    if (this.closed || !this.pc) return;
    this.greeted = true;
    if (this.ui.lessonScene) return;   // 0.9 헤니 검토: 교재 장면 중에는 어떤 경로로도 마이크를 켜지 않는다
    if (this.track && !this.cameraHold) { this.track.enabled = true; this.set({ micOn: true }); }
  }

  send(obj) {
    const d = this.dc; if (!d || d.readyState !== "open") return false;
    try { d.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  // ---------------- 서버 사건 ----------------
  onEvent(ev) {
    if (this.closed) return;
    switch (ev.type) {
      case "input_audio_buffer.speech_started": {
        this.lastSpeechStart = Date.now();
        if (ev.item_id && !this.lessonItems.has(ev.item_id)) this.lessonItems.set(ev.item_id, this.lessonHold ? this.holdSeq : -1);   // 11/14 헤니 검토: 어느 수업(또는 수업 밖)에서 시작한 말인지
        clearTimeout(this.idleTimer); clearTimeout(this.quietTimer); this.onSpeechStart?.();
        this.startedDuringPlayback = this.player.isPlaying || !!this.story?.isNarrating();
        if (this.story) { this.story.onSpeechStart(); this.interruptReply(); }
        else if (this.player.isPlaying && this.resp) this.startSoft();
        else this.interruptReply();
        this.set({ state: "listening", speech: true });
        break;
      }
      case "input_audio_buffer.committed": {
        if (ev.item_id && !this.lessonItems.has(ev.item_id)) this.lessonItems.set(ev.item_id, this.lessonHold ? this.holdSeq : -1);
        break;
      }
      case "input_audio_buffer.speech_stopped": {
        this.tSpeechStopped = Date.now();
        if (this.soft) { clearTimeout(this.softTimer); this.softTimer = setTimeout(() => { if (this.soft) this.endSoft(false, null, "no_transcript"); }, 3000); }
        this.set({ state: "thinking", speech: false });
        break;
      }
      case "conversation.item.input_audio_transcription.completed": {
        const t = String(ev.transcript ?? "").trim();
        if (this.soft) {
          const real = /\p{L}/u.test(t) && !this.looksLikeEcho(t);
          this.endSoft(real, ev.item_id, real ? "speech" : t ? "echo" : "blank");
          if (!real) return;
        }
        const noise = !!this.story && !/\p{L}/u.test(t);   // 동화: 글자가 하나도 없는 소리(잡음)는 말로 치지 않는다
        if (noise || (this.startedDuringPlayback && this.looksLikeEcho(t))) {
          this.startedDuringPlayback = false;
          if (ev.item_id) this.send({ type: "conversation.item.delete", item_id: ev.item_id });
          if (this.resp) this.interruptReply();
          this.send({ type: "response.cancel" });
          this.log(noise ? "story_noise" : "rt_echo", {}); this.lastEchoAt = Date.now();
          if (this.story) this.story.onNoise();
          else if (!this.resp && !this.player.isPlaying) { this.set({ state: "listening" }); this.armIdle(); }
          return;
        }
        this.startedDuringPlayback = false;
        // 11/14 헤니 재검토 1-2: 지금 수업에서 시작한 말만 지금 수업의 답. 앞 수업에서 한 말이 늦게 오면 답으로 쓰지 않는다
        const hold = ev.item_id ? this.lessonItems.get(ev.item_id) : undefined;
        if (ev.item_id) this.lessonItems.delete(ev.item_id);
        const thisLesson = this.lessonHold && (hold === undefined || hold === this.holdSeq);
        if (t && thisLesson && this.lessonHook?.(t, ev.item_id)) break;   // 교재 중: 기록·자막에 남기지 않고 교재가 처리(11/14)
        if (hold !== undefined && hold >= 0) {
          // 끝난(또는 앞) 수업 중에 한 말의 전사가 늦게 도착: 기록·자막·기억에 넣지 않고 서버 문맥에서도 지운다
          this.send({ type: "conversation.item.delete", item_id: ev.item_id });
          this.log("lesson_late_transcript", {});
          break;
        }
        if (t && !this.story) this.onLearnerText?.(t);
        if (t && this.lesson && /\p{L}/u.test(t)) { this.lessonSaid++; this.stepLog.push({ who: "learner", text: t }); this.quietCount = 0; this.lessonHeard(t); }
        if (t && this.placement && /\p{L}/u.test(t)) this.placementHeard(t);
        if (t) { this.persist("user", t); this.addLine("user", t); if (confused(t)) this.helpWanted = true; if (!this.story && /\p{L}/u.test(t)) this.learnerTurns = (this.learnerTurns ?? 0) + 1; this.noteTextAsk(t); }
        break;
      }
      case "response.created": {
        const rid = ev.response?.id;
        // 0.8.4 처음 이야기: 마무리 인사를 청한 뒤에는 그 대답 하나만 받는다(끼어들기 직후라도 이 대답은 버리지 않는다)
        let plWrapNow = false;
        if (this.placement && this.plWrap) {
          if (this.plWrap === "asked") { this.plWrap = "speaking"; this.plWrapRid = rid; plWrapNow = true; }
          else if (rid !== this.plWrapRid) { this.ignoredResp = rid; this.send({ type: "response.cancel" }); return; }
        }
        // 0.8.2: 장면을 트는 동안 만들어진 대답(넘어가기 직전에 한 말에 대한 답)은 장면 위에 겹치므로 버린다
        if (!plWrapNow && (this.soft || Date.now() < this.ignoreUntil || this.lessonHold || this.ui.lessonScene)) { this.ignoredResp = rid; this.softHeld = this.soft; this.send({ type: "response.cancel" }); return; }
        clearTimeout(this.idleTimer); clearTimeout(this.quietTimer);
        if (this.resp) this.finishReply(this.resp, false);
        if (this.announceAt && Date.now() > this.announceAt) this.announceAt = 0;   // 검색 결과가 들어간 뒤의 대답이 결과를 전한다
        this.epoch++;
        this.resp = { id: rid, epoch: this.epoch, text: "", pending: "", done: false, played: [], chain: Promise.resolve(), itemId: null, first: true, hadText: false, slow: !!this.slowOnce };
        this.slowOnce = false;
        break;
      }
      case "response.output_item.added": {
        if (this.ignoredResp && ev.response_id === this.ignoredResp) return;
        if (ev.item?.role === "assistant" && this.resp) this.resp.itemId = ev.item.id;
        break;
      }
      case "response.output_item.done": {
        // 친구가 인터넷 찾아보기(web_search)를 부름: 대답이 끝나면 서버에서 찾아 결과를 돌려준다(11/13)
        if (this.ignoredResp && ev.response_id === this.ignoredResp) return;
        const it = ev.item;
        if (it?.type === "function_call" && !this.story) this.pendingCall = { callId: it.call_id, name: it.name, args: it.arguments, at: Date.now(), r: this.resp };
        break;
      }
      case "response.output_text.delta": case "response.text.delta": {
        if (this.ignoredResp && ev.response_id === this.ignoredResp) return;
        const r = this.resp; if (!r) return;
        const d = String(ev.delta ?? "");
        if (!r.itemId) r.itemId = ev.item_id;
        r.text += d; if (d.trim()) r.hadText = true;
        const cut = takeSentences(r.pending + d, false); r.pending = cut.rest;
        cut.sentences.forEach((s) => this.enqueue(r, s));
        break;
      }
      case "response.output_text.done": case "response.text.done": {
        if (this.ignoredResp && ev.response_id === this.ignoredResp) return;
        const r = this.resp; if (!r || r.done) return;
        takeSentences(r.pending, true).sentences.forEach((s) => this.enqueue(r, s));
        r.pending = ""; r.done = true;
        this.lessonPrecheck(r);
        // 11/13 헨니 검토: 카드는 안전검사를 통과해 실제로 들려준 말로만 만든다(onReplyPlayed)
        r.chain.then(() => this.onReplyPlayed(r));
        break;
      }
      case "response.done": {
        if (this.ignoredResp && ev.response?.id === this.ignoredResp) { this.ignoredResp = null; return; }
        if (ev.response?.usage) this.log("rt_usage", ev.response.usage);
        const r = this.resp;
        if (r && !r.done) {
          takeSentences(r.pending, true).sentences.forEach((s) => this.enqueue(r, s));
          r.pending = ""; r.done = true; this.lessonPrecheck(r); r.chain.then(() => this.onReplyPlayed(r));
        }
        const call = this.pendingCall; this.pendingCall = null;
        // 0.8.2: 말과 그림 밝히기(highlight_*)가 한 대답에 오면 새 대답을 청하지 않는다(청하면 하던 말이 끊겼음). 그 대답은 보통 대답처럼 다룬다.
        const hi = !!call && !!this.lesson && (call.name === "highlight_line" || call.name === "highlight_word");
        if (call) call.withText = !!r?.hadText;
        if (call && r) r.hadCall = !(hi && r.hadText);
        if (call) { if (this.lesson && LESSON_TOOLS.has(call.name)) this.runLessonTool(call); else this.runTool(call); break; }
        if (r && !r.hadText) { if (this.story) { this.resp = null; this.story.onReplyDone(); } else if (Date.now() - (this.lastEchoAt ?? 0) > 5000) this.nudge(Date.now()); }   // 메아리 뒤에는 다시 청하지 않음(16:06)
        break;
      }
      case "error": if (ev.error?.code !== "response_cancel_not_active") this.log("rt_error", { code: ev.error?.code ?? "error" }); break;   // 늦게 닿은 취소(해 없음)는 기록 안 함
    }
  }

  // ---------------- 문장마다 안전검사 + 목소리 ----------------
  async slot() { if (this.slots < 2) { this.slots++; return; } await new Promise((r) => this.waiters.push(r)); this.slots++; }
  release() { this.slots--; const w = this.waiters.shift(); if (w) w(); }

  enqueue(r, sentence) {
    if (r.epoch !== this.epoch) return;
    // 11/15 실장님: 친구가 한국어로 말하는 일은 절대 없어야 함 → 한글이 든 문장은 소리로 내지 않는다(대답 전체가 버려지면 영어로 다시 청함)
    if (!this.story && !this.placement && !this.lesson?.koreanOk && /[\u3131-\u318E\uAC00-\uD7A3]/.test(sentence)) { r.koDropped = (r.koDropped ?? 0) + 1; this.log("ko_blocked", { len: sentence.length }); return; }
    // 0.8.2: 앱이 넘기는 방식에서는 예고 문장을 지우지 않고 기록만 한다(도구가 없어 건너뛸 일이 없고, 질문·지시가 든 문장까지 지워졌음)
    // 수업 자체를 말하는 문장(“Let me think…”, “keep us moving”)은 앱 방식에서도 지운다.
    const meta = this.lesson && !this.story && isMetaTalk(sentence, this.lesson.steps?.[this.lessonStep]?.teach);   // 교재에 있는 문장(“I’ll think about it.”)은 지우지 않는다
    if (this.lesson && !this.story && (isPreamble(sentence) || meta)) {
      const cut = !this.appLed || meta;
      this.log("preamble_cut", { text: sentence.slice(0, 120), kept: !cut }); if (cut) return;
    }
    // 역할 읽기: 선생님이 자기 줄을 한 대답에 두 번 읽으면 두 번째는 내지 않는다
    if (this.lesson && this.appLed && !this.story && this.rp?.step === this.lessonStep && isRolePlay(this.lesson.steps?.[this.lessonStep])) {
      r.seen ??= new Set();
      if (roleRepeat(rolePlan(this.lesson.steps[this.lessonStep].teach), r.seen, sentence)) { this.log("role_repeat_cut", {}); return; }
    }
    if (this.lesson && !this.story) sentence = sentence.replace(/_{2,}/g, "something");   // 빈칸은 소리로 읽을 수 없다
    const voice = this.voiceId, speed = this.story ? 1 : (r.slow ? Math.max(0.7, this.speed * 0.8) : this.speed), sid = this.sessionId;
    const job = (async () => { await this.slot(); try { return await api.say(sentence, voice, speed, sid); } finally { this.release(); } })();
    job.catch(() => {});
    r.chain = r.chain.then(async () => {
      if (r.epoch !== this.epoch || r.blocked) return;
      // 11/15 T10: 첫마디만 나가고 뒤 문장이 실패하면 안내가 없어 친구가 대답을 피하는 것처럼 보였음 → 중간에 끊겨도 알린다
      let s; try { s = await job; } catch (e) {
        const limit = e?.code === "daily_voice_limit";
        this.set({ notice: limit ? "오늘 친구 목소리를 만들 수 있는 양을 모두 썼어요. 자정이 지나면 다시 이야기할 수 있어요."
          : r.first ? "목소리를 만들지 못했어요. 다시 말해 주거나 글로 입력해 주세요." : "목소리를 다 만들지 못해 대답이 중간에 끊겼어요. 다시 말해 주세요." });
        if (!r.first) this.log("tts_cut", { code: e?.code ?? "error" });
        return;
      }
      if (r.epoch !== this.epoch) return;
      // 11/18 김연경님 시험: 수업 문장 하나가 안전검사에 잘못 걸려 ‘Hmm, let's talk about something else.’로 바뀌고 나머지 말이 버려짐.
      // 수업(교재 내용)에서는 걸린 문장만 조용히 빼고 이어 간다. 원문은 확인용으로 남긴다(선생님 말).
      if (s.result !== "ok" && this.lesson && !this.story) { this.log("tts_flagged_lesson", { result: s.result, text: sentence.slice(0, 300) }); return; }
      const spoken = s.fixed ?? sentence;
      if (s.result !== "ok") r.blocked = true;   // 안전검사에 걸리면 고정 문장 하나만 들려주고 나머지는 버린다(앱과 같음)
      if (r.first) {
        r.first = false;
        const lat = this.tSpeechStopped ? Date.now() - this.tSpeechStopped : null;
        this.set({ state: "speaking", lastLatencyMs: lat ?? this.ui.lastLatencyMs, notice: null });
        this.log("turn", { speech_stop_to_first_audio_ms: lat ?? -1 });
        this.tSpeechStopped = 0;
        this.addLine("assistant", spoken, true);
      } else this.appendAssistant(spoken);
      this.recentFriend = (this.recentFriend + " " + spoken).slice(-400);
      if (this.story) {
        // 동화: 대답 속 단어의 그림을 그 단어가 나올 즈음 띄운다(토리 목소리 약 13자/초로 어림, 앱과 같음)
        for (const m of spoken.matchAll(/[A-Za-z']+/g)) {
          const pic = this.story.pictureFor(m[0]);
          if (pic) setTimeout(() => { if (r.epoch === this.epoch) this.story.onCue(pic); }, Math.round(m.index * 1000 / 13));
        }
      }
      const ok = await this.player.play(s.pcm, s.rate);
      if (ok && r.epoch === this.epoch) r.played.push(spoken);
    });
  }

  onReplyPlayed(r) {
    if (r.epoch !== this.epoch || this.resp !== r) return;
    this.finishReply(r, true);
    if (r.koDropped && !r.played.length && !this.story && this.pc && !this.closed) {
      this.resp = null;
      this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text",
        text: "Note from the app: your last reply had Korean words, so the learner could not hear it. Say it again now in simple English only, with no Korean letters at all." }] } });
      this.send({ type: "response.create" }); this.set({ state: "thinking" });
      return;
    }
    // 0.8.5(11/19 실장님): 1:1 수업에서도 따라 말할 문장 카드를 띄운다
    if (!this.story && !this.placement) { if (r.blocked) this.set({ card: null }); else this.updateCard(r.played.join(" ")); }
    this.resp = null;
    if (!this.greeted) this.openMic();
    if (this.pc) this.set({ state: "listening" });
    if (this.story) { this.story.onReplyDone(); return; }
    this.afterFriendFinished();
    if (this.lesson && this.appLed) {
      if (this.sceneIntro && this.sceneIntro.at === this.lessonStep) { this.sceneIntro.done = true; return; }   // 장면 앞 한마디가 끝남 → introScene이 장면을 튼다
      if (!r.hadCall) this.lessonAfterReply(r);
    }
  }

  /** 들려준 만큼만 기록하고, 서버 문맥도 들려준 말로 고친다. */
  finishReply(r, complete) {
    const played = r.played.join(" ").trim();
    if (!complete || played !== r.text.trim()) this.fixServerContext(r, played);
    if (played) this.persist("assistant", played);
    if (played && this.lesson && !this.story) this.stepLog.push({ who: "teacher", text: played + (complete ? "" : " …") });
    if (played && !this.story && !this.lesson && !this.placement) { this.trackPractice(played); this.noteCorrection(played); this.noteQuestion(played); }
    if (this.placement) this.placementReplied(r, played, complete);
    this.closeAssistantLine(!complete);
  }

  /** 앱과 같게: 문장 전체 따라 말하기가 세 번 연달아 나오면 다음엔 넘어가라는 메모를 넣는다(두 번까지는 정상, 11/13). */
  trackPractice(played) {
    this.practiceStreak = hasPracticeQuote(played) ? (this.practiceStreak ?? 0) + 1 : 0;   // 0.9.2: 말투가 다양해져 따옴표로 판단
    if (this.practiceStreak < 3) return;
    this.practiceStreak = 0;
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text",
      text: "Note from the app: the learner has already practiced this sentence enough. In your next reply, do not correct and do not ask them to repeat. Say a few warm words about the effort, then ask one easy new question." }] } });
    this.log("practice_limit", {});
  }

  fixServerContext(r, played) {
    if (!r.itemId) return;
    this.send({ type: "conversation.item.delete", item_id: r.itemId });
    if (played) this.send({ type: "conversation.item.create", item: { type: "message", role: "assistant", content: [{ type: "output_text", text: played }] } });
  }

  interruptReply() {
    const r = this.resp; if (!r) return;
    this.epoch++; this.player.stop();
    if (!r.done) this.send({ type: "response.cancel" });
    this.finishReply(r, false);
    this.resp = null;
    this.log("rt_barge_in", {});
  }

  // 친구 말 중에 들린 소리: 진짜 말인지 1.3초 지켜본다(잡음·되울림이면 하던 말을 이어 감)
  startSoft() {
    this.soft = true; this.softHeld = false; this.player.duck(true);
    clearTimeout(this.softTimer);
    this.softTimer = setTimeout(() => { if (this.soft && this.ui.speech) { this.soft = false; this.player.duck(false); this.interruptReply(); this.log("rt_soft_barge", { result: "long" }); } }, 1300);
  }

  endSoft(real, itemId, why) {
    clearTimeout(this.softTimer); this.soft = false; this.player.duck(false);
    if (real) { this.interruptReply(); if (this.softHeld) this.send({ type: "response.create" }); }
    else {
      if (itemId) this.send({ type: "conversation.item.delete", item_id: itemId });
      if (!this.softHeld) this.ignoreUntil = Date.now() + 1500;
      this.startedDuringPlayback = false;
      this.set({ state: this.player.isPlaying ? "speaking" : "listening" });
    }
    this.softHeld = false;
    this.log("rt_soft_barge", { result: why });
  }

  /** 동화 읽는 글도 되울림 판단에 넣는다(마이크가 동화 소리를 다시 들은 것인지). */
  noteHeard(text) { this.recentFriend = (this.recentFriend + " " + text).slice(-400); }

  looksLikeEcho(heard) {
    const words = (x) => x.toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 1);
    const h = words(heard); if (h.length < 2) return false;
    const f = new Set(words(this.recentFriend));
    return h.filter((w) => f.has(w)).length >= h.length * 0.8;
  }

  /** 인터넷 찾아보기: "Let me check."을 다 들려준 뒤 결과로 다시 대답하게 한다. 그사이 학습자가 말했으면 결과만 넘기고 새 대답은 만들지 않는다. */
  async runTool(c) {
    this.set({ searching: true, state: "thinking" });
    let output, args = {};
    try { args = JSON.parse(c.args || "{}") ?? {}; } catch { /* */ }
    const q = String(args.query ?? "");
    if (c.name === "web_search") {
      try { const res = await api.lookup(q, this.sessionId); output = res.ok ? { answer: res.answer } : { error: res.error || "not_found" }; }
      catch { output = { error: "search_failed" }; }
      this.log("web_search_used", { ok: !!output.answer, ms: Date.now() - c.at });
    } else if (c.name === "show_picture") {
      // 11/13 단어 사진(Pixabay 등): 사진을 먼저 받아 둔 뒤 화면에 띄우고, 친구에게는 띄웠는지만 알려 준다
      let shown = false;
      try {
        const res = await api.picture(q, this.sessionId);
        // 11/13 14:45: 사진 사이트 주소를 브라우저가 바로 못 불러옴 → 서버가 넘겨 준 사진 자체(image)를 쓴다
        const src = res.image && /^image\/(jpeg|png|webp|gif)$/.test(res.mime || "") ? `data:${res.mime};base64,${res.image}`
          : /^https:\/\/(pixabay\.com\/get\/|cdn\.pixabay\.com\/|images\.pexels\.com\/)/.test(res.url || "") ? res.url : null;
        if (res.ok && src && await preload(src) && !this.closed) {
          shown = true; this.pictureTurns = 0;
          const word = String(args.word || q).slice(0, 40);
          const seq = (this.ui.webPicture?.seq ?? 0) + 1;
          this.set({ webPicture: { url: src, word, photographer: res.photographer || "", pageUrl: res.pageUrl || "https://pixabay.com", source: res.source || "Pixabay", seq } });
          this.closePictureLater(seq);
          output = res.alt ? { shown: true, description: res.alt } : { shown: true };
        } else output = { shown: false, reason: res.error || "not_found" };
      } catch { output = { shown: false, reason: "picture_failed" }; }
      this.log("picture_used", { ok: shown, ms: Date.now() - c.at });
    } else if (c.name === "show_word") {
      // 11/15 실장님: 형용사·동사처럼 그림이 안 맞는 말은 뜻을 글 카드로(한국어 뜻은 화면에만, 친구 목소리는 영어만)
      const clip = (x, n) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
      const word = clip(args.word, 40);
      if (word && !this.closed) {
        const seq = (this.ui.webPicture?.seq ?? 0) + 1;
        this.set({ webPicture: { kind: "word", word, meaning: clip(args.meaning_ko, 60), example: clip(args.example_en, 90), exampleKo: clip(args.example_ko, 90), seq } });
        this.pictureTurns = 0; this.closePictureLater(seq);
        this.addLine("assistant", `[${word}] ${clip(args.meaning_ko, 60)}`, false);
        output = { shown: true, kind: "word_card", note: "A word card (not a picture) is now on the screen. Do not call it a picture." };
      } else output = { shown: false };
      this.log("word_card", { word });
    } else output = { error: "unknown_tool" };
    this.set({ searching: false });
    if (this.closed || !this.pc) return;
    // 결과는 바로 대화에 넣는다. 그사이 다른 이야기를 하고 있었으면(11/13 실장님: 그건 좋음) 지금 대답이 끝난 뒤 "아까 찾아본 건…"으로 전한다.
    this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.callId, output: JSON.stringify(output) } });
    this.announceAt = Date.now();
    if (this.idleForAnnounce()) { this.send({ type: "response.create" }); this.set({ state: "thinking" }); }
  }
  idleForAnnounce() { return !this.resp && !this.player.isPlaying && !this.ui.speech; }

  // ---------- 교정 빈도(11/13 실장님: 학습자 말 4번에 한 번쯤, 자주 틀리는 표현은 꼭) — 앱과 같음 ----------
  noteCorrection(played) {
    const m = /(we usually say|a more natural way to say|let's try it in parts|listen once more|you can say,)/i.exec(played) ?? (hasPracticeQuote(played) ? ["", "quote"] : null); if (!m) return;
    this.learnerTurns = 0; this.correctionNoted = false;
    this.log("correction", { kind: m[1].toLowerCase().slice(0, 24) });
  }
  // 11/13 15:43 'A or B?' 질문이 두 번 연속이면 메모(앱과 같음)
  noteQuestion(played) {
    const q = played.split(/(?<=[.!?])\s+/).filter((s) => s.trim().endsWith("?")).pop(); if (!q) return;
    this.choiceRun = /\bor\b/i.test(q) ? (this.choiceRun ?? 0) + 1 : 0;
    if (this.choiceRun >= 2 && this.pc && !this.closed) {   // 센 자리에서 바로 메모(앱과 같음)
      this.choiceRun = 0;
      this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text",
        text: "Note from the app: your last two questions offered choices. Your next question must not contain the word or and must not list examples (no like A, B...). Ask one open question that needs a full sentence (What...? How...? Why...? Have you ever...? What would you do if...?). If this topic has gone on for a while, move to a different part of daily life instead." }] } });
      this.log("question_nudge", {});
    }
  }
  afterReplyNotes() {
    if (this.story || this.lesson || this.placement) return;   // 0.8.4 처음 이야기에서는 고쳐 주지 않는다
    if ((this.learnerTurns ?? 0) >= 3 && !this.correctionNoted) {
      this.correctionNoted = true;
      this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text",
        text: "Note from the app: there has been no correction for a few turns. In your next reply, if the learner made a clear mistake recently, give one practice correction (for a question or request: answer first, then the By the way tip). Choose a mistake they have made more than once first. If there is no clear mistake, just continue naturally." }] } });
      this.log("correction_nudge", {});
    }
    if (this.announceAt) setTimeout(() => {
      if (this.closed || !this.pc || !this.announceAt || !this.idleForAnnounce()) return;
      this.send({ type: "response.create" });
    }, 700);
  }

  nudge(at) {
    setTimeout(() => {
      if (this.closed || !this.pc || this.lastSpeechStart > at || this.resp || this.player.isPlaying || this.ui.speech) return;
      this.send({ type: "response.create" }); this.log("rt_nudge", {});
    }, 3500);
  }

  afterFriendFinished() {
    if (this.limitReached) { this.stopInternal("DAILY_LIMIT", "오늘 대화 시간을 모두 썼어요. 자정이 지나면 다시 이야기할 수 있어요."); this.set({ canRestart: false }); return; }
    clearTimeout(this.idleTimer);
    this.afterReplyNotes();
    this.onFriendDone?.();
    this.armIdle();
  }
  /** 쉬는 시간 타이머(60초 뒤 멈춤). 수업에서는 12초 동안 아무 말이 없으면 선생님이 다시 묻게 한다(같은 자리에서 2번까지, 0.8.2). */
  armIdle() {
    clearTimeout(this.idleTimer); clearTimeout(this.quietTimer);
    this.idleTimer = setTimeout(() => {
      if (this.closed || !this.pc || this.player.isPlaying || this.ui.speech || this.resp) return;
      this.stopInternal("IDLE_PAUSE", "한동안 대답이 없어서 잠시 멈췄어요. 이어서 하려면 다시 시작을 눌러 주세요.");
    }, 60000);
    if (!this.lesson || !this.appLed || this.story || (this.quietCount ?? 0) >= 2) return;
    const gen = this.lessonGen, at = this.lessonStep;
    this.quietTimer = setTimeout(() => {
      if (this.closed || !this.pc || gen !== this.lessonGen || at !== this.lessonStep || this.player.isPlaying || this.ui.speech || this.resp || this.ui.lessonScene || this.ui.lessonDone || this.sceneIntro) return;
      this.quietCount = (this.quietCount ?? 0) + 1; this.log("lesson_quiet", { step: at, n: this.quietCount });
      this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: QUIET_NOTE }] } });
      this.send({ type: "response.create" }); this.set({ state: "thinking" });
    }, this.quietMs);
  }

  // ---------------- 도움 카드·자막 ----------------
  updateCard(reply) {
    let d = decideCard(reply, this.practiceTarget, this.helpWanted); if (!d) return;
    if (this.showTextWanted) {
      // 글로 보여 달라고 한 뒤의 대답: 따옴표 문장(없으면 지금 연습 중인 문장)을 바로 카드로
      this.showTextWanted = false;
      const q = lastQuote(reply) ?? this.practiceTarget;
      if (q) d = { card: { practice: true, text: q }, target: q };
    }
    this.practiceTarget = d.target; this.helpWanted = false;
    if (d.card || this.ui.card) this.set({ card: d.card });
    if (d.card) this.log("help_card", { kind: d.card.chunk ? "chunk" : d.card.practice ? "practice" : "rephrase" });
  }
  dismissCard() { this.set({ card: null }); }
  dismissWebPicture() { this.set({ webPicture: null }); }
  /** 11/13 15:07 실장님: 사진이 계속 떠 있음 → 10초 뒤 저절로 닫는다. 그때 친구가 아직 설명 중이면 말이 끝나고 조금 뒤에(최대 25초). */
  closePictureLater(seq) {
    const t0 = Date.now();
    const tick = () => {
      if (this.ui.webPicture?.seq !== seq) return;
      const busy = this.player.isPlaying || !!this.resp;
      if (busy && Date.now() - t0 < 25000) return setTimeout(tick, 1500);
      this.set({ webPicture: null });
    };
    setTimeout(tick, 10000);
  }
  noteTextAsk(t) {
    // 단어 사진은 학습자가 세 번 말하면 저절로 닫는다(앱과 같음)
    if (this.ui.webPicture && (this.pictureTurns = (this.pictureTurns ?? 0) + 1) >= 3) this.set({ webPicture: null });
    if (this.story || !wantsText(t)) return;
    this.showTextWanted = true;
    if (this.practiceTarget) { this.set({ card: { practice: true, text: this.practiceTarget } }); this.log("help_card", { kind: "asked" }); }
  }

  addLine(role, text, pending = false) { this.lineSeq = (this.lineSeq ?? 0) + 1; this.set({ lines: [...this.ui.lines, { role, text, pending, seq: this.lineSeq }].slice(-60) }); }
  appendAssistant(text) {
    const lines = [...this.ui.lines]; const last = lines[lines.length - 1];
    if (last && last.role === "assistant" && last.pending) lines[lines.length - 1] = { ...last, text: last.text + " " + text };
    else lines.push({ role: "assistant", text, pending: true });
    this.set({ lines });
  }
  closeAssistantLine(cut) {
    this.set({ lines: this.ui.lines.map((l) => (l.pending ? { ...l, pending: false, text: cut ? l.text + " …" : l.text } : l)) });
  }

  persist(role, text) {
    if (!this.sessionId || !this.saveTranscripts || this.privateTopic) return;   // 7~9단계 연습 중엔 기록·기억에 남기지 않음(실장님 결정 3)
    const n = this.seq++;
    api.saveTurn(this.sessionId, n, role, text).catch(() => this.log("save_failed", {}));
  }

  // ---------------- 글·사진 ----------------
  sendText(text) {
    const t = text.trim(); if (!t || !this.pc) return;
    if (this.lessonHook?.(t, null)) return;   // 교재 중 글 입력도 교재가 받는다
    this.onLearnerText?.(t);
    clearTimeout(this.idleTimer);
    this.interruptReply();
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: t }] } });
    this.send({ type: "response.create" });
    this.persist("user", t); this.addLine("user", t); if (confused(t)) this.helpWanted = true;
    this.learnerTurns = (this.learnerTurns ?? 0) + 1; this.noteTextAsk(t);
    if (this.placement) this.placementHeard(t);
    this.tSpeechStopped = Date.now();
    this.set({ state: "thinking" });
  }

  /** dataUrl: data:image/jpeg;base64,... (크기는 maxMsg 안에 맞춘 것) */
  sendImage(dataUrl, previewUrl) {
    if (!this.pc || this.dc?.readyState !== "open") { this.set({ notice: "대화가 연결된 동안에만 사진을 보여 줄 수 있어요." }); return false; }
    if (this.lessonHold) { this.set({ notice: "표현 익히기 중에는 사진을 보낼 수 없어요. 끝내거나 잠시 멈춘 뒤 보내 주세요." }); return false; }
    clearTimeout(this.idleTimer);
    this.interruptReply();
    const ok = this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [
      { type: "input_image", image_url: dataUrl }, { type: "input_text", text: PHOTO_HINT }] } });
    if (!ok) { this.set({ notice: "사진을 보내지 못했어요. 잠시 뒤 다시 해 볼까요?" }); this.log("photo_failed", { kb: Math.round(dataUrl.length / 1024) }); return; }
    this.send({ type: "response.create" });
    this.persist("user", "(사진을 보여 줌)"); this.addLine("user", "📷 사진");
    this.tSpeechStopped = Date.now();
    this.set({ state: "thinking", photo: previewUrl, notice: null });
    this.log("photo_sent", { kb: Math.round(dataUrl.length / 1024), max_msg: this.maxMsg });
    return true;
  }
  clearPhoto() { this.set({ photo: null }); }

  // ---------------- 교재로 배우기(11/14, 운영자 계정만) ----------------
  /** 교재 시작: 친구 AI의 대답을 막고(만들어지면 바로 취소), 하던 말·카드·쉬는 시간 타이머를 멈춘다. */
  beginLessonHold() {
    this.lessonHold = true; this.holdSeq++;
    clearTimeout(this.idleTimer);
    this.interruptReply(); this.send({ type: "response.cancel" });
    this.player.stop();
    this.set({ card: null, state: "listening" });
    this.log("lesson_hold", { on: true });
  }
  /** 교재 끝: 교재 중 학습자 말을 서버 문맥에서 지우고(기억·역할극 내용이 섞이지 않게), 메모를 넣고 친구가 이어 말하게 한다. */
  endLessonHold({ deleteItems = [], note = null, respond = true, userText = null } = {}) {
    this.lessonHold = false;
    deleteItems.forEach((id) => { this.lessonItems.delete(id); this.send({ type: "conversation.item.delete", item_id: id }); });
    // 글로 쓴 말은 OpenAI 쪽에 아직 없다: 친구가 대답할 수 있게 한 번만 넣는다(11/14 헤니 검토 4)
    if (userText) this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: userText }] } });
    if (note) this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: note }] } });
    if (respond && this.pc && !this.closed) { this.send({ type: "response.create" }); this.set({ state: "thinking" }); }
    this.log("lesson_hold", { on: false, deleted: deleteItems.length });
  }
  /** 8~9단계 대화 주제: 친구에게 주제·대화 방식을 건네고 바로 말을 꺼내게 한다. */
  topicNote(note) {
    if (!this.pc) return;
    clearTimeout(this.idleTimer); this.interruptReply(); this.send({ type: "response.cancel" });
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: note }] } });
    this.send({ type: "response.create" }); this.set({ state: "thinking", card: null });
  }
  /** 교재: 토리가 말하는 동안 마이크를 끄고, 학습자 차례에 켠다. */
  setLessonMic(on) {
    this.lessonMicOn = !!on;
    if (!this.track || this.cameraHold || !this.pc) return;
    this.track.enabled = !!on && this.greeted;
    this.set({ micOn: !!on && this.greeted });
  }

  /** 사진을 고르러 가는 동안: 마이크를 끄고 화면이 가려져도 대화를 끊지 않는다. */
  holdForCamera(on) {
    this.cameraHold = on;
    // 수업 중이면 수업이 정한 마이크 상태(토리가 말하는 중엔 꺼 둠)를 따른다(11/14 헤니 검토 5)
    const want = !on && this.greeted && (!this.lessonHold || this.lessonMicOn);
    if (this.track) this.track.enabled = want;
    this.set({ micOn: want && !!this.track });
  }


  // ---------------- 0.9 1:1 수업(앱 RealtimeController와 같음) ----------------
  startLessonStep(i) {
    const L = this.lesson; if (!L) return;
    const step = L.steps[i]; if (!step) return this.finishLesson([], []);
    if (!this.lessonStartedAt) this.lessonStartedAt = Date.now();
    this.lessonStep = i; this.stepLineAt = (this.lineSeq ?? 0) + 1; this.stepHolds = 0; this.doneHeld = null;
    this.stepLog = []; this.wrapAsked = false; this.quietCount = 0; this.checkFails = 0; this.sceneIntro = null;
    this.set({ lessonStep: i, lessonHiLine: -1, lessonHiWord: null });
    this.log("lesson_step", { lesson: L.id, session: L.session, step: i, type: step.type });
    if (step.type === "dialogue" && step.play) { if (this.appLed && i > 0) this.introScene(i, step); else this.playScene(step); }
    else { this.openMic(); this.sendStepTeach(i); }
  }

  /** 0.8.2 장면을 틀기 전에 선생님이 한마디로 이어 준다(예전엔 칭찬 한마디 뒤 갑자기 다른 목소리가 나왔음). 그동안 마이크는 끈다. */
  async introScene(i, step) {
    const gen = this.lessonGen;
    const stale = () => this.closed || !this.pc || gen !== this.lessonGen || i !== this.lessonStep;
    if (this.track) this.track.enabled = false;
    this.set({ micOn: false });
    for (let w = 0; this.resp && w < 4000; w += 100) await sleep(100);
    if (stale()) return;
    const intro = this.sceneIntro = { at: i, done: false };
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: SCENE_INTRO(plain(step.title)) }] } });
    this.send({ type: "response.create" }); this.set({ state: "thinking" });
    for (let w = 0; !intro.done && w < 10000; w += 100) { await sleep(100); if (stale() || this.sceneIntro !== intro) return; }
    this.sceneIntro = null;
    if (!intro.done) { this.interruptReply(); this.log("lesson_scene_intro_late", {}); }
    this.playScene(step);
  }

  async sendStepTeach(i, resumed = false) {
    const L = this.lesson; const step = L?.steps[i]; if (!step) return;
    const gen = this.lessonGen;
    for (let w = 0; this.resp && w < 4000; w += 100) await sleep(100);
    if (this.closed || !this.pc || gen !== this.lessonGen || i !== this.lessonStep) return;
    // 0.8.5(11/19 실장님 수업 기록): 첫 인사에서 고쳐 주기·따라 하기·자기소개·질문을 한꺼번에 하던 문제
    const teach = (this.appLed ? appTeach(step.teach) : (step.teach || "Continue the lesson, then call next_step.")) + " " + (step.type === "intro" ? WARMUP_NOTE : TURN_NOTE);
    let note = (resumed ? "The connection dropped for a moment and is back. Do not greet again. " : "") +
      `Lesson step ${i + 1} of ${L.steps.length} (${step.type}). The learner's screen now shows this part of the textbook. Do this now: ${teach}`;
    // 0.8.2: 다시 연결되면 이 부분에서 이미 한 것을 알려 이어서 하게 한다(예전엔 처음부터 다시 했음)
    if (resumed && this.stepLog.length) note += `\nAlready done in this part before the connection dropped (most recent last):\n${this.stepLog.slice(-6).map((l) => `${l.who === "teacher" ? "You" : "Learner"}: ${l.text.slice(0, 300)}`).join("\n")}\nDo not start this part again: say one short sentence and continue from there.`;
    if (this.appLed && isRolePlay(step)) {
      // 0.9.13 역할 읽기: 앱이 한 줄씩. 처음(또는 다시 연결)에는 지금 자리부터 안내한다.
      const plan = rolePlan(step.teach);
      if (!resumed || !this.rp || this.rp.step !== i) { const nx = plan.findIndex((l) => l.who === "you"); this.rp = { step: i, next: nx === -1 ? plan.length : nx, at: 0, warned: false, comment: false, final: false }; }
      const startAt = !resumed && plan[0]?.who === "you" ? 0 : this.rp.next;
      const n = roleNote(plan, startAt, !resumed);
      if (n.final && !this.rp.final) { this.rp.final = true; this.rp.finalAt = this.stepLog.filter((l) => l.who === "learner").length; }
      this.rpHighlight(plan, startAt === 0 && plan[0]?.who === "you" ? 0 : plan.findIndex((l) => l.who === "learner"));
      note = (resumed ? "The connection dropped for a moment and is back. Do not greet again. " : "") +
        `Lesson step ${i + 1} of ${L.steps.length} (role reading). The learner's screen now shows the scene. ${n.note}`;
    }
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: note }] } });
    this.send({ type: "response.create" });
    this.set({ state: "thinking" });
  }

  /** 0.9.4 학습자가 교재 화면에서 누른 것을 선생님에게 알린다(학습자 말로 기록하지 않음). */
  lessonNote(text) {
    if (!this.lesson || this.closed || !this.pc || this.ui.lessonScene) return;
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: `(App: ${String(text).slice(0, 200)})` }] } });
    if (!this.resp && !this.player.isPlaying) { this.send({ type: "response.create" }); this.set({ state: "thinking" }); }
    this.log("lesson_tap", { note: String(text).slice(0, 80) });
  }

  /** 교재 장면: 인물마다 제 목소리로 차례로 들려준다. 그동안 마이크는 끈다. */
  async playScene(step) {
    const lines = step.lines ?? [];
    const my = ++this.sceneGen;
    if (this.track) this.track.enabled = false;
    this.set({ lessonScene: true, micOn: false, state: "speaking" });
    const sid = this.sessionId, sp = this.speed;
    let failed = 0;
    const jobs = lines.map((ln) => { const t = plain(ln.en); const j = (async () => { await this.slot(); try { return await api.say(t, sceneVoice(ln.who?.id), sp, sid); } finally { this.release(); } })(); j.catch(() => {}); return j; });
    for (let k = 0; k < lines.length; k++) {
      if (my !== this.sceneGen || this.closed || !this.pc) return;
      this.set({ lessonHiLine: k });
      let s = null; try { s = await jobs[k]; } catch { failed++; }   // 한 줄 못 만들면 건너뛰고 알린다(헤니 검토)
      if (my !== this.sceneGen || this.closed) return;
      if (s) { this.recentFriend = (this.recentFriend + " " + plain(lines[k].en)).slice(-400); await this.player.play(s.pcm, s.rate); }
    }
    if (my !== this.sceneGen || this.closed || !this.pc) return;
    this.set({ lessonScene: false, lessonHiLine: -1, state: "listening", ...(failed ? { notice: `장면 대사 ${failed}줄을 소리로 만들지 못했어요. 화면의 글로 읽어 주세요.` } : {}) });
    this.openMic();
    this.sendStepTeach(this.lessonStep);
  }

  /** 0.8.5(11/19 실장님 수업 기록): ‘다 했음’ 판정이 나온 뒤 학습자가 Okay처럼 짧게만 답하면 붙잡지 않고 넘긴다
   *  (예전엔 “Okay.”마다 다시 붙잡혀 2분 넘게 같은 부분에 머물렀음). “Next”·“다음”이라고 말하면 바로 넘긴다. */
  lessonHeard(t) {
    const L = this.lesson; if (!L || !this.appLed || this.closed || !this.pc || this.ui.lessonDone || this.ui.lessonScene || this.lessonStep < 0) return;
    const said = this.stepLog.filter((l) => l.who === "learner").length;
    if (asksNext(t) && said > 1) return this.moveOn("learner_next");
    const dh = this.doneHeld;
    if (dh && dh.at === this.lessonStep && dh.gen === this.lessonGen) {
      if (isAck(t) && !isRolePlay(L.steps[this.lessonStep])) return this.moveOn("ack_after_done");
      this.doneHeld = null;
    }
  }
  /** 0.8.6 내 교재: 아직 교재를 읽는 중이면 첫 부분(가벼운 대화)에 머문다. 준비되면 myPlanReady가 넘긴다. */
  myWait(why) {
    const L = this.lesson;
    if (!L?.my || !L.pending || this.lessonStep < L.steps.length - 1) return false;
    if (!this.myWaiting) { this.myWaiting = true; this.log("my_wait", { why }); if (!this.resp) this.sysNote(MY_STILL); }
    return true;
  }
  sysNote(text) {
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
    this.send({ type: "response.create" }); this.set({ state: "thinking" });
  }
  /** 서버가 교재를 다 읽음: 단계를 붙이고, 첫 부분이 이미 끝났으면 바로 첫 표현으로. 아니면 선생님에게만 알린다. */
  async myPlanReady(r) {
    const L = this.lesson; if (!L?.my || !L.pending || this.closed) return;
    applyMyPlan(L, r); this.log("my_ready", { steps: L.steps.length });
    this.set({ myReady: Date.now() });
    if (!this.pc || this.ui.lessonDone) return;
    if (this.myWaiting) {
      this.myWaiting = false;
      for (let w = 0; (this.resp || this.player.isPlaying) && w < 15000; w += 150) await sleep(150);
      if (this.closed || !this.pc || this.ui.lessonDone || this.lessonStep !== 0) return;
      this.interruptReply(); this.startLessonStep(1);
    } else this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: MY_READY(r) }] } });
  }
  /** 교재를 읽지 못함(교재가 아니거나 흐림): 선생님이 짧게 사과·안내하고 인사한 뒤 마친다. */
  async myPlanFailed(reason) {
    const L = this.lesson; if (!L?.my || this.closed) return;
    L.pending = false; L.failed = reason || "사진에서 교재 내용을 찾지 못했어요."; this.log("my_failed", {});
    this.set({ myReady: Date.now() });
    if (!this.pc || this.ui.lessonDone) return;
    for (let w = 0; this.resp && w < 15000; w += 150) await sleep(150);
    this.interruptReply(); this.myFailNoted = true; this.sysNote(MY_FAILED);
  }
  moveOn(why) {
    const L = this.lesson; if (!L) return;
    if (this.myWait(why)) return;
    this.log("lesson_part_done", { step: this.lessonStep, why });
    this.doneHeld = null; this.sceneGen++; this.sceneIntro = null; this.interruptReply(); this.player.stop();
    const n = this.lessonStep + 1;
    if (n < L.steps.length) this.startLessonStep(n); else this.endWithGoodbye(this.stepLog.slice(), this.lessonGen);
  }

  /** ‘넘어가기’ 단추(0.8.2): 앱이 직접 다음 부분으로 넘긴다. 예전엔 선생님에게 넘어가자는 말만 보내 같은 부분을 더 하게 됐다. */
  skipStep() {
    const L = this.lesson; if (!L || this.closed || !this.pc || this.ui.lessonDone || this.lessonStep < 0) return;
    if (!this.appLed) { this.sendText("Let's move on to the next part, please."); return; }
    if (this.myWait("skip")) return;
    this.log("lesson_skip", { step: this.lessonStep });
    this.sceneGen++; this.sceneIntro = null; this.interruptReply(); this.player.stop();
    if (this.ui.lessonScene) this.set({ lessonScene: false, lessonHiLine: -1 });
    const n = this.lessonStep + 1;
    if (n < L.steps.length) this.startLessonStep(n); else this.endWithGoodbye(this.stepLog.slice(), this.lessonGen);
  }

  /** ‘천천히 다시’ 단추(0.8.2): 방금 한 말을 한 번 더, 이번 한 번만 느리게. 학습자 말로 기록하지 않는다. */
  slowAgain() {
    if (!this.lesson || this.closed || !this.pc || this.ui.lessonScene || this.ui.lessonDone) return;
    this.interruptReply(); this.slowOnce = true;
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: "(App: the learner tapped the slowly-again button. Say your last sentence again, word for word, and add nothing else.)" }] } });
    this.send({ type: "response.create" }); this.set({ state: "thinking" });
    this.log("lesson_slow", { step: this.lessonStep });
  }

  /** 마지막 부분이 끝남: 작별 인사가 없었으면 한 번 청한 뒤 마친다. */
  async endWithGoodbye(lines, gen) {
    if (!GOODBYE.test(lines.filter((l) => l.who === "teacher").map((l) => l.text).join(" ")) && !this.byeAsked) {
      this.byeAsked = true; this.log("lesson_bye_asked", {});
      this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: "The class is ending now. Say goodbye in two or three short sentences: react to what the learner last said, praise one specific thing they did today, and say a warm goodbye." }] } });
      this.send({ type: "response.create" }); this.set({ state: "thinking" });
      for (let w = 0; !this.resp && w < 4000; w += 100) await sleep(100);
      for (let w = 0; (this.player.isPlaying || this.resp) && w < 15000; w += 150) await sleep(150);
      if (this.closed || !this.pc || gen !== this.lessonGen) return;
    }
    this.finishLesson([], []);
  }

  /** lesson-check 한 번(실패하면 한 번 더). */
  async checkLesson(step, lines, at) {
    let chk = await api.lessonCheck(appTeach(step.teach), lines, this.sessionId, at, "app");
    if (chk.failed) chk = await api.lessonCheck(appTeach(step.teach), lines, this.sessionId, at, "app");
    return chk;
  }

  /** 0.8.2 선생님 대답의 글이 다 나오면(소리가 나가는 동안) 확인을 미리 시작한다. 들려준 말이 그 글과 같으면 lessonAfterReply가 이 결과를 쓴다(부분 사이 정적을 줄임). */
  lessonPrecheck(r) {
    if (!this.lesson || !this.appLed || this.story || r.precheck || this.ui.lessonDone || this.sceneIntro) return;
    const at = this.lessonStep, step = this.lesson.steps?.[at];
    if (!step || isRolePlay(step)) return;
    const text = r.text.trim();
    const learnerTurns = this.stepLog.filter((l) => l.who === "learner").length;
    if (!text || !(learnerTurns > 0 || step.type === "done") || /\?["”’]?\s*$/.test(text) || /_{2,}/.test(text)) return;
    const p = this.checkLesson(step, [...this.stepLog, { who: "teacher", text }], at); p.catch(() => {});
    r.precheck = { at, text, said: this.lessonSaid, p };
  }

  /** 학습자가 말하는 중이면 넘기지 않는다(넘기면 새 부분의 첫 말이 끊기거나 장면 위에 대답이 겹쳤다). 그 말에 선생님이 답한 뒤 다시 확인된다. 말이 아니었으면(잡음) 6초 뒤 again을 부른다. */
  holdForSpeech(again, since = Infinity) {
    if (!this.ui.speech && !((this.lastSpeechStart ?? 0) > since)) return false;
    const gen = this.lessonGen, at = this.lessonStep, said = this.lessonSaid;
    this.log("lesson_move_held", { step: at });
    setTimeout(() => {
      if (this.closed || !this.pc || gen !== this.lessonGen || at !== this.lessonStep || this.lessonSaid !== said || this.resp || this.ui.speech || this.player.isPlaying || this.ui.lessonDone) return;
      this.armIdle(); again();
    }, 6000);
    return true;
  }

  async runLessonTool(c) {
    // 0.9 헤니 검토: 같은 호출은 한 번만, 멈춘 뒤 늦게 끝난 작업은 진도·단계를 건드리지 않는다
    this.handledCalls ??= new Set();
    if (c.callId && this.handledCalls.has(c.callId)) return;
    if (c.callId) this.handledCalls.add(c.callId);
    const gen = this.lessonGen;
    const stale = () => this.closed || !this.pc || gen !== this.lessonGen;
    if (stale()) return;
    let a = {}; try { a = JSON.parse(c.args || "{}") ?? {}; } catch { /* */ }
    // 0.8.2: 앱이 넘기는 방식에서는 선생님에게 이 도구가 없다. 그래도 불렀으면 아무것도 하지 않는다(옛 경로로 넘기거나 끝내지 않게).
    if (this.appLed && (c.name === "next_step" || c.name === "finish_session")) {
      this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.callId, output: '{"ok":false}' } });
      this.log("lesson_stray_tool", { name: c.name }); return;
    }
    const reply = (create) => {
      this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.callId, output: '{"ok":true}' } });
      if (create) { this.send({ type: "response.create" }); this.set({ state: "thinking" }); }
    };
    const waitQuiet = async () => { for (let w = 0; (this.player.isPlaying || this.resp) && w < 15000; w += 150) await sleep(150); };
    if (c.name === "highlight_line") { this.set({ lessonHiLine: (parseInt(a.line, 10) || 0) - 1 }); reply(!c.withText); }
    else if (c.name === "highlight_word") { this.set({ lessonHiWord: String(a.word ?? "").trim() || null }); reply(!c.withText); }
    else if (c.name === "next_step") {
      reply(false); await waitQuiet(); if (stale()) return;
      // 11/18 가상 수업 시험: 넘기기 전에 ‘이 부분을 다 했는지’ 확인한다(lesson-check). 빠진 게 있으면 화면을 잡아 두고
      // 그것만 하게 한다(부분마다 2번까지). 선생님은 그 뒤 스스로 next_step을 다시 부른다.
      if ((this.stepHolds ?? 0) < 2) {
        const at = this.lessonStep, step = this.lesson.steps[at];
        const lines = this.ui.lines.filter((l) => (l.seq ?? 0) >= (this.stepLineAt ?? 0)).map((l) => ({ who: l.role === "user" ? "learner" : "teacher", text: l.text }));
        const chk = lines.some((l) => l.who === "learner") ? await api.lessonCheck(step?.teach ?? "", lines, this.sessionId, at) : { complete: true };
        if (stale() || this.lessonStep !== at) return;
        if (!chk.complete && chk.fix) {
          this.stepHolds = (this.stepHolds ?? 0) + 1; this.log("lesson_step_held", { step: at, fix: String(chk.fix).slice(0, 200) });
          this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text",
            text: `Before the screen changes: ${chk.fix} Do it now, in your own natural words, without announcing it. If you ask the learner something, wait for the answer. When this part is finished and you are not waiting for an answer, call next_step at the end of that same reply. Do not start the next part before you call next_step.` }] } });
          this.send({ type: "response.create" }); this.set({ state: "thinking" }); this.openMic();
          return;
        }
      }
      const n = this.lessonStep + 1;
      if (n >= this.lesson.steps.length) this.finishLesson([], []); else this.startLessonStep(n);
    } else if (c.name === "finish_session" && this.lessonStep + 1 < this.lesson.steps.length) {
      // 11/18 가상 수업 시험: 마지막 부분 전에 끝내려 하면(학습자가 그만하자고 한 게 아니면) 끝내지 않고 이어 가게 한다
      this.log("lesson_early_finish", { step: this.lessonStep });
      this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: c.callId, output: '{"ok":false}' } });
      this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text",
        text: `The lesson is not over: this is part ${this.lessonStep + 1} of ${this.lesson.steps.length}. Do not say goodbye. Finish this part with the learner, then call next_step. If the learner clearly asked to stop, say warmly that they can end today's class with the end button.` }] } });
      this.send({ type: "response.create" }); this.set({ state: "thinking" });
    } else if (c.name === "finish_session") {
      reply(false); await waitQuiet(); if (stale()) return;
      // 11/18: 작별 인사 없이 끝내려 하면 한 번 인사하게 한 뒤 끝낸다
      if (!GOODBYE.test((c.r?.played ?? []).join(" ")) && !this.byeAsked) {
        this.byeAsked = true; this.log("lesson_bye_asked", {});
        this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: "Before the class ends you still need to say goodbye. Say it now in two or three short sentences: react to what the learner last said, praise one specific thing they did today, and say a warm goodbye. Do not call any tool." }] } });
        this.send({ type: "response.create" }); this.set({ state: "thinking" });
        for (let w = 0; !this.resp && w < 4000; w += 100) await sleep(100);
        await waitQuiet(); if (stale()) return;
      }
      this.finishLesson(Array.isArray(a.practiced) ? a.practiced.map(String) : [], Array.isArray(a.fixed) ? a.fixed.map(String) : []);
    }
  }

  /** 0.9.12 앱이 넘기기: 선생님 대답이 다 나온 뒤, 기다리는 질문이 아니면 lesson-check로 이 부분을 다 했는지 본다.
   *  다 했으면 다음 부분(마지막이면 작별 인사 확인 뒤 마침), 빠진 게 있으면 그것만 하게 한다(부분마다 3번까지).
   *  0.8.2(11/19 Fable 검토): 수업 기록은 stepLog로(화면 자막에서 뽑으면 늦게 온 전사에 선생님 말이 잘렸음), 학습자가 말하는 중이면 넘기지 않음,
   *  확인 실패·빈 지시·붙잡기 3번 뒤에도 수업이 멈추지 않게, 학습자 말 12번이면 먼저 마무리를 청함. */
  async lessonAfterReply(r) {
    const L = this.lesson, at = this.lessonStep, step = L?.steps?.[at];
    if (!step || this.ui.lessonDone || this.ui.lessonScene) return;
    if (L.failed) { if (this.myFailNoted) this.finishLesson([], []); return; }   // 0.8.6 내 교재를 읽지 못함: 선생님 인사 뒤 마침
    const gen = this.lessonGen, saidBefore = this.lessonSaid, t0 = Date.now();
    const lines = this.stepLog.slice();
    const learnerTurns = lines.filter((l) => l.who === "learner").length;
    const last = (r.played ?? []).join(" ").trim();
    if (isRolePlay(step) && this.rp?.step === at) { this.rolePlayAfterReply(step, last, lines); return; }
    if (!last || !(learnerTurns > 0 || step.type === "done") || /\?["”’]?\s*$/.test(last)) return;
    const pre = r.precheck;
    const chk = await (pre && pre.at === at && pre.text === last && pre.said === saidBefore ? pre.p : this.checkLesson(step, lines, at));
    // 그사이 학습자가 말했거나 선생님이 다시 말하기 시작했으면 이 확인은 버린다.
    // 0.8.5: 다만 ‘다 했음’이었으면 기억해 두고, 학습자가 짧게만 답하면(lessonHeard) 바로 넘긴다.
    const okDone = !chk.failed && chk.complete && !chk.waiting;
    const keep = () => { if (okDone && gen === this.lessonGen && at === this.lessonStep && !this.ui.lessonDone) this.doneHeld = { at, gen }; };
    if (this.closed || !this.pc || gen !== this.lessonGen || at !== this.lessonStep || this.lessonSaid !== saidBefore || this.resp || this.ui.lessonDone) { keep(); return; }
    if (this.holdForSpeech(() => this.lessonAfterReply(r), t0)) { keep(); return; }
    const sys = (text) => { this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } }); this.send({ type: "response.create" }); this.set({ state: "thinking" }); };
    const capped = learnerTurns >= 12;
    if (chk.failed) {
      this.checkFails = (this.checkFails ?? 0) + 1; this.log("lesson_check_failed", { step: at, n: this.checkFails });
      if (learnerTurns < 6 && this.checkFails <= 3) { sys(CONTINUE_NOTE); return; }
    } else {
      if (chk.waiting && !capped) return;
      if (!chk.complete && capped && !this.wrapAsked) { this.wrapAsked = true; this.log("lesson_wrap_asked", { step: at }); sys(WRAP_NOTE); return; }
      if (!chk.complete && !capped && (this.stepHolds ?? 0) < 3) {
        this.stepHolds = (this.stepHolds ?? 0) + 1;
        const fix = chk.fix || "Go on with what is left in this part.";
        this.log("lesson_step_held", { step: at, fix: String(fix).slice(0, 200) });
        sys(`This part is not finished yet: ${fix} Do it now, in your own natural words, without announcing it.`); return;
      }
    }
    if (this.myWait("check_done")) return;
    this.log("lesson_part_done", { step: at, forced: !chk.complete });
    if (at + 1 < L.steps.length) { this.startLessonStep(at + 1); return; }
    await this.endWithGoodbye(lines, gen);
  }

  /** 0.9.13 역할 읽기 진행(선생님 대답이 다 나온 뒤). 선생님 줄을 들었으면 다음 자리로, 학습자 줄 차례면 기다리게, 다 읽었으면 짧은 칭찬 뒤 다음 부분.
   *  0.8.2(11/19 Fable 검토 1-3·1-4·1-5): ‘다시’ 횟수를 이 자리에서 학습자가 말한 횟수로 센다(예전엔 선생님 대답 수라 “다시 해 보세요” 직후 선생님이 자기 줄을 읽었음),
   *  마지막 줄에서 선생님이 다시 청했으면 기다린다, 줄 판정은 순서대로 이어진 낱말로(role 규칙은 파일 아래쪽). */
  rolePlayAfterReply(step, said, lines = []) {
    const L = this.lesson, at = this.lessonStep, rp = this.rp, plan = rolePlan(step.teach);
    const sys = (text, now) => { this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } }); if (now) { this.send({ type: "response.create" }); this.set({ state: "thinking" }); } };
    const done = () => { if (this.holdForSpeech(done)) return; this.log("lesson_part_done", { step: at, roleplay: true }); if (at + 1 < L.steps.length) this.startLessonStep(at + 1); else this.finishLesson([], []); };
    const mine = lines.filter((l) => l.who === "learner"), n = mine.length;
    if (rp.comment) { done(); return; }   // 마지막 칭찬까지 끝남
    if (rp.final) {
      if (n <= (rp.finalAt ?? 0)) return;
      const lastL = plan[plan.length - 1], since = mine.slice(rp.finalAt ?? 0);
      const ok = since.some((l) => learnerSaid(l.text, lastL.en));
      if (!asksAgain(said, lastL.en)) {
        // 선생님이 마무리 말을 했다. 학습자가 마지막 줄을 아예 안 했으면 한 번 청하게 한다.
        if (ok || since.length >= 2 || rp.finalNudged) { done(); return; }
        rp.finalNudged = true; this.rpHighlight(plan, plan.length - 1); sys(ROLE_LAST_NOTE(lastL), true); return;
      }
      // 선생님이 다시 청했다: 학습자 말을 기다린다. 두 번 해 봤으면 칭찬하고 마친다.
      if (since.length >= 2 || n >= 16) { rp.comment = true; sys(ROLE_DONE_NOTE, true); }
      return;
    }
    const before = rp.next;
    rp.next = roleAdvance(plan, rp.next, said);
    if (rp.next !== before || !said) {
      if (rp.next !== before) { rp.at = n; rp.warned = false; }
      const note = roleNote(plan, rp.next, false);
      if (note.comment) rp.comment = true;
      if (note.final) { rp.final = true; rp.finalAt = n; }
      // 화면: 다음에 말할 줄을 밝힌다(학습자 줄이면 그 줄, 아니면 선생님이 읽을 줄)
      const lastYou = plan.slice(0, rp.next).map((l) => l.who).lastIndexOf("you");
      const nextLearner = plan.findIndex((l, i) => i > lastYou && l.who === "learner");
      this.rpHighlight(plan, nextLearner !== -1 && (rp.next >= plan.length || nextLearner < rp.next) ? nextLearner : rp.next);
      sys(note.note, note.respondNow);
      return;
    }
    // 제자리: 선생님이 학습자에게 다시 청했거나 다른 말을 했다
    const tried = n - (rp.at ?? 0);
    if ((tried >= 3 || n >= 16) && rp.next < plan.length) { rp.at = n; rp.warned = false; this.rpHighlight(plan, rp.next); sys(ROLE_FORCE_NOTE(plan[rp.next]), true); return; }
    if (tried >= 1 && !rp.warned) { rp.warned = true; sys(ROLE_RETRY_NOTE(plan[rp.next]), false); }
  }
  rpHighlight(plan, idx) { if (idx >= 0 && idx < plan.length) this.set({ lessonHiLine: plan[idx].n - 1 }); }

  finishLesson(practiced, fixed) {
    const L = this.lesson; if (!L || this.ui.lessonDone || this.closed || !this.pc) return;
    const minutes = Math.max(1, Math.round((Date.now() - (this.lessonStartedAt || Date.now())) / 60000));
    const done = { practiced: practiced.length ? practiced : L.expressions.slice(0, 5), fixed, minutes, said: this.lessonSaid };
    this.onLessonDone?.(L);
    this.set({ lessonDone: done });
    this.log("lesson_done", { lesson: L.id, session: L.session, minutes, said: this.lessonSaid });
    const g = this.lessonGen; setTimeout(() => { if (g === this.lessonGen && this.pc) this.stopInternal("USER_STOP", null); }, 600);
  }

  // ---------------- 이용 시간 ----------------
  startMeter() {
    clearInterval(this.meter); this.lastMeter = Date.now();
    this.meter = setInterval(() => this.flushMeter(), 30000);
  }
  async flushMeter() {
    if (!this.lastMeter) return;
    const now = Date.now(); const sec = Math.min(60, Math.round((now - this.lastMeter) / 1000)); this.lastMeter = this.pc ? now : 0;
    if (sec <= 0) return;
    const u = await api.addActiveSeconds(sec, PRESET); if (!u) return;
    this.updateRemaining(u.today_seconds, u.limit_seconds);
    if (u.limit_seconds > 0 && u.today_seconds >= u.limit_seconds && this.pc) { this.limitReached = true; if (this.lessonHold || (!this.player.isPlaying && !this.resp)) this.afterFriendFinished(); }
  }
  updateRemaining(today, limit) {
    if (!limit || limit <= 0) return;
    const left = limit - today;
    this.set({ remainingMinutes: left > 0 && left <= 300 ? Math.ceil(left / 60) : null });
  }

  // ---------------- 멈춤·종료 ----------------
  stop() { this.stopInternal("USER_STOP", null); }
  pauseForBackground() {
    // 0.9 헤니 검토: 연결하는 중(pc가 생기기 전)에 화면을 나가도 늦은 연결이 이어지지 않게 끊는다
    if ((this.pc || this.ui.state === "connecting") && !this.cameraHold) this.stopInternal("APP_BACKGROUND", "대화를 멈췄어요. 이어서 하려면 다시 시작을 눌러 주세요.");
  }
  lost() { if (this.pc) { this.stopInternal("NETWORK", "인터넷 연결이 끊겼어요. 연결을 확인한 뒤 다시 시작을 눌러 주세요."); this.set({ state: "disconnected" }); } }

  stopInternal(reason, notice) {
    this.connGen++; this.sceneGen++; this.lessonGen = (this.lessonGen ?? 0) + 1;
    if (this.ui.lessonScene) this.set({ lessonScene: false, lessonHiLine: -1 });   // 진행 중인 연결이 있으면 끝나는 대로 버린다
    this.player.stop(); this.player.duck(false);
    if (this.resp) { this.epoch++; this.finishReply(this.resp, false); this.resp = null; }
    clearTimeout(this.idleTimer); clearTimeout(this.softTimer); this.soft = false;
    this.flushMeter(); clearInterval(this.meter);
    this.lessonHold = false; this.privateTopic = false; this.onStopped?.(reason);
    this.teardown();
    this.set({ state: "stopped", micOn: false, canRestart: true, speech: false, notice });
    this.log("stop", { reason });
  }

  teardown() {
    try { this.dc?.close(); } catch { /* */ }
    try { this.pc?.close(); } catch { /* */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.dc = null; this.pc = null; this.stream = null; this.track = null;
    this.lessonItems.clear();
  }

  // ---------- 0.8.4 처음 이야기(레벨 확인) ----------
  placementHeard(t) {
    this.plLog.push({ who: "learner", text: t });
    if (this.plWrap) return;
    if (placementDone(placementAnswers(this.plLog), Date.now() - this.plStart)) this.placementWrap();
  }
  /** 마무리: 학습자 말에 막 시작한 대답은 멈추고, 선생님에게 짧은 마무리 인사만 청한다. 그동안 마이크는 끈다. */
  placementWrap() {
    if (this.plWrap || this.closed) return;
    this.plWrap = "asked";
    if (this.track) this.track.enabled = false;
    this.set({ micOn: false });
    if (this.resp && !this.resp.done) this.interruptReply();
    this.send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: PLACEMENT_WRAP }] } });
    this.send({ type: "response.create" }); this.set({ state: "thinking" });
    this.log("placement_wrap", { turns: this.plLog.filter((l) => l.who === "learner").length, ms: Date.now() - this.plStart });
    // 마무리 인사가 오지 않아도 끝낸다
    this.plWrapTimer = setTimeout(() => this.placementFinish(), 15000);
  }
  placementReplied(r, played, complete) {
    if (played) this.plLog.push({ who: "teacher", text: played });
    if (this.plWrap === "speaking" && r.id === this.plWrapRid) { this.plWrap = "done"; setTimeout(() => this.placementFinish(), 600); return; }
    // 6분이 넘으면 다음 대답 뒤에 끝낸다(학습자가 말을 안 해도)
    if (!this.plWrap && complete && Date.now() - this.plStart > 360000) this.placementWrap();
  }
  placementFinish() {
    clearTimeout(this.plWrapTimer);
    if (this.plFinished) return; this.plFinished = true;
    this.onPlacementDone?.(this.plLog.slice());
  }

  async close() {
    if (this.closed) return;
    this.closed = true; this.connGen++;
    this.stopInternal("SESSION_END", null);
    if (this.sessionId) await api.finishSession(this.sessionId);
  }
}

const LESSON_TOOLS = new Set(["next_step", "highlight_line", "highlight_word", "finish_session"]);
// 0.8.4 처음 이야기: 끝내기 규칙(안드로이드 LessonGuard·가상 시험기 placement-sim과 같음). 학습자가 10번 말했거나 5분, 또는 4번 말하는 동안 영어가 거의 없으면(한 번에 평균 두 낱말 미만) 일찍 끝낸다.
/** 0.8.5(11/19 실장님 처음 이야기: 대답 6~7번 만에 끝남): 선생님 말 사이에 한 말은 한 대답으로 묶고,
 *  질문이 없던 선생님 말 뒤의 짧은 맞장구(Yeah. Okay.)는 세지 않는다. */
export function placementAnswers(log) {
  // 맞장구는 바로 앞 선생님 말에 물음표가 없을 때만 뺀다(질문에 yes로 답한 건 대답이다)
  const groups = []; let prevT = null, g = null;
  for (const l of log) {
    if (l.who === "teacher") { if (g) { groups.push(g); g = null; } prevT = l.text; continue; }
    if (!g) g = { text: l.text, asked: prevT === null || /\?/.test(prevT) }; else g.text += " " + l.text;
  }
  if (g) groups.push(g);
  return groups.filter((x) => x.asked || !isAck(x.text)).map((x) => x.text);
}
export function placementDone(learnerTexts, elapsedMs) {
  const n = learnerTexts.length;
  if (n >= 10 || elapsedMs >= 300000) return true;
  if (n >= 4) { const en = learnerTexts.join(" ").match(/[A-Za-z']{2,}/g)?.length ?? 0; if (en / n < 2) return true; }
  return false;
}
// 0.8.5(11/19 실장님 수업 소감): 고친 문장을 따라 하게 더 자주, 선생님이 한꺼번에 길게 말하지 않게
export const WARMUP_NOTE = "During this warm-up, never correct the learner's English, never ask them to repeat or say anything after you, and ask only one question per turn. Keep each turn to two short sentences.";
export const TURN_NOTE = "Keep every turn short (two or three short sentences). Until everything in this part is done, end each turn by giving the learner one thing to say or answer. When you fix a sentence the learner said, also in small talk, ask them to say the fixed sentence once right away (not next time), then react and go on.";
export const PLACEMENT_WRAP = "(App: time is up. In one or two short sentences, thank the learner warmly for the chat and say a friendly see-you-soon. Ask no question and do not talk about what comes next.)";
// 11/18 김연경님 시험: 수업 선생님이 ‘답할게요, 그다음 넘어가요’처럼 예고만 하고 바로 다음 단계로 넘어가 약속한 말이 빠짐(8번).
// 지시문으로 막고, 그래도 나온 예고 문장은 소리·자막으로 내지 않는다(수업에서만).
const PREAMBLE = [
  /\b(then|and then|and)\s+(we['’]?ll|we will|let['’]?s|i['’]?ll|i will)\s+(move on|move along|continue|keep going|go on|go to the (next|last)|do the next|wrap|finish|say goodbye)/i,
  /\b(and|then)\s+(go|move)\s+(on\s+)?to the (next|last)\b/i,
  /\b(and then|then)\s+(move on|move along|keep going|continue)\b/i,
  /^(ok(ay)?,?\s+|alright,?\s+|now,?\s+)?(let me|i['’]?ll|i will)\s+(answer|respond|reply|move (us|on)|take us)\b/i,
  /\blet me (think|wrap|confirm|respond|answer|reply)\b/i,
  /^let['’]?s (finish|do) (this|the) last one\b/i,
  /\bmove us (to|on|forward|along)\b/i,
];
export const isPreamble = (s) => PREAMBLE.some((re) => re.test(String(s).trim()));
// 0.9.13 역할 읽기를 앱이 한 줄씩 진행(가상 수업 시험에서 선생님이 학습자 줄을 읽거나 끝까지 안 함). 수업 계획의 대사 목록을 읽어
// 대답마다 ‘이 줄을 그대로 읽어요 / 학습자 줄을 기다렸다가 짧게 반응하고 다음 줄’을 알려 주고, 들은 말에서 선생님 줄을 찾아 진도를 센다.
// 아래 규칙은 가상 수업(lesson-sim role.ts)·안드로이드(LessonGuard.kt)와 같다. 고치면 세 곳을 함께 고친다.
export const rolePlan = (teach) => [...String(teach ?? "").matchAll(/^(\d+)\. (.+?) \((you|learner)\): "(.*)"/gm)]
  .map((m) => ({ n: Number(m[1]), name: m[2], who: m[3], en: m[4] }));
/** 0.8.5: 짧은 맞장구(넘어가도 되는 대답)와 ‘다음으로’ 요청 */
const ACK_RE = /^(ok(ay)?|yes|yeah|yep|yup|sure|right|alright|all right|good|great|nice|cool|thank you|thanks|got it|i see|i got it|uh-?huh|mm+|hmm+|oh|ah|네|넵|예|응|좋아요|알겠어요|알았어요|감사합니다|고마워요)$/;
export const isAck = (t) => { const s = String(t).toLowerCase().replace(/[^\p{L}\p{N}' -]/gu, " ").replace(/\s+/g, " ").trim(); if (!s) return false;
  const parts = s.split(/ (?=ok|okay|yes|yeah|thank|thanks|good|great|got|sure|right)/); return s.split(" ").length <= 5 && parts.every((p) => ACK_RE.test(p.trim())); };
export const asksNext = (t) => { const s = String(t).toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, " ").replace(/\s+/g, " ").trim();
  if (/^(다음|다음으로|넘어가|넘어가요|넘어가 주세요|넘겨|넘겨 주세요|다음 거|다음 화면|다음으로 가요|다음 부분)( (요|주세요|해 주세요))?$/.test(s)) return true;
  const w = s.split(" ").filter(Boolean); if (!w.length || w.length > 6) return false;
  return (w.includes("next") || /move on/.test(s)) && w.every((x) => /^(next|please|screen|part|page|step|one|let's|lets|go|move|on|the|to|ok|okay|yes|now|go to)$/.test(x)); };
export const isRolePlay = (st) => st?.type === "dialogue" && !st.play && rolePlan(st.teach).length > 0;
export const rpWords = (t) => String(t).toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' -]/g, " ").split(/[\s-]+/).filter(Boolean);
const FILLER = new Set(["ha", "haha", "oh", "ah", "hmm", "um", "uh", "wow", "well", "hey", "aw", "ooh", "so"]);
/** sw 안에서 줄(lw)이 순서대로 이어져 들어 있는 자리 [시작, 끝). 낱말이 need개 이상 순서대로 맞아야 한다. 없으면 null */
export function findLine(sw, lw, need) {
  if (!lw.length || need <= 0) return null;
  for (let i = 0; i < sw.length; i++) {
    if (sw[i] !== lw[0] && sw[i] !== lw[1]) continue;
    let k = 0, hit = 0, end = i;
    for (let j = i; j < sw.length && j < i + lw.length + 3 && k < lw.length; j++) {
      const at = lw.indexOf(sw[j], k);
      if (at !== -1 && at - k <= 2) { hit++; k = at + 1; end = j + 1; }
    }
    if (hit >= need) return [i, end];
  }
  return null;
}
const needFor = (n, min) => (n <= 3 ? n : Math.ceil(n * min));
/** 선생님 말(said)에 이 줄이 들어 있나. 낱말만 세지 않고 순서대로 이어진 것만(80%, 세 낱말 이하면 모두). 두 낱말 이하 줄(No. / Why?)은 그 말만으로 된 문장이어야 한다. */
export function saidLine(said, line) {
  const lw = rpWords(line); if (!lw.length) return false;
  if (lw.length <= 2) return shortSaid(said, line);
  return findLine(rpWords(said), lw, needFor(lw.length, 0.8)) !== null;
}
const sentWords = (t) => String(t).split(/[.!?…]+/).map((x) => rpWords(x).join(" ")).filter(Boolean);
/** 짧은 줄(No. / Forty? Why?): 그 말만으로 된 문장(들)이 이어서 나와야 한다 */
function shortSaid(said, line) {
  const a = sentWords(said), b = sentWords(line);
  for (let i = 0; i + b.length <= a.length; i++) if (b.every((x, k) => a[i + k] === x)) return true;
  return false;
}
/** 학습자가 자기 줄을 말했나(받아쓰기라 느슨하게): 감탄사는 빼고 60% 이상 순서대로 */
export function learnerSaid(text, line) {
  const drop = (w) => w.filter((x) => !FILLER.has(x));
  const lw0 = rpWords(line), lw = drop(lw0).length ? drop(lw0) : lw0, sw = drop(rpWords(text));
  return findLine(sw, lw, needFor(lw.length, 0.6)) !== null;
}
/** 선생님 대답을 보고 자리를 옮긴다. next = 아직 안 읽은 선생님 줄의 자리(다 읽었으면 plan.length).
 *  직전 학습자 줄을 선생님이 대신 들려준 부분은 빼고 본다(1-1: 학습자 8번 줄 “Thanks! See you later!” 안에 선생님 9번 줄이 들어 있음).
 *  이어지는 선생님 줄(5·6번)을 한 대답에 읽었으면 한꺼번에 넘긴다. */
export function roleAdvance(plan, next, said) {
  if (next >= plan.length || !String(said ?? "").trim()) return next;
  let text = String(said);
  const lastYou = plan.slice(0, next).map((l) => l.who).lastIndexOf("you");
  const tw = rpWords(plan[next].en);
  for (const l of plan.slice(lastYou + 1, next)) {
    if (l.who !== "learner") continue;
    const lw = rpWords(l.en); if (lw.length < 2) continue;
    // 선생님 줄이 그 학습자 줄 안에 들어 있을 때만 지운다(거꾸로 선생님 줄이 학습자 말을 받아 되풀이하는 장면이 많다: 1-7, 5-14)
    if (!findLine(lw, tw, needFor(tw.length, 0.8))) continue;
    // 따옴표로 들려준 학습자 줄을 낱말 자리로 찾아 지운다
    const parts = text.split(/(\s+)/); const idx = []; const sw = [];
    parts.forEach((p, pi) => { for (const w of rpWords(p)) { sw.push(w); idx.push(pi); } });
    const span = findLine(sw, lw, needFor(lw.length, 0.8));
    if (span) { for (let pi = idx[span[0]]; pi <= idx[span[1] - 1]; pi++) parts[pi] = pi === idx[span[0]] ? " . " : ""; text = parts.join(""); }
  }
  let at = next;
  while (at < plan.length && plan[at].who === "you") {
    const lw = rpWords(plan[at].en);
    if (lw.length <= 2) { if (!saidLine(text, plan[at].en)) break; }
    else {
      const parts = text.split(/(\s+)/); const idx = []; const sw = [];
      parts.forEach((p, pi) => { for (const w of rpWords(p)) { sw.push(w); idx.push(pi); } });
      const span = findLine(sw, lw, needFor(lw.length, 0.8));
      if (!span) break;
      text = parts.slice(idx[span[1] - 1] + 1).join("");
    }
    at++;
  }
  if (at === next) return next;
  const nx = plan.findIndex((l, i) => i >= at && l.who === "you");
  return nx === -1 ? plan.length : nx;
}
/** 선생님이 학습자에게 (다시) 말해 보라고 청하는 대답인가 */
export const asksAgain = (said, line) => /\?["”’]?\s*$/.test(String(said).trim()) || saidLine(said, line)
  || /\b(your turn|try (it |that |this |the line )?(again|once more|one more time)|once more|one more time|say (it|that|the line|your line)|give it (a|another) try|now you)\b|다시|말해 보세요|해 보세요|차례/i.test(String(said));
const lineQ = (l) => `line ${l.n} (${l.name}): "${l.en}"`;
/** 역할 읽기 다음 할 일(선생님에게 줄 메모). next = 아직 안 읽은 선생님 줄의 자리(없으면 plan.length) */
export function roleNote(plan, next, first) {
  const partners = [...new Set(plan.filter((l) => l.who === "you").map((l) => l.name))];
  const partner = partners.length ? partners.join(" and ") : "the other person";
  const me = plan.find((l) => l.who === "learner")?.name ?? "Jiwoo";
  const head = first ? `Role reading of the scene on screen: the learner is ${me} and you are ${partner}. Say in one short sentence that they will be ${me} and you will read ${partner}. Do not call highlight_line; the app highlights the lines. ` : "";
  const tIdx = plan.findIndex((l, i) => i >= next && l.who === "you");
  const from = first ? 0 : plan.slice(0, next).map((l) => l.who).lastIndexOf("you") + 1;
  const learnerBefore = plan.slice(from, tIdx === -1 ? plan.length : tIdx).filter((l) => l.who === "learner");
  const slips = "Small slips, a missing Oh or Ha, or leaving out a short part of a long line are fine.";
  if (tIdx === -1) {
    if (learnerBefore.length) return { note: head + `Now wait for the learner to say their last ${learnerBefore.length > 1 ? "lines" : "line"}, ${learnerBefore.map(lineQ).join(", then ")}. ${slips} Only if they say just a word or two of it, or something else, say the line once for them and ask them to try it (one retry only), and stop there. When they have said it, give one short warm comment on how they did, with no question.`, respondNow: first, final: true };
    return { note: head + "All the lines are done. Give one short warm comment on how they did, with no question.", respondNow: true, comment: true };
  }
  const t = plan[tIdx];
  if (!learnerBefore.length) return { note: head + `${first ? "Then" : "Now"} read ${lineQ(t)} once, exactly as written, word for word, and nothing after it.`, respondNow: true };
  return { note: head + (first ? `Then ask them to start with their line ${learnerBefore[0].n} on screen, without saying it for them, and stop there. ` : `Now wait for the learner to say ${learnerBefore.map(lineQ).join(", then ")}. `)
    + `When they have said it, read your next line, ${lineQ(t)}, right away, once, exactly as written, with nothing before or after it. ${slips} Only if they said just a word or two of it, or something else, do this instead: react to what they said in a few words, say their line once for them, ask them to try it, and stop there without reading your own line. After that one retry, read your next line whatever they say.`, respondNow: first };
}
export const ROLE_RETRY_NOTE = (l) => `(App: the learner will try their line once more. After that try, read your line ${l.n} right away, whatever they say. Do not ask them to repeat it again.)`;
export const ROLE_FORCE_NOTE = (l) => `Now read line ${l.n} (${l.name}): "${l.en}" once, exactly as written, with nothing before or after it. Do not ask the learner to repeat anything.`;
export const ROLE_LAST_NOTE = (l) => `The learner has not said their last line yet (line ${l.n}: "${l.en}"). Say that line once for them and ask them to say it. Add nothing else.`;
export const ROLE_DONE_NOTE = "All the lines are done. Do not ask the learner to repeat anything. Give one short warm comment on how they did, with no question.";
/** 역할 읽기에서 같은 문장을 한 대답 안에 또 말하려 하면 거른다(선생님이 자기 줄을 두 번씩 읽는 일이 있었음). 그 문장이 대사 한 줄 안에 실제로 두 번 나오면 그대로 둔다. */
export function roleRepeat(plan, seen, sentence) {
  const key = rpWords(sentence).join(" "); if (!key) return false;
  if (!seen.has(key)) { seen.add(key); return false; }
  return !plan.some((l) => l.who === "you" && sentWords(l.en).filter((x) => x === key).length >= 2);
}
// 0.8.2: 앱이 넘기는 방식에서는 예고 문장을 거의 지우지 않는다. 수업 자체를 말하는 문장(“Let me think…”, “keep us moving”, “the grammar step”)만 지운다. 질문·따옴표가 든 문장은 건드리지 않는다.
const META = [/^(ok(ay)?,?\s+|alright,?\s+|now,?\s+)?let me think\b/i, /\bkeep (us|things|it) moving\b/i, /\bmove us (to|on|forward|along)\b/i, /\b(the|this|next|grammar|last) step\b/i, /\bwhat comes next\b/i, /\blet me (respond|reply)\b/i,
  // 11/19 확인 수업 15회: 문법 부분을 열 때 진행 방식을 말함(“I’ll think through each point one by one…”, “Let’s talk through this…”, “I’ll keep this quick and practical…”)
  /\b(let me|i[’']ll|i will) think (about|through)\b/i, /\b(let me|i[’']ll|i will|let[’']s|we[’']ll) (just )?(walk|talk|work|go|run) (you |us )?through\b/i,
  /\b(i[’']ll|i will|let[’']s|we[’']ll) (keep|take) (this|it|things) (quick|simple|short|step by step|one by one)\b/i];
// 선생님용 메모가 말로 새는 문장(8985: “If they say "I am", respond: …”). 학습자를 3인칭으로 부르거나 도구 이름을 말하면 따옴표가 있어도 지운다.
const LEAK = [/\bthe learner\b/i, /\brespond:/i, /\b(next_step|finish_session|highlight_line|highlight_word)\b/i];
const LEAK_IF = /^\s*if they (say|answer|respond|give|get)\b/i;
/** 이 부분의 선생님 메모(화면 내용이 들어 있음) 안에 그 문장이 그대로 있나: 교재 대사·표현(“I’ll think about it.”, “Let me think…”)은 지우지 않는다 */
const inNotes = (teach, s) => { const w = rpWords(s); if (!w.length) return false; const tw = rpWords(teach);
  outer: for (let i = 0; i + w.length <= tw.length; i++) { for (let k = 0; k < w.length; k++) if (tw[i + k] !== w[k]) continue outer; return true; }
  return false; };
export const isMetaTalk = (s, teach = "") => { const t = String(s).trim();
  if (LEAK.some((re) => re.test(t))) return true;
  const hit = (LEAK_IF.test(t) && !t.includes("?")) || (!/[?"“”]/.test(t) && META.some((re) => re.test(t)));
  return hit && !inNotes(teach, t); };

const SCENE_INTRO = (title) => `The app is about to play a short scene from the textbook${title ? ` (${title})` : ""} in the characters' own voices. Say one short, natural sentence that leads into it and invites the learner to just listen. One sentence only, with no question.`;
const QUIET_NOTE = "(App: nobody has spoken for a while. If you asked the learner something, ask it again in simpler words or offer two choices. If you were not waiting for them, go on with the next thing in this part.)";
const CONTINUE_NOTE = "(App: go on with this part. Do the next thing in it with the learner; if everything in it is done, give one short reaction with no question.)";
const WRAP_NOTE = "(App: this part has taken long enough. Wrap it up now: one short, warm reaction to what the learner just said, with no new question.)";

// 0.9.12 앱이 넘기는 방식: 수업 계획 속 next_step 이야기(“Then call next_step.”, “What comes next …”)를 지운다
export const appTeach = (t) => String(t ?? "").split("\n").filter((l) => !/^What comes next/i.test(l.trim()))
  .map((l) => l
    // 0.9.13 조건은 남기고 next_step만 뺀다(0.9.12는 문장째 지워 ‘학습자가 대답하고 준비될 때까지’, ‘3문제 다’ 같은 조건이 사라졌음)
    .replace(/([.?!:])?\s*,?\s*\b(?:(?:and\s+)?then|and) call next_step\b\.?/gi, (_m, end) => end ?? ".")
    .replace(/\bCall next_step only after the learner has answered and seems ready\.?/i, "End with one short, friendly question asking if they are ready to start, and wait for their answer. This part is done only after the learner has answered and seems ready.")
    .replace(/\bCall next_step only (after|when|once)\b/gi, "This part is done only $1")
    .replace(/\b(When|After|Once)\b([^.\n]*?),\s*call next_step\b\.?/g, "$1$2, this part is done.")
    .replace(/(?:^|\s)[^.\n]*\b(?:next_step|finish_session)\b[^.\n]*\.?/g, "")   // 0.8.2: 마무리 부분의 finish_session 문장도 지운다
    .replace(/\s{2,}/g, " ").trimEnd()).join("\n").trim() || "Continue the lesson.";
// 0.8.2: next time·다음에는 뺐다(“Next time, try the full sentence.”를 작별 인사로 보고 바로 끝냈음)
const GOODBYE = /\b(good ?bye|bye|see you|take care|have a (good|great|nice|lovely))\b|안녕히|또 만나/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (x) => String(x ?? "").replace(/\{\{|\}\}|\*/g, "").trim();

/** 사진을 미리 받아 둔다(카드가 빈 채로 뜨지 않게). 8초 안에 못 받으면 실패. */
function preload(url) {
  return new Promise((ok) => {
    const img = new Image(); const t = setTimeout(() => ok(false), 8000);
    img.onload = () => { clearTimeout(t); ok(true); }; img.onerror = () => { clearTimeout(t); ok(false); };
    img.src = url;
  });
}

// 11/14 시험자 제보(아이폰 다른 브라우저에서 마이크 막힘): 막힌 까닭과 기기에 맞춰 고치는 방법을 알려 준다
function micHelp(e) {
  const ua = navigator.userAgent || "";
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const inApp = /KAKAOTALK|NAVER|Instagram|FBAN|FBAV|Line\//i.test(ua);
  const iosOther = ios && /CriOS|EdgiOS|FxiOS|OPiOS|Whale/i.test(ua);
  const tail = " 그동안은 아래에 글로 이야기할 수 있어요.";
  if (inApp) return "이 앱 안에서 연 화면에서는 마이크를 쓸 수 없어요. 오른쪽 위 메뉴에서 ‘다른 브라우저로 열기’를 눌러 " + (ios ? "사파리로" : "크롬으로") + " 열어 주세요." + tail;
  const name = e?.name ?? "";
  if (!navigator.mediaDevices || name === "TypeError") return "이 브라우저에서는 마이크를 쓸 수 없어요. " + (ios ? "사파리로" : "크롬으로") + " 열어 주세요." + tail;
  if (name === "NotFoundError" || name === "OverconstrainedError") return "마이크를 찾지 못했어요. 이어폰이나 마이크 연결을 확인하고 ‘다시 시작’을 눌러 주세요." + tail;
  if (name === "NotReadableError" || name === "AbortError") return "다른 앱이 마이크를 쓰고 있어요. 통화·녹음 앱을 끄고 ‘다시 시작’을 눌러 주세요." + tail;
  if (iosOther) return "마이크가 막혀 있어요. 아이폰 ‘설정’ 앱에서 이 브라우저를 찾아 ‘마이크’를 켜고, 이 화면을 새로고침해 주세요. 사파리로 열면 더 쉬워요." + tail;
  if (ios) return "마이크가 막혀 있어요. 주소창 왼쪽 ‘가가’ → ‘웹 사이트 설정’ → ‘마이크’를 ‘허용’으로 바꾸고 새로고침해 주세요. 그래도 안 되면 아이폰 ‘설정’ → ‘Safari’ → ‘마이크’를 확인해 주세요." + tail;
  return "마이크가 막혀 있어요. 주소창 왼쪽 자물쇠(사이트 정보) 버튼에서 마이크를 ‘허용’으로 바꾸고 새로고침해 주세요." + tail;
}
