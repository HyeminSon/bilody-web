// 웹 알림(0.7.8): 앱(Reminders.kt)과 같은 규칙으로 서버가 정한 시간에 보낸다.
// 아이폰은 Safari에서 '홈 화면에 추가'로 설치한 bilody에서만 알림을 받을 수 있다(애플 정책, iOS 16.4 이상).
import * as api from "./api.js?v=0.8.9";

export const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
/** 이 기기에서 알림을 켤 수 없는 까닭(없으면 null). */
export function blocker() {
  if (isIOS() && !standalone()) return "ios_install";
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return null;
}

let regP = null;
export const register = () => (regP ??= supported() ? navigator.serviceWorker.register("sw.js").catch(() => null) : Promise.resolve(null));

function keyBytes(b64) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function currentSub() {
  const r = await register(); if (!r) return null;
  return r.pushManager.getSubscription();
}

/** 이 기기의 알림 설정. {on, hour, minute} */
export async function load() {
  try {
    const sub = await currentSub(); if (!sub) return null;
    const row = (await api.pushSub(sub.endpoint))[0];
    return row ? { on: row.enabled && Notification.permission === "granted", hour: row.hour, minute: row.minute } : null;
  } catch { return null; }
}

/** 알림 켜기. 버튼을 누른 그 자리에서 불러야 한다(권한 묻기는 누른 직후에만 됨). */
export async function enable(hour, minute) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new api.ApiError("notif_denied");
  const r = await register(); if (!r) throw new api.ApiError("notif_unsupported");
  await navigator.serviceWorker.ready;
  let sub = await r.pushManager.getSubscription();
  if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(await api.pushKey()) });
  const j = sub.toJSON();
  await api.savePushSub({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, hour, minute, enabled: true, user_agent: navigator.userAgent.slice(0, 200) });
  api.logEvent(null, "reminder_set", { on: true, time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, web: true, standalone: standalone() });
}

export async function disable() {
  const sub = await currentSub();
  if (sub) await api.updatePushSub(sub.endpoint, { enabled: false });
  api.logEvent(null, "reminder_set", { on: false, web: true });
}
