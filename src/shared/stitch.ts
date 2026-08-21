/**
 * Repairing the seams between `speech_final` segments.
 *
 * ## Why this file exists
 *
 * `docs/spike-results.md` §4 records that "one hold can emit many
 * `speech_final`s", and the doc comment in `src/main/stt/frames.ts` used to call
 * each one "a clean one-pass re-transcription of **the whole turn**". Measured
 * against 67 real dictations from a user's own log, that is wrong in the way
 * that matters: a `speech_final` re-transcribes **one endpointed segment**, and
 * a turn averaged **4.9 of them** (one every ~8 s; worst case 41). The app then
 * joined them with a plain space.
 *
 * Every one of those joins is a seam between two transcriptions that never saw
 * each other, and the seams are where the text goes wrong. Verbatim, from that
 * user's `history.json`:
 *
 * | Inserted text                                | What happened                  |
 * | -------------------------------------------- | ------------------------------ |
 * | `and it should Do any code changes yet`      | new segment re-capitalised     |
 * | `at the end of the day, you You have like…`  | the seam word transcribed twice|
 * | `I-I see only in my In my Stats terminal`    | same, two words                |
 * | `explain to me Thanks.`                      | trailing silence hallucinated  |
 *
 * The fixes below are the ones that are **decidable without a language model**.
 * Each is a separate, individually testable rule, and each errs towards leaving
 * the user's words alone: this code rewrites what a person said, so a rule that
 * is merely usually-right is not good enough.
 *
 * ## What it deliberately does not fix
 *
 * A word split across the seam — `run? From the Mac.` + `A book at home.` for
 * "MacBook" — is not recoverable from the two halves. Neither is a negation
 * eaten by the cut (`it shouldn't do` → `it should` + `Do any…`), which is why
 * rule 3 restores the grammar of that sentence without restoring its meaning.
 * Both need the audio or a model. See the note at the end of this comment.
 *
 * ## The rules
 *
 * 1. **Drop hallucinated courtesy fillers** at the very start or very end of a
 *    turn. Leading and trailing silence is what makes a recogniser emit
 *    "Thank you." out of nothing. Only at the ends, only when something else
 *    survives, and only for a short closed list — a user who dictates the single
 *    word "Thanks!" into a chat window still gets it.
 * 2. **De-duplicate the overlapping words at a seam.** Segments overlap
 *    slightly, so the last words of one and the first words of the next are
 *    frequently the same words twice.
 * 3. **Undo the sentence-start capital** when the previous segment did not end a
 *    sentence — but only for closed-class words (`and`, `do`, `in`, `because`),
 *    never for anything that could be a name or an acronym.
 *
 * Everything here is pure, synchronous and dependency-free so that the whole of
 * it is a unit test rather than something you need a microphone to check.
 *
 * ## The honest limit
 *
 * These rules repair the *mechanics* of the join. They cannot recover words the
 * segmentation destroyed. The real fix for that is upstream — a longer
 * `endpointingMs`, so there are fewer seams to repair — and this module is the
 * safety net for the seams that remain. See `DEFAULT_ENDPOINTING_MS`.
 */

/**
 * How many words back to look for a duplicated seam.
 *
 * Four is enough for every overlap observed (the longest was two words) and
 * short enough that a genuinely repeated phrase — "very, very" — is only ever a
 * candidate when it lands exactly on a seam, where a duplicate is far more
 * likely to be the artefact than the intent.
 */
const MAX_SEAM_OVERLAP_WORDS = 4;

/**
 * Punctuation that means the sentence is over, so a capital after it is the
 * user's own. A closing quote or bracket may follow. An abbreviation (`e.g.`)
 * reads as a sentence end here, which costs a missed de-capitalisation and never
 * a wrong one — the safe direction.
 *
 * `:` and `;` are included because they end a *clause*, and a capital after one
 * is at worst stylistic — but they are absent from `HARD_SENTENCE_END`, because
 * *forcing* a capital after a colon would be wrong.
 */
