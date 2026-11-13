// 실시간 대화(안드로이드 RealtimeController의 웹판, A3: 글 대답 → 문장마다 안전검사 + 캐릭터 목소리).
// 친구는 글로 대답하고, 문장이 끝날 때마다 tts-say로 소리를 만들어 차례로 들려준다.
// 끝까지 들려준 문장만 기록하고(REQ-OPS-013), 사용자가 말을 시작하면 친구가 멈춘다.
import * as api from "./api.js?v=0.8.3";
import { PRESET } from "./config.js?v=0.8.3";
import { takeSentences, decideCard, confused, wantsText, lastQuote } from "./text.js?v=0.8.3";

const PHOTO_HINT = "(The learner is showing you this photo. In simple English, say what the main thing is, teach one or two useful English words for it, then ask one short, easy question about it. " +
  "If you are not sure, say so honestly and guess kindly. If it shows a person, do not comment on their looks and do not guess who they are.)";

export class Chat {
  /**
   * story: 동화 듣기 중 대화(앱과 같음, 11/13). { onSpeechStart, onReplyDone, onNoise, onCue(pic), isNarrating(), pictureFor(word) }
   * 동화 모드에서는 인사·도움 카드·기록 저장·쉬는 시간 멈춤이 없고, 이용 시간은 동화 쪽이 잰다.
   */
  constructor({ voiceId, speed, saveTranscripts, player, onChange, presetId = PRESET, sessionId = null, story = null }) {
    this.voiceId = voiceId; this.speed = speed; this.saveTranscripts = saveTranscripts;
    this.player = player; this.onChange = onChange; this.presetId = presetId; this.story = story;
    this.connGen = 0;
    this.ui = { state: "idle", micOn: false, lines: [], card: null, notice: null, remainingMinutes: null, lastLatencyMs: null, canRestart: false, speech: false, photo: null };
    this.sessionId = sessionId; this.seq = 0; this.closed = false;
    this.pc = null; this.dc = null; this.stream = null; this.track = null;
    this.epoch = 0; this.resp = null; this.greeted = false;
    this.recentFriend = ""; this.practiceTarget = null; this.helpWanted = false;
    this.soft = false; this.softHeld = false; this.ignoredResp = null; this.ignoreUntil = 0;
    this.tSpeechStopped = 0; this.lastSpeechStart = 0; this.startedDuringPlayback = false;
    this.maxMsg = 65536; this.limitReached = false; this.cameraHold = false;
    this.slots = 0; this.waiters = [];
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
      if (!this.sessionId) this.sessionId = await api.startSession(this.presetId);
      if (stale()) return abandon();
      const key = await api.realtimeKey(this.presetId, this.speed);
      if (stale()) return abandon();
      this.updateRemaining(key.todaySeconds, key.limitSeconds);
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch {
        stream = null;
        this.set({ notice: "마이크를 쓸 수 없어요. 브라우저 설정에서 마이크를 허용하거나, 아래에 글로 입력해 주세요." });
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
    if (this.story) { this.openMic(); return; }   // 동화: 인사 없이 바로 마이크(동화는 이미 흐르고 있다)
    this.send({ type: "response.create" });
    setTimeout(() => { if (!this.greeted) this.openMic(); }, 8000);
  }

  openMic() {
    if (this.closed || !this.pc) return;
    this.greeted = true;
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
        clearTimeout(this.idleTimer);
        this.startedDuringPlayback = this.player.isPlaying || !!this.story?.isNarrating();
        if (this.story) { this.story.onSpeechStart(); this.interruptReply(); }
        else if (this.player.isPlaying && this.resp) this.startSoft();
        else this.interruptReply();
        this.set({ state: "listening", speech: true });
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
          return;
        }
        this.startedDuringPlayback = false;
        if (t) { this.persist("user", t); this.addLine("user", t); if (confused(t)) this.helpWanted = true; if (!this.story && /\p{L}/u.test(t)) this.learnerTurns = (this.learnerTurns ?? 0) + 1; this.noteTextAsk(t); }
        break;
      }
      case "response.created": {
        const rid = ev.response?.id;
        if (this.soft || Date.now() < this.ignoreUntil) { this.ignoredResp = rid; this.softHeld = this.soft; this.send({ type: "response.cancel" }); return; }
        clearTimeout(this.idleTimer);
        if (this.resp) this.finishReply(this.resp, false);
        if (this.announceAt && Date.now() > this.announceAt) this.announceAt = 0;   // 검색 결과가 들어간 뒤의 대답이 결과를 전한다
        this.epoch++;
        this.resp = { id: rid, epoch: this.epoch, text: "", pending: "", done: false, played: [], chain: Promise.resolve(), itemId: null, first: true, hadText: false };
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
          r.pending = ""; r.done = true; r.chain.then(() => this.onReplyPlayed(r));
        }
        const call = this.pendingCall; this.pendingCall = null;
        if (call) { this.runTool(call); break; }
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
    const voice = this.voiceId, speed = this.story ? 1 : this.speed, sid = this.sessionId;
    const job = (async () => { await this.slot(); try { return await api.say(sentence, voice, speed, sid); } finally { this.release(); } })();
    job.catch(() => {});
    r.chain = r.chain.then(async () => {
      if (r.epoch !== this.epoch || r.blocked) return;
      let s; try { s = await job; } catch (e) { if (r.first) this.set({ notice: e?.code === "daily_voice_limit" ? "오늘 친구 목소리를 만들 수 있는 양을 모두 썼어요. 자정이 지나면 다시 이야기할 수 있어요." : "목소리를 만들지 못했어요. 다시 말해 주거나 글로 입력해 주세요." }); return; }
      if (r.epoch !== this.epoch) return;
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
    if (!this.story) { if (r.blocked) this.set({ card: null }); else this.updateCard(r.played.join(" ")); }
    this.resp = null;
    if (!this.greeted) this.openMic();
    if (this.pc) this.set({ state: "listening" });
    if (this.story) { this.story.onReplyDone(); return; }
    this.afterFriendFinished();
  }

  /** 들려준 만큼만 기록하고, 서버 문맥도 들려준 말로 고친다. */
  finishReply(r, complete) {
    const played = r.played.join(" ").trim();
    if (!complete || played !== r.text.trim()) this.fixServerContext(r, played);
    if (played) this.persist("assistant", played);
    if (played && !this.story) { this.trackPractice(played); this.noteCorrection(played); this.noteQuestion(played); }
    this.closeAssistantLine(!complete);
  }

  /** 앱과 같게: 문장 전체 따라 말하기가 세 번 연달아 나오면 다음엔 넘어가라는 메모를 넣는다(두 번까지는 정상, 11/13). */
  trackPractice(played) {
    this.practiceStreak = /(we usually say|can you say that|can you try that)/i.test(played) ? (this.practiceStreak ?? 0) + 1 : 0;
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
    const m = /(we usually say|a more natural way to say|let's try it in parts|listen once more|you can say,)/i.exec(played); if (!m) return;
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
    if (this.story) return;
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
    this.idleTimer = setTimeout(() => {
      if (this.closed || !this.pc || this.player.isPlaying || this.ui.speech || this.resp) return;
      this.stopInternal("IDLE_PAUSE", "한동안 대답이 없어서 잠시 멈췄어요. 이어서 하려면 다시 시작을 눌러 주세요.");
    }, 60000);
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

  addLine(role, text, pending = false) { this.set({ lines: [...this.ui.lines, { role, text, pending }].slice(-60) }); }
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
    if (!this.sessionId || !this.saveTranscripts) return;
    const n = this.seq++;
    api.saveTurn(this.sessionId, n, role, text).catch(() => this.log("save_failed", {}));
  }

  // ---------------- 글·사진 ----------------
  sendText(text) {
    const t = text.trim(); if (!t || !this.pc) return;
    clearTimeout(this.idleTimer);
    this.interruptReply();
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: t }] } });
    this.send({ type: "response.create" });
    this.persist("user", t); this.addLine("user", t); if (confused(t)) this.helpWanted = true;
    this.learnerTurns = (this.learnerTurns ?? 0) + 1; this.noteTextAsk(t);
    this.tSpeechStopped = Date.now();
    this.set({ state: "thinking" });
  }

  /** dataUrl: data:image/jpeg;base64,... (크기는 maxMsg 안에 맞춘 것) */
  sendImage(dataUrl, previewUrl) {
    if (!this.pc || this.dc?.readyState !== "open") { this.set({ notice: "대화가 연결된 동안에만 사진을 보여 줄 수 있어요." }); return; }
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
  }
  clearPhoto() { this.set({ photo: null }); }

  /** 사진을 고르러 가는 동안: 마이크를 끄고 화면이 가려져도 대화를 끊지 않는다. */
  holdForCamera(on) {
    this.cameraHold = on;
    if (this.track) this.track.enabled = !on && this.greeted;
    this.set({ micOn: !on && this.greeted && !!this.track });
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
    if (u.limit_seconds > 0 && u.today_seconds >= u.limit_seconds && this.pc) { this.limitReached = true; if (!this.player.isPlaying && !this.resp) this.afterFriendFinished(); }
  }
  updateRemaining(today, limit) {
    if (!limit || limit <= 0) return;
    const left = limit - today;
    this.set({ remainingMinutes: left > 0 && left <= 300 ? Math.ceil(left / 60) : null });
  }

  // ---------------- 멈춤·종료 ----------------
  stop() { this.stopInternal("USER_STOP", null); }
  pauseForBackground() { if (this.pc && !this.cameraHold) this.stopInternal("APP_BACKGROUND", "대화를 멈췄어요. 이어서 하려면 다시 시작을 눌러 주세요."); }
  lost() { if (this.pc) { this.stopInternal("NETWORK", "인터넷 연결이 끊겼어요. 연결을 확인한 뒤 다시 시작을 눌러 주세요."); this.set({ state: "disconnected" }); } }

  stopInternal(reason, notice) {
    this.connGen++;   // 진행 중인 연결이 있으면 끝나는 대로 버린다
    this.player.stop(); this.player.duck(false);
    if (this.resp) { this.epoch++; this.finishReply(this.resp, false); this.resp = null; }
    clearTimeout(this.idleTimer); clearTimeout(this.softTimer); this.soft = false;
    this.flushMeter(); clearInterval(this.meter);
    this.teardown();
    this.set({ state: "stopped", micOn: false, canRestart: true, speech: false, notice });
    this.log("stop", { reason });
  }

  teardown() {
    try { this.dc?.close(); } catch { /* */ }
    try { this.pc?.close(); } catch { /* */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.dc = null; this.pc = null; this.stream = null; this.track = null;
  }

  async close() {
    if (this.closed) return;
    this.closed = true; this.connGen++;
    this.stopInternal("SESSION_END", null);
    if (this.sessionId) await api.finishSession(this.sessionId);
  }
}

/** 사진을 미리 받아 둔다(카드가 빈 채로 뜨지 않게). 8초 안에 못 받으면 실패. */
function preload(url) {
  return new Promise((ok) => {
    const img = new Image(); const t = setTimeout(() => ok(false), 8000);
    img.onload = () => { clearTimeout(t); ok(true); }; img.onerror = () => { clearTimeout(t); ok(false); };
    img.src = url;
  });
}
