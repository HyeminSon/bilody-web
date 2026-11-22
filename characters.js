// 다섯 친구(안드로이드 Characters.kt와 같은 값). 목소리는 친구를 따라간다.
export const CHARACTERS = [
  { id: "tori", profile: "이야기를 들어 주는 걸 제일 좋아해요. ‘왜?’, ‘그다음엔?’을 자주 물어요.", selfIntro: "Hi, I'm Tori! I love listening to your stories. Tell me about your day, and I'll ask you, why? Hehe.", ko: "토리", en: "Tori", colorId: "lavender", color: "#D9B8EF", intro: "네 이야기가 제일 궁금한 다정한 친구", voice: "v5OLQ9LnbQvVSltgjBQI", anim: "tori_lavender" },
  { id: "nubi", profile: "모든 게 신기한 꼬마 탐험가예요. 사진을 보여 주면 같이 자세히 들여다봐요.", selfIntro: "Hi, I'm Nubi! Everything is exciting to me. Show me a photo, and let's look closely together. Let's go!", ko: "누비", en: "Nubi", colorId: "green", color: "#BFDA9F", intro: "궁금한 걸 찾아 어디든 가 보는 탐험가", voice: "7DSLNhi1bsA7jJ54NUNW", anim: "nubi_green" },
  { id: "moa", profile: "포근하고 꼼꼼한 친구예요. 들려준 이야기를 차곡차곡 기억해 둬요.", selfIntro: "Hi, I'm Moa. I remember everything you tell me. Everything! Hehe. Let's have a cozy talk.", ko: "모아", en: "Moa", colorId: "apricot", color: "#FDBC96", intro: "우리 이야기를 차곡차곡 모아 두는 친구", voice: "alD9kGFj7F15LsGV9JXz", anim: "moa_apricot" },
  { id: "sola", profile: "햇살처럼 밝은 친구예요. 어떤 일에서도 좋은 점을 찾아내요.", selfIntro: "Hi! I'm Sola. I always find the bright side. A rainy day? Great! Hot chocolate time!", ko: "솔라", en: "Sola", colorId: "yellow", color: "#FDDB96", intro: "햇살처럼 밝게 웃는 친구", voice: "s2pQKNXSpOfbGkicSrWd", anim: "sola_yellow" },
  { id: "rino", profile: "‘만약에?’ 질문과 수수께끼를 좋아하는 장난꾸러기예요.", selfIntro: "Hi, I'm Rino! I love silly what-if questions. What if your cat could talk? More food, please! Hehe.", ko: "리노", en: "Rino", colorId: "sky", color: "#A9C9D9", intro: "‘만약에?’를 좋아하는 장난꾸러기 친구", voice: "q1qhDPgBcD8KhwwUDItb", anim: "rino_sky" },
];
// 0.9(11/17): 선생님 5명(앱 Characters.teachers와 같음). 1:1 수업을 가르치고, 대화 상대로도 고를 수 있다.
export const TEACHERS = [
  { id: "grace", profile: "시애틀 출신, 서울에서 5년째 가르치고 있어요. 요리와 비 오는 날 카페를 좋아해요.", selfIntro: "Hi, I'm Grace! I'm from Seattle, and I've taught English in Seoul for five years. I love cooking, but my pancakes love burning. Let's go step by step, together.", ko: "그레이스", en: "Grace", colorId: "grace", color: "#E9906A", intro: "문장 틀부터 차근차근 잡아 주는 다정한 선생님", forWhom: "영어가 처음이거나 오랜만인 분", voice: "BNMnXdNX2pxtE5q1P8gY", teacher: true },
  { id: "daniel", profile: "시카고 출신, 한국에서 대학원을 다녔어요. 농구와 역사 팟캐스트를 좋아해요.", selfIntro: "Hey, I'm Daniel, from Chicago. I studied in Korea, and I love good questions. Ask me anything, and I'll tell you why.", ko: "대니얼", en: "Daniel", colorId: "daniel", color: "#3D4A7A", intro: "왜 그렇게 말하는지 이유까지 알려 주는 선생님", forWhom: "규칙을 알아야 외워지는 분", voice: "oYzAJMaYhBAcQzcPEIkE", teacher: true },
  { id: "chloe", profile: "토론토 출신, 한국 드라마로 한국어를 배웠어요. 길거리 음식과 사진을 좋아해요.", selfIntro: "Hi! I'm Chloe from Toronto. I learned Korean from K-dramas! Let's say English with good rhythm. You'll sound so natural!", ko: "클로이", en: "Chloe", colorId: "chloe", color: "#8FB0E0", intro: "발음과 리듬을 신나게 잡아 주는 선생님", forWhom: "발음이 걱정되는 분", voice: "IsJ1UY6iuGhKNGkzEeJx", teacher: true },
  { id: "ben", profile: "보스턴 출신, 한국에서 10년 넘게 살았어요. 등산·야구·옛날 영화를 좋아해요.", selfIntro: "Hi, I'm Ben, from Boston. I've lived in Korea for over ten years. I'll show you how people really say it. And I'll tell a few bad jokes. Haha.", ko: "벤", en: "Ben", colorId: "ben", color: "#E7B04A", intro: "원어민이 진짜 쓰는 말과 뉘앙스를 알려 주는 선생님", forWhom: "더 자연스럽게 말하고 싶은 분", voice: "brhvfYWzMPuKJz4vBegD", teacher: true },
  { id: "maya", profile: "애틀랜타 출신, 서울에서 일하며 한국어를 배웠어요. 달리기와 음악 축제를 좋아해요.", selfIntro: "Hey, I'm Maya from Atlanta! I love running and music festivals. Don't worry about mistakes. Just talk to me. You've got this!", ko: "마야", en: "Maya", colorId: "maya", color: "#9BAE84", intro: "입이 트이도록 자신감을 북돋는 선생님", forWhom: "머릿속으론 아는데 입이 안 떨어지는 분", voice: "H4H00svEXeg2d8aZX2No", teacher: true },
];
// 0.8.13(11/21 실장님): 대화하기 선생님은 그레이스·대니얼(GPT-Live), 1:1 수업은 클로이·벤(지금 목소리), bilody 친구와의 대화는 지금처럼.
// 마야·누비는 고르지 못하게 뺀다(교재 장면 속 인물 목소리·옛 기록 표시는 그대로 쓰므로 목록에서는 지우지 않는다).
// 0.8.14(11/22 실장님): 마야도 대화 상대로(GPT-Live marin)
export const CHAT_TEACHERS = TEACHERS.filter((t) => t.id === "grace" || t.id === "daniel" || t.id === "maya");
export const LESSON_TEACHERS = TEACHERS.filter((t) => t.id === "chloe" || t.id === "ben");
export const PICK_FRIENDS = CHARACTERS.filter((c) => c.id !== "nubi");
/** GPT-Live로 이야기하는 대화 상대. */
export const LIVE_CHAT = new Set(["grace", "daniel", "maya"]);
const ALL = [...CHARACTERS, ...TEACHERS];
export const byId = (id) => ALL.find((c) => c.id === id) ?? CHARACTERS[0];
export const isTeacher = (id) => TEACHERS.some((t) => t.id === id);
/** 지금 고를 수 없는 대화 상대(마야·클로이·벤 / 누비)는 같은 쪽의 첫 상대(그레이스 / 토리)로. */
export const chatPartner = (id) => CHAT_TEACHERS.some((t) => t.id === id) || PICK_FRIENDS.some((c) => c.id === id) ? id : isTeacher(id) ? "grace" : "tori";
/** 1:1 수업 선생님은 클로이·벤 중에서(기본 클로이). */
export const lessonTeacher = (id) => LESSON_TEACHERS.some((t) => t.id === id) ? id : "chloe";
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
