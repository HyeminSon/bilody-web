// Supabase 서버와 이야기하는 부분(안드로이드 앱 Backend.kt와 같은 요청).
import { SUPABASE_URL, ANON_KEY, VERSION } from "./config.js?v=0.3.0";

export class ApiError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

const TOKEN_KEY = "bilody_tokens";
let tokens = null;
try { tokens = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null"); } catch { tokens = null; }

// 11/13 헨니 검토: 로그아웃 직후 끝난 토큰 갱신이 로그인 정보를 다시 저장하던 문제 → 로그인 상태가 바뀔 때마다 번호를 올리고, 갱신 결과는 같은 번호일 때만 저장
let authGen = 0;
let refreshing = null;
function saveTokens(t) {
  tokens = t;
  try { t ? localStorage.setItem(TOKEN_KEY, JSON.stringify(t)) : localStorage.removeItem(TOKEN_KEY); } catch { /* 저장 못 해도 이번 접속은 계속 */ }
}

export const userId = () => tokens?.user?.id ?? null;
export const signedIn = () => !!tokens;

async function errorCode(res) {
  const text = await res.text().catch(() => "");
  try { const o = JSON.parse(text); return String(o.error ?? o.error_code ?? o.code ?? o.msg ?? `http_${res.status}`); }
  catch { return `http_${res.status}`; }
}

async function call(url, init) {
  try { return await fetch(url, init); } catch { throw new ApiError("network", 0); }
}

function withExpiry(t) { return { ...t, expires_at_ms: Date.now() + (t.expires_in ?? 3600) * 1000 - 60000 }; }

export async function signIn(email, password) {
  const res = await call(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new ApiError(res.status === 400 ? "wrong_login" : await errorCode(res), res.status);
  authGen++; refreshing = null;
  saveTokens(withExpiry(await res.json()));
}

export async function redeemInvite(code, email, password) {
  const res = await call(`${SUPABASE_URL}/functions/v1/web-proxy?fn=redeem-invite`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ code, email, password }),
  });
  if (!res.ok) throw new ApiError(await errorCode(res), res.status);
}

export function signOut() {
  const access = tokens?.access_token;
  authGen++; refreshing = null; saveTokens(null);
  // 서버 쪽 갱신 토큰도 끊는다(실패해도 이 기기에서는 이미 로그아웃)
  if (access) call(`${SUPABASE_URL}/auth/v1/logout`, { method: "POST", headers: { apikey: ANON_KEY, Authorization: `Bearer ${access}` } }).catch(() => {});
}

async function accessToken() {
  if (!tokens) throw new ApiError("not_logged_in");
  if (Date.now() < (tokens.expires_at_ms ?? 0)) return tokens.access_token;
  if (!refreshing) refreshing = refreshTokens().finally(() => { refreshing = null; });
  return refreshing;
}
async function refreshTokens() {
  const gen = authGen; const old = tokens;
  const res = await call(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: old.refresh_token }),
  });
  if (gen !== authGen) throw new ApiError("not_logged_in");   // 그사이 로그아웃(또는 다른 계정 로그인)
  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) { authGen++; saveTokens(null); throw new ApiError("session_expired", res.status); }
    throw new ApiError("network", res.status);
  }
  const nt = await res.json();
  if (gen !== authGen) throw new ApiError("not_logged_in");
  saveTokens(withExpiry({ ...nt, user: nt.user ?? old.user }));
  return tokens.access_token;
}