const SENTENCE_END = /[.!?…:;][)\]}"'”’»]*$/u;

/**
 * The subset after which the next word must be capitalised.
 *
 * Rule 2 is why this exists. Dropping a duplicated seam word promotes whatever
 * followed it to the start of a sentence, and that word was mid-sentence a
 * moment ago, so it is lower case: `…wrong information or.` + `Or the agent…`
 * de-duplicates to `…information or. the agent…`. Repairing one artefact must
 * not introduce another.
 *
 * It also catches the case the recogniser itself gets wrong — a segment that
 * genuinely begins lower case after the previous one ended a sentence, as in
 * `…what we could do.` + `and just as I said…`. Replaying this user's
 * transcripts through `scripts/replay-history.ts`, nine of the ten seams it
 * touched were of that kind.
 */
const HARD_SENTENCE_END = /[.!?…][)\]}"'”’»]*$/u;

/** Punctuation that must not have a space in front of it. */
const HUGS_PREVIOUS = /^[,.;:!?)\]}»…]/u;

/**
 * Whole segments that are almost always a recogniser filling in silence rather
 * than a person speaking. Matched only against a *complete* segment, and only at
 * the two ends of a turn.
 *
 * `okay`, `so`, `right` and `well` are deliberately absent: they are just as
 * likely to be the real first or last word of a dictation.
 */
const FILLER_SEGMENTS = new Set([
  'thank you',
  'thanks',
  'thank you very much',
  'thank you so much',
  'thanks a lot',
  'thank you for watching',
  'thanks for watching',
  'bye',
  'bye bye',
  'goodbye',
  'you',
  // German — the same hallucinations, in the other language the app supports.
  'danke',
  'dankeschön',
  'danke schön',
  'vielen dank',
  'tschüss',
  'auf wiedersehen',
]);

/**
 * Words that cannot begin a sentence-worth of new meaning, so a capital on one
 * of them directly after an unfinished sentence is a segment boundary rather
 * than the user's intent.
 *
 * Closed-class only — articles, pronouns, conjunctions, prepositions,
 * auxiliaries and discourse adverbs. Content words are excluded on principle,
 * because a capitalised content word at a seam is exactly where a proper noun
 * lives.
 *
 * Three English words are held out on purpose — `i`, because "I" is capitalised
 * mid-sentence and always has been; `may`, the month; and `will`, the name. A
 * wrong de-capitalisation is more jarring than a missed one, so anything with a
 * common capitalised reading loses its place on the list.
 *
 * The German half holds out `die`, `man`, `war`, `hat` and `will` — each is an
 * English word in its own right — and `sie` and `ihr`, which are legitimately
 * capitalised in German as the formal `Sie` and `Ihr`.
 */
