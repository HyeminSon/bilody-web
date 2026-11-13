// 문장 자르기·도움 카드 판단(안드로이드 Sentences.kt, HelpCards.kt와 같은 규칙).
const ABBREV = /\b(Mr|Mrs|Ms|Dr|St|vs|etc|e\.g|i\.e|a\.m|p\.m)\.$/i;
const MAX_LEN = 120;
/** 두 대답 조각이 띄어쓰기 없이 붙어 오면 띄우고, "생각해 볼게요" 같은 군말 문장은 소리로 내지 않는다(11/13, 앱과 같음). */
const GLUED = /([a-z][.!?])(?=[A-Z])/g;
const FILLER = /(\blet me think\b|\bthink (this|it) through\b|\blet['’]?s make it simple together\b|\bi['’]?ll explain (the main idea |it |this )?in (easy|simple) words\b)/i;
export const isFiller = (s) => FILLER.test(s);

export function takeSentences(buf, final) {
  const out = []; let rest = buf.replace(GLUED, "$1 ");
  for (;;) {
    let cut = -1;
    const END = /[.!?]+["')\]”’]?(\s+|$)/g; let m;
    while ((m = END.exec(rest)) !== null) {
      if (m[0].length === 0) { END.lastIndex++; continue; }
      const end = m.index + m[0].trimEnd().length;
      const head = rest.slice(0, end);
      const atEnd = m.index + m[0].length >= rest.length && m[1] === "";
      if (atEnd && !final) break;
      if (ABBREV.test(head)) continue;
      if (/\d\.$/.test(head) && /^\d/.test(rest.slice(end))) continue;
      cut = end; break;
    }
    if (cut === -1 && rest.length > MAX_LEN) {
      const w = rest.slice(0, MAX_LEN);
      const comma = Math.max(w.lastIndexOf(", "), w.lastIndexOf("; ")); const space = w.lastIndexOf(" ");
      cut = comma > 20 ? comma + 1 : space > 20 ? space : MAX_LEN;
    }
    if (cut === -1) break;
    const s = rest.slice(0, cut).trim(); if (s && !isFiller(s)) out.push(s);
    rest = rest.slice(cut).trimStart();
  }
  if (final && rest.trim()) { if (!isFiller(rest)) out.push(rest.trim()); rest = ""; }
  return { sentences: out, rest };
}

const confusedRe = /(i don'?t (understand|get it|know what you mean)|i didn'?t (get|understand|catch)|what do you mean|pardon|say (that|it) again|one more time|repeat (that|it|please)|^(what|huh|pardon)[.?!]*$|(didn'?t|couldn'?t|can'?t) hear|^(oh,? )?sorry[.?!]*$|뭐라고|못 들|안 들려|무슨 (말|뜻)|모르겠|이해가 안|이해 못|못 알아|다시 (말해|한 ?번))/i;
const quoteRe = /["“]([^"”]{1,160})["”]/g;
const practiceRe = /(we usually say|can you say|\bsay:|in parts|\bnow:|all together|try (it )?(once )?(more|again))/i;
const rephraseRe = /^let me say it another way[.!,]?\s*/i;
/** 11/13: 처음 두 번(교정·한 번 더 듣기)은 소리로만, 두 번째도 틀려 구절별 연습으로 넘어가면 그때 글 카드를 보여 준다. */
const partsRe = /(in parts|\bsay:|\bnow:|all together)/i;

export const confused = (t) => confusedRe.test(t.trim());
/** 11/13 실장님: "Could you show the text?" 하면 따라 말할 문장을 바로 글로 보여 준다(앱과 같음). */
const showTextRe = /(show (me )?(the |that |it )?(text|sentence|words?|it)|can i see (it|the (text|sentence))|write it( down)?|type it|(글|글자|텍스트|문장|자막)(로|을|를)? ?(보여|써)|보여 ?줘)/i;
export const wantsText = (t) => showTextRe.test(t);
export function lastQuote(reply) {
  const qs = [...reply.matchAll(quoteRe)]; const q = qs.length ? qs[qs.length - 1][1].trim() : null;
  return q && /\p{L}/u.test(q) ? q : null;
}
const norm = (x) => x.toLowerCase().replace(/[^a-z0-9' ]/g, " ").replace(/\s+/g, " ").trim();

/** 친구 대답 하나를 보고 도움 카드를 정한다. null이면 바꿀 것 없음. */
export function decideCard(reply, target, helpWanted) {
  const text = reply.trim(); if (!text) return null;
  const quotes = [...text.matchAll(quoteRe)];
  const q = quotes.length ? quotes[quotes.length - 1][1].trim() : null;
  const quote = q && /\p{L}/u.test(q) ? q : null;
  if (quote && practiceRe.test(text)) {
    if (!partsRe.test(text)) return { card: null, target: target && norm(target).includes(norm(quote)) ? target : quote };
    if (target && norm(quote) !== norm(target) && norm(target).includes(norm(quote)))
      return { card: { practice: true, text: target, chunk: quote }, target };
    return { card: { practice: true, text: quote }, target: quote };
  }
  const rephrase = rephraseRe.test(text) || /in other words/i.test(text);
  if (helpWanted || rephrase) {
    const shown = text.replace(rephraseRe, "") || text;
    return { card: { practice: false, text: shown, rephrased: rephraseRe.test(text) }, target: null };
  }
  return { card: null, target: null };
}