export async function rest(path, { method = "GET", body, prefer } = {}) {
  const headers = { apikey: ANON_KEY, Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const res = await call(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body == null ? undefined : (typeof body === "string" ? body : JSON.stringify(body)) });
  if (!res.ok) throw new ApiError(await errorCode(res), res.status);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function fn(name, body, raw = false) {
  // 브라우저는 CORS 허락이 있는 web-proxy를 거쳐 함수를 부른다
  const res = await call(`${SUPABASE_URL}/functions/v1/web-proxy?fn=${name}`, {
    method: "POST", headers: { apikey: ANON_KEY, Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new ApiError(await errorCode(res), res.status);
  return raw ? res : res.json();
}

// ---------- 계정·동의·친구 ----------
export async function loadProfile() {
  const uid = userId(); if (!uid) return null;
  return (await rest(`profiles?user_id=eq.${uid}&select=*`))[0] ?? null;
}
export async function saveProfile({ friendName, myName, presetId, color, character }) {
  const b = { user_id: userId(), friend_name: friendName, my_name: myName };
  if (presetId) b.preset_id = presetId; if (color) b.color = color; if (character) b.character = character;
  await rest("profiles?on_conflict=user_id", { method: "POST", body: b, prefer: "resolution=merge-duplicates,return=minimal" });
}
export async function patchProfile(fields) { await rest(`profiles?user_id=eq.${userId()}`, { method: "PATCH", body: fields, prefer: "return=minimal" }); }
export async function hasConsent(version) {
  return (await rest(`consents?user_id=eq.${userId()}&text_version=eq.${version}&select=item`)).length > 0;
}
export async function saveConsents(items, version) {
  await rest("consents", { method: "POST", body: items.map((item) => ({ user_id: userId(), item, text_version: version })), prefer: "return=minimal" });
}

// ---------- 대화 ----------
export async function startSession(presetId) {
  const r = await rest("sessions?select=id", { method: "POST", body: { user_id: userId(), preset_id: presetId, app_version: VERSION }, prefer: "return=representation" });
  return r[0].id;
}
export async function saveTurn(sessionId, seq, role, text) {
  await rest("turns", { method: "POST", body: { session_id: sessionId, user_id: userId(), seq, role, text }, prefer: "return=minimal" });
}
export async function finishSession(sessionId) { try { await fn("end-session", { sessionId }); } catch { /* 기억 정리 실패는 대화를 막지 않음 */ } }
// features: 이 앱이 할 수 있는 것(사진 카드). 서버는 Pexels 키가 있고 앱이 지원할 때만 사진 도구를 준다(11/13).
export const realtimeKey = (presetId, speed) => fn("realtime-session", { presetId, speed, features: ["picture"] });

/** 문장 하나 → 안전검사 + 캐릭터 목소리(PCM 16비트). 검사를 통과 못 하면 서버가 고정 문장 소리를 준다. */
export async function say(text, voice, speed, sessionId, preview = false) {
  const body = { text, voice, speed }; if (sessionId) body.sessionId = sessionId; if (preview) body.preview = true;
  const res = await fn("tts-say", body, true);
  const rate = Number(res.headers.get("X-Sample-Rate") || 24000);
  const result = res.headers.get("X-Result") || "ok";
  const fixedRaw = res.headers.get("X-Fixed-Text");
  const fixed = fixedRaw ? decodeURIComponent(fixedRaw) : null;
  const buf = await res.arrayBuffer();
  return { pcm: new Int16Array(buf, 0, Math.floor(buf.byteLength / 2)), rate, result, fixed };
}

/** 대화 중 인터넷 찾아보기(11/13). 검색어·결과는 서버에 남기지 않는다. */
export const lookup = (query, sessionId) => fn("web-lookup", { query, sessionId });
/** 대화 중 단어 사진(11/13, Pexels). 검색어는 서버에 남기지 않는다. */
export const picture = (query, sessionId) => fn("picture-lookup", { query, sessionId });

export async function addActiveSeconds(seconds, presetId) {
  try { return await rest("rpc/add_active_seconds", { method: "POST", body: { p_seconds: seconds, p_preset: presetId } }); } catch { return null; }
}
export async function logEvent(sessionId, kind, data) {
  try { await rest("op_events", { method: "POST", body: { user_id: userId(), session_id: sessionId, kind, data, app_version: VERSION }, prefer: "return=minimal" }); } catch { /* 작동 기록 실패는 무시 */ }
}

// ---------- 기록·기억·설정 ----------
export const sessions = () => rest("sessions?select=id,preset_id,started_at,ended_at&order=started_at.desc&limit=100");
export const turns = (sid) => rest(`turns?session_id=eq.${sid}&select=seq,role,text&order=seq.asc,role.desc`);
export async function firstLines() {
  const rows = await rest("turns?select=session_id,text,seq,role&role=eq.user&seq=lte.1&order=seq.asc&limit=500");
  const m = {}; for (const r of rows) if (!(r.session_id in m)) m[r.session_id] = r.text; return m;
}
export const deleteSession = (sid) => rest(`sessions?id=eq.${sid}`, { method: "DELETE" });
export const deleteAllSessions = () => rest(`sessions?user_id=eq.${userId()}`, { method: "DELETE" });
export const memories = () => rest("memories?select=id,text,created_at&order=created_at.desc");
export const deleteMemory = (id) => rest(`memories?id=eq.${id}`, { method: "DELETE" });
export const updateMemory = (id, text) => rest(`memories?id=eq.${id}`, { method: "PATCH", body: { text: text.slice(0, 200) }, prefer: "return=minimal" });
export const myProgress = async () => { try { return await rest("rpc/my_progress", { method: "POST", body: {} }); } catch { return null; } };
export const weeklyBoard = async () => { try { return await rest("rpc/weekly_board", { method: "POST", body: {} }); } catch { return []; } };
export async function sendFeedback(kind, category, body, attached, sessionId) {
  const o = { user_id: userId(), kind, category, body: body.slice(0, 2000), app_version: VERSION };
  if (attached) o.attached = attached; if (sessionId) o.session_id = sessionId;
  await rest("feedback", { method: "POST", body: o, prefer: "return=minimal" });
}
/** 매일 짧은 설문(0.7.7). */
export async function saveCheckin(sessionId, rating, issues, note) {
  const o = { user_id: userId(), rating, issues, app_version: VERSION };
  if (sessionId) o.session_id = sessionId; if (note && note.trim()) o.note = note.trim().slice(0, 500);
  await rest("daily_checkins", { method: "POST", body: o, prefer: "return=minimal" });
}
/** 이 계정이 쓸 수 있는 대화 방식(동화 듣기 'kids-demo'가 있으면 동화 듣기 버튼이 보인다). */
export const presets = async () => { try { return await rest("model_presets?select=id,label,structure,sort&order=sort.asc"); } catch { return []; } };

// ---------- 웹 알림(0.7.8) ----------
export async function pushKey() {
  const res = await call(`${SUPABASE_URL}/functions/v1/send-reminders`, { method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ action: "key" }) });
  if (!res.ok) throw new ApiError(await errorCode(res), res.status);
  return (await res.json()).publicKey;
}
export const pushSub = (endpoint) => rest(`push_subs?endpoint=eq.${encodeURIComponent(endpoint)}&select=enabled,hour,minute`);
export async function savePushSub(o) {
  await rest("push_subs?on_conflict=endpoint", { method: "POST", body: { ...o, user_id: userId(), last_sent_date: null, updated_at: new Date().toISOString() }, prefer: "resolution=merge-duplicates,return=minimal" });
}
export const updatePushSub = (endpoint, fields) => rest(`push_subs?endpoint=eq.${encodeURIComponent(endpoint)}`, { method: "PATCH", body: fields, prefer: "return=minimal" });

export async function deleteAccount() { await fn("delete-account", {}); authGen++; refreshing = null; saveTokens(null); }

export function errText(e) {
  const c = e?.code ?? String(e);
  return ({
    wrong_login: "이메일이나 비밀번호가 맞지 않아요.", network: "인터넷 연결을 확인해 주세요.", session_expired: "다시 로그인해 주세요.",
    invite_invalid: "초대 코드가 맞지 않거나 이미 쓴 코드예요.", weak_password: "비밀번호는 8자 이상으로 해 주세요.", invalid_input: "입력한 내용을 다시 확인해 주세요.",
    email_taken: "이미 가입한 이메일이에요. 로그인해 주세요.",
    notif_denied: "알림이 허용되지 않았어요. 휴대폰 설정에서 bilody 알림을 허용해 주세요.", notif_unsupported: "이 브라우저에서는 알림을 받을 수 없어요.", daily_limit: "오늘 대화 시간을 모두 썼어요. 자정이 지나면 다시 이야기할 수 있어요.",
  })[c] ?? `문제가 생겼어요. (${c})`;
}