const CONTINUATION_WORDS = new Set(
  [
    // English: determiners
    'a an the this that these those some any all each every both either neither',
    'another such no other others more most less least many much few several enough',
    // English: pronouns
    'it he she they we you me him her them us my your his its our their mine yours',
    'ours theirs myself yourself itself themselves one ones',
    // English: conjunctions and subordinators
    'and but or nor so yet because although though while whereas since unless until',
    'if whether than as when where why how whenever wherever which who whom whose',
    'what',
    // English: prepositions
    'about above across after against along among around at before behind below',
    'beneath beside between beyond by despite down during except for from in inside',
    'into like near of off on onto out outside over past through throughout to',
    'toward towards under underneath up upon with within without',
    // English: auxiliaries and light verbs
    'am are is was were be been being do does did doing done have has had having',
    'can could shall should would might must need ought get gets got go goes going',
    'went make makes made say says said know knows think thinks want wants see sees',
    'take takes come comes give gives use uses used put puts',
    // English: discourse adverbs and negation
    'also just only even still again then there here now very really quite rather',
    'too almost always never often sometimes usually maybe perhaps actually',
    'basically especially particularly however therefore otherwise anyway instead',
    'meanwhile yeah yes okay ok well right sure exactly definitely probably',
    'obviously honestly literally kind sort not nothing nobody none',
    // German: conjunctions and subordinators
    'und aber oder denn weil dass damit obwohl während wenn falls sondern sowie',
    'bevor nachdem',
    // German: determiners and pronouns
    'der das den dem des ein eine einen einem einer eines kein keine keinen diese',
    'dieser dieses diesem diesen jede jeder jedes alle allen aller welche welcher',
    'welches ich mich mir du dich dir er es wir uns euch ihn ihm ihnen mein meine',
    'meinen meinem meiner dein deine unser unsere unseren',
    // German: auxiliaries and modals
    'ist sind bin bist seid sein gewesen wird werden wurde wurden worden habe hast',
    'haben habt hatte hatten gehabt kann kannst können könnt konnte konnten könnte',
    'könnten muss musst müssen müsst musste mussten müsste soll sollst sollen sollt',
    'sollte sollten darf darfst dürfen dürft durfte durften mag mögen möchte',
    'möchten willst wollen wollt wollte wollten',
    // German: prepositions
    'auf für von mit zu zum zur beim nach über unter vor hinter neben zwischen',
    'durch um aus ohne gegen seit bis ab statt trotz wegen innerhalb außerhalb',
    // German: discourse adverbs and negation
    'nicht nichts nie niemals immer oft manchmal vielleicht wahrscheinlich',
    'eigentlich wirklich sehr ziemlich ganz schon noch nur auch sogar wieder dann',
    'jetzt hier dort da dabei dazu dafür deshalb deswegen trotzdem außerdem',
    'allerdings jedoch natürlich genau quasi eben mal wie wo wer wann warum wieso',
    'weshalb ja nein doch',
  ]
    .join(' ')
    .split(' '),
);

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Join `speech_final` segments into the text that will actually be inserted.
 *
 * With `repairSeams` false this is the historical behaviour verbatim —
 * `segments.join(' ').trim()` — which is what the setting of the same name
 * exists to restore. The escape hatch is not decoration: this function rewrites
 * a person's words, and a user who dislikes how must be able to switch it off
 * without waiting for a release.
 */
export function stitchSegments(segments: readonly string[], repairSeams = true): string {
  const parts: string[] = [];
  for (const segment of segments) {
    const collapsed = collapseWhitespace(segment);
    if (collapsed.length > 0) parts.push(collapsed);
  }
  if (parts.length === 0) return '';
  if (!repairSeams) return parts.join(' ').trim();

  const kept = dropEdgeFillers(parts);
  let out = kept[0] ?? '';
  for (let i = 1; i < kept.length; i++) {
    out = joinSeam(out, kept[i] ?? '');
  }
  return out.trim();
}

/* ------------------------------------------------------------------ *
 * Rule 1 — hallucinated fillers at the ends of a turn
 * ------------------------------------------------------------------ */

/**
 * Strip whole-segment fillers from the front and back.
 *
 * If *everything* is a filler the user really did just say "thanks, bye", and
 * the whole turn survives untouched — checked up front rather than by letting
 * the two loops grind down to a single arbitrary survivor.
 */
function dropEdgeFillers(parts: readonly string[]): readonly string[] {
  if (parts.every((part) => isFillerSegment(part))) return parts;
  let start = 0;
  let end = parts.length;
  while (start < end && isFillerSegment(parts[start] ?? '')) start++;
  while (end > start && isFillerSegment(parts[end - 1] ?? '')) end--;
  return parts.slice(start, end);
}

function isFillerSegment(segment: string): boolean {
  const bare = segment
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ');
  // A segment of pure punctuation carries nothing either way.
  if (bare.length === 0) return true;
  return FILLER_SEGMENTS.has(bare);
}

/* ------------------------------------------------------------------ *
 * Rules 2 and 3 — one seam
 * ------------------------------------------------------------------ */

