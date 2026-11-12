// 다섯 친구(안드로이드 Characters.kt와 같은 값). 목소리는 친구를 따라간다.
export const CHARACTERS = [
  { id: "tori", ko: "토리", en: "Tori", colorId: "lavender", color: "#D9B8EF", intro: "네 이야기가 제일 궁금한 다정한 친구", voice: "v5OLQ9LnbQvVSltgjBQI", anim: "tori_lavender" },
  { id: "nubi", ko: "누비", en: "Nubi", colorId: "green", color: "#BFDA9F", intro: "궁금한 걸 찾아 어디든 가 보는 탐험가", voice: "7DSLNhi1bsA7jJ54NUNW", anim: "nubi_green" },
  { id: "moa", ko: "모아", en: "Moa", colorId: "apricot", color: "#FDBC96", intro: "우리 이야기를 차곡차곡 모아 두는 친구", voice: "alD9kGFj7F15LsGV9JXz", anim: "moa_apricot" },
  { id: "sola", ko: "솔라", en: "Sola", colorId: "yellow", color: "#FDDB96", intro: "햇살처럼 밝게 노래하는 친구", voice: "s2pQKNXSpOfbGkicSrWd", anim: "sola_yellow" },
  { id: "rino", ko: "리노", en: "Rino", colorId: "sky", color: "#A9C9D9", intro: "‘만약에?’를 좋아하는 장난꾸러기 친구", voice: "q1qhDPgBcD8KhwwUDItb", anim: "rino_sky" },
];
export const byId = (id) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
export const dotColor = (colorId) => CHARACTERS.find((c) => c.colorId === colorId)?.color ?? (colorId === "peach" ? "#F6B79A" : CHARACTERS[0].color);
export const validFriendName = (n) => /^[A-Za-z가-힣][A-Za-z가-힣 .'-]{0,7}$/.test(n.trim());
export const validMyName = (n) => /^[A-Za-z][A-Za-z .'-]{0,19}$/.test(n.trim());

/** 대화 상태에 맞는 움직임 그림. */
export function animSrc(id, state) {
  const s = state === "listening" ? "listen" : state === "speaking" ? "speak" : state === "stopped" || state === "disconnected" ? "pause" : "idle";
  return `anim/${byId(id).anim}_${s}.webp`;
}
