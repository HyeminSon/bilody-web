// 다섯 친구(안드로이드 Characters.kt와 같은 값). 목소리는 친구를 따라간다.
export const CHARACTERS = [
  { id: "tori", ko: "토리", en: "Tori", colorId: "lavender", color: "#D9B8EF", intro: "네 이야기가 제일 궁금한 다정한 친구", voice: "v5OLQ9LnbQvVSltgjBQI", anim: "tori_lavender" },
  { id: "nubi", ko: "누비", en: "Nubi", colorId: "green", color: "#BFDA9F", intro: "궁금한 걸 찾아 어디든 가 보는 탐험가", voice: "7DSLNhi1bsA7jJ54NUNW", anim: "nubi_green" },
  { id: "moa", ko: "모아", en: "Moa", colorId: "apricot", color: "#FDBC96", intro: "우리 이야기를 차곡차곡 모아 두는 친구", voice: "alD9kGFj7F15LsGV9JXz", anim: "moa_apricot" },
  { id: "sola", ko: "솔라", en: "Sola", colorId: "yellow", color: "#FDDB96", intro: "햇살처럼 밝게 웃는 친구", voice: "s2pQKNXSpOfbGkicSrWd", anim: "sola_yellow" },
  { id: "rino", ko: "리노", en: "Rino", colorId: "sky", color: "#A9C9D9", intro: "‘만약에?’를 좋아하는 장난꾸러기 친구", voice: "q1qhDPgBcD8KhwwUDItb", anim: "rino_sky" },
];
// 0.9(11/17): 선생님 5명(앱 Characters.teachers와 같음). 1:1 수업을 가르치고, 대화 상대로도 고를 수 있다.
export const TEACHERS = [
  { id: "grace", ko: "그레이스", en: "Grace", colorId: "grace", color: "#E9906A", intro: "문장 틀부터 차근차근 잡아 주는 다정한 선생님", forWhom: "영어가 처음이거나 오랜만인 분", voice: "BNMnXdNX2pxtE5q1P8gY", teacher: true },
  { id: "daniel", ko: "대니얼", en: "Daniel", colorId: "daniel", color: "#3D4A7A", intro: "왜 그렇게 말하는지 이유까지 알려 주는 선생님", forWhom: "규칙을 알아야 외워지는 분", voice: "oYzAJMaYhBAcQzcPEIkE", teacher: true },
  { id: "chloe", ko: "클로이", en: "Chloe", colorId: "chloe", color: "#8FB0E0", intro: "발음과 리듬을 신나게 잡아 주는 선생님", forWhom: "발음이 걱정되는 분", voice: "IsJ1UY6iuGhKNGkzEeJx", teacher: true },
  { id: "ben", ko: "벤", en: "Ben", colorId: "ben", color: "#E7B04A", intro: "원어민이 진짜 쓰는 말과 뉘앙스를 알려 주는 선생님", forWhom: "더 자연스럽게 말하고 싶은 분", voice: "brhvfYWzMPuKJz4vBegD", teacher: true },
  { id: "maya", ko: "마야", en: "Maya", colorId: "maya", color: "#9BAE84", intro: "입이 트이도록 자신감을 북돋는 선생님", forWhom: "머릿속으론 아는데 입이 안 떨어지는 분", voice: "H4H00svEXeg2d8aZX2No", teacher: true },
];
const ALL = [...CHARACTERS, ...TEACHERS];
export const byId = (id) => ALL.find((c) => c.id === id) ?? CHARACTERS[0];
export const isTeacher = (id) => TEACHERS.some((t) => t.id === id);
export const dotColor = (colorId) => ALL.find((c) => c.colorId === colorId)?.color ?? (colorId === "peach" ? "#F6B79A" : CHARACTERS[0].color);
/** 선생님 그림(상태: idle·listen·speak·wait). */
export const teacherImg = (id, st = "idle") => `img/teacher_${isTeacher(id) ? id : "grace"}_${st}.webp`;
/** 교재 장면 속 인물 목소리(앱 Characters.sceneVoice와 같음). */
export function sceneVoice(who) {
  return { jiwoo: "cmVsX8t72uEZzHPAo4M8", staff: "cgSgspJ2msm6clMCkdW9", haru: "7DSLNhi1bsA7jJ54NUNW", yuna: "s2pQKNXSpOfbGkicSrWd", pip: "q1qhDPgBcD8KhwwUDItb" }[who]
    ?? TEACHERS.find((t) => t.id === who)?.voice ?? "cgSgspJ2msm6clMCkdW9";
}
export const validFriendName = (n) => /^[A-Za-z가-힣][A-Za-z가-힣 .'-]{0,7}$/.test(n.trim());
export const validMyName = (n) => /^[A-Za-z][A-Za-z .'-]{0,19}$/.test(n.trim());

/** 대화 상태에 맞는 움직임 그림. */
export function animSrc(id, state) {
  if (isTeacher(id)) return teacherImg(id, state === "listening" ? "listen" : state === "speaking" ? "speak" : state === "thinking" ? "wait" : "idle");
  const s = state === "listening" ? "listen" : state === "speaking" ? "speak" : state === "stopped" || state === "disconnected" ? "pause" : "idle";
  return `anim/${byId(id).anim}_${s}.webp`;
}

/** 이름 뒤 조사(은/는, 이/가, 과/와)를 받침에 맞춰 고른다. 영어 이름은 소리로 어림(l·m·n·ng로 끝나면 받침). 앱 Josa.kt와 같음. */
export function hasBatchim(word) {
  const w = String(word ?? "").trim().replace(/[!.?~\s]+$/, ""); const c = w.slice(-1);
  if (!c) return false;
  const code = c.charCodeAt(0);
  if (code >= 0xAC00 && code <= 0xD7A3) return (code - 0xAC00) % 28 !== 0;
  const l = w.toLowerCase();
  return l.endsWith("ng") || "lmn".includes(l.slice(-1));
}
export const josa = (w, withB, without) => w + (hasBatchim(w) ? withB : without);
export const eunNeun = (w) => josa(w, "은", "는");
export const iGa = (w) => josa(w, "이", "가");
export const gwaWa = (w) => josa(w, "과", "와");