function joinSeam(prev: string, next: string): string {
  const prevWords = splitWords(prev);
  let nextWords = splitWords(next);

  // Rule 2. The overlap is dropped from the *incoming* segment rather than the
  // settled one: the text already accumulated carries punctuation that has
  // survived a seam, and re-cutting it risks more than it repairs.
  const overlap = overlapLength(prevWords, nextWords);
  if (overlap > 0) nextWords = nextWords.slice(overlap);
  if (nextWords.length === 0) return prev;

  // Rule 3, and its mirror image. Both are gated on the same closed-class list,
  // so the case of a name, a product or an acronym is never anybody's business
  // but the recogniser's — `iCloud` and `xAI` are the reason that matters.
  const first = nextWords[0] ?? '';
  if (isContinuationWord(first)) {
    if (HARD_SENTENCE_END.test(prev)) {
      nextWords = [capitalise(first), ...nextWords.slice(1)];
    } else if (!SENTENCE_END.test(prev)) {
      nextWords = [decapitalise(first), ...nextWords.slice(1)];
    }
  }

  const tail = nextWords.join(' ');
  if (prev.length === 0) return tail;
  return HUGS_PREVIOUS.test(tail) ? prev + tail : `${prev} ${tail}`;
}

/**
 * How many words at the end of `prevWords` are repeated at the start of
 * `nextWords`. Longest match wins, so `in my` + `In my Stats` drops two rather
 * than stopping at one.
 */
function overlapLength(prevWords: readonly string[], nextWords: readonly string[]): number {
  const limit = Math.min(MAX_SEAM_OVERLAP_WORDS, prevWords.length, nextWords.length);
  for (let n = limit; n >= 1; n--) {
    let matched = true;
    for (let i = 0; i < n; i++) {
      const a = normaliseWord(prevWords[prevWords.length - n + i] ?? '');
      const b = normaliseWord(nextWords[i] ?? '');
      // An empty normalisation is a punctuation-only token, which matches
      // nothing: two adjacent dashes are not a repeated word.
      if (a.length === 0 || a !== b) {
        matched = false;
        break;
      }
    }
    if (matched) return n;
  }
  return 0;
}

function isContinuationWord(word: string): boolean {
  return CONTINUATION_WORDS.has(normaliseWord(word));
}

/**
 * Lower the first letter, leaving acronyms alone.
 *
 * `RAG` and `MCP` arrive at seams constantly in this user's dictation and are
 * all-caps, so a multi-letter all-caps word is never touched. The letter count
 * is what matters, not the character count: `A` and `A.` are all-caps by string
 * comparison and are still just the article.
 *
 * A word that does not start with an upper-case letter is returned unchanged,
 * which makes this a no-op on the common case rather than a special case at the
 * call site.
 */
function decapitalise(word: string): string {
  const first = word.charAt(0);
  if (first !== first.toUpperCase() || first === first.toLowerCase()) return word;
  const letters = word.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && word === word.toUpperCase()) return word;
  return first.toLowerCase() + word.slice(1);
}

/**
 * Raise the first letter. A word that does not start with a lower-case letter is
 * returned unchanged, so this is a no-op on text the recogniser already got
 * right — which is the overwhelming majority of seams.
 */
function capitalise(word: string): string {
  const first = word.charAt(0);
  if (first !== first.toLowerCase() || first === first.toUpperCase()) return word;
  return first.toUpperCase() + word.slice(1);
}

/* ------------------------------------------------------------------ *
 * Text helpers
 * ------------------------------------------------------------------ */

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function splitWords(text: string): string[] {
  return text.split(' ').filter((word) => word.length > 0);
}

/**
 * A word reduced to what makes it *the same word*: case folded, and stripped of
 * the punctuation that a re-transcription is free to attach or drop. Internal
 * marks survive, so `shouldn't` stays distinct from `should` and `I-I` from `I`.
 */
function normaliseWord(word: string): string {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}
