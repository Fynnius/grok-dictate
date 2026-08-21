import { describe, expect, it } from 'vitest';
import { stitchSegments } from './stitch.js';

describe('stitchSegments', () => {
  it('is the old join when seam repair is off', () => {
    expect(stitchSegments(['and it should', 'Do any code changes yet'], false)).toBe(
      'and it should Do any code changes yet',
    );
  });

  it('leaves a single segment exactly as the server sent it', () => {
    const only = 'Please fix the Claude config for me.';
    expect(stitchSegments([only])).toBe(only);
  });

  it('drops empty and whitespace-only segments, and normalises spacing', () => {
    expect(stitchSegments(['  First   sentence. ', '', '   ', 'Second sentence.'])).toBe(
      'First sentence. Second sentence.',
    );
  });

  it('returns an empty string for no segments at all', () => {
    expect(stitchSegments([])).toBe('');
    expect(stitchSegments(['', '   '])).toBe('');
  });
});

/* ------------------------------------------------------------------ *
 * Rule 1 — hallucinated fillers
 * ------------------------------------------------------------------ */

describe('rule 1: courtesy fillers at the ends of a turn', () => {
  it('drops a trailing "Thanks." hallucinated out of the closing silence', () => {
    // Verbatim tail of a 307 s dictation from the reporting user's history.json.
    expect(
      stitchSegments(['So I want you to a bit summarize that, explain to me', 'Thanks.']),
    ).toBe('So I want you to a bit summarize that, explain to me');
  });

  it('drops a leading one too', () => {
    expect(stitchSegments(['Thank you.', 'Could you research this for me?'])).toBe(
      'Could you research this for me?',
    );
  });

  it('keeps a filler that is the entire dictation', () => {
    // Somebody dictating "Thanks!" into a chat window must still get it.
    expect(stitchSegments(['Thanks!'])).toBe('Thanks!');
    expect(stitchSegments(['Thank you very much.'])).toBe('Thank you very much.');
  });

  it('keeps a filler in the middle, where it is probably real speech', () => {
    // Only leading and trailing silence produces these. Mid-turn, deleting a
    // user's words on suspicion is worse than leaving a stray one in.
    expect(stitchSegments(['I sent the invoice.', 'Thank you.', 'Let me know.'])).toBe(
      'I sent the invoice. Thank you. Let me know.',
    );
  });

  it('drops a punctuation-only segment', () => {
    expect(stitchSegments(['The meeting is at four.', '.'])).toBe('The meeting is at four.');
  });

  it('keeps everything when every segment is a filler', () => {
    expect(stitchSegments(['Thanks.', 'Bye.'])).toBe('Thanks. Bye.');
  });
});

/* ------------------------------------------------------------------ *
 * Rule 2 — duplicated words across a seam
 * ------------------------------------------------------------------ */

describe('rule 2: the seam word transcribed twice', () => {
  it('drops a one-word overlap', () => {
    // history.json: "at the end of the day, you You have like index?"
    expect(stitchSegments(['at the end of the day, you', 'You have like index?'])).toBe(
      'at the end of the day, you have like index?',
    );
  });

  it('drops a two-word overlap, taking the longest match', () => {
    // history.json: "I-I see only in my In my Stats terminal"
    expect(stitchSegments(['I-I see only in my', 'In my Stats terminal, how many agents'])).toBe(
      'I-I see only in my Stats terminal, how many agents',
    );
  });

  it('ignores punctuation when deciding two words are the same word', () => {
    expect(stitchSegments(['we should ship it,', 'It, obviously, needs review'])).toBe(
      'we should ship it, obviously, needs review',
    );
  });

  it('does not match on internal punctuation, so "shouldn\'t" is not "should"', () => {
    expect(stitchSegments(['I think it should', "Shouldn't matter"])).toBe(
      "I think it should Shouldn't matter",
    );
  });

  it('looks no further back than four words', () => {
    const prev = 'one two three four five';
    const next = 'two three four five six';
    // The five-word overlap is out of range; the trailing four still match.
    expect(stitchSegments([prev, next])).toBe('one two three four five six');
  });

  it('keeps the segment when the overlap consumes all of it', () => {
    expect(stitchSegments(['the report is ready', 'Ready'])).toBe('the report is ready');
  });

  it('does not treat a punctuation-only token as a repeat', () => {
    expect(stitchSegments(['the plan is —', '— and then we ship'])).toBe(
      'the plan is — — and then we ship',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Rule 3 — the sentence-start capital
 * ------------------------------------------------------------------ */

describe('rule 3: a new segment re-capitalised mid-sentence', () => {
  it('lowers a closed-class word after an unfinished sentence', () => {
    // history.json: "and it should Do any code changes yet".
    // The lost "n't" is NOT recoverable here — only the capital is.
    expect(stitchSegments(['and it should', 'Do any code changes yet'])).toBe(
      'and it should do any code changes yet',
    );
  });

  it('handles the other real examples from the report', () => {
    expect(stitchSegments(['which can do work very cheap', 'Especially I have Codex'])).toBe(
      'which can do work very cheap especially I have Codex',
    );
    expect(stitchSegments(['so it shouldn’t be like', 'A normal extraction'])).toBe(
      'so it shouldn’t be like a normal extraction',
    );
    expect(stitchSegments(['What you told me now', 'In my opinion'])).toBe(
      'What you told me now in my opinion',
    );
  });

  it('leaves the capital alone after a finished sentence', () => {
    expect(stitchSegments(['That is done.', 'And then we ship it.'])).toBe(
      'That is done. And then we ship it.',
    );
    expect(stitchSegments(['Is that right?', 'Do it anyway.'])).toBe(
      'Is that right? Do it anyway.',
    );
  });

  it('treats a closing quote after the full stop as a finished sentence', () => {
    expect(stitchSegments(['he said "we are done."', 'And left'])).toBe(
      'he said "we are done." And left',
    );
  });

  it('never lowers a word that could be a name or a noun', () => {
    expect(stitchSegments(['we deployed it to', 'Berlin yesterday'])).toBe(
      'we deployed it to Berlin yesterday',
    );
    expect(stitchSegments(['the deadline is', 'May the fifth'])).toBe(
      'the deadline is May the fifth',
    );
    expect(stitchSegments(['I asked', 'Will about it'])).toBe('I asked Will about it');
  });

  it('never lowers an acronym', () => {
    expect(stitchSegments(['we could use a', 'RAG pipeline'])).toBe('we could use a RAG pipeline');
    expect(stitchSegments(['running it behind an', 'MCP server'])).toBe(
      'running it behind an MCP server',
    );
  });

  it('never lowers the English "I"', () => {
    expect(stitchSegments(['and then', 'I told them'])).toBe('and then I told them');
  });

  it('repairs German seams too', () => {
    expect(stitchSegments(['ich glaube das ist', 'Nicht so gut'])).toBe(
      'ich glaube das ist nicht so gut',
    );
    expect(stitchSegments(['wir haben das gemacht, weil', 'Es einfacher war'])).toBe(
      'wir haben das gemacht, weil es einfacher war',
    );
  });

  it('leaves the formal German "Sie" and "Ihr" capitalised', () => {
    expect(stitchSegments(['ich wollte fragen ob', 'Sie Zeit haben'])).toBe(
      'ich wollte fragen ob Sie Zeit haben',
    );
  });
});

/* ------------------------------------------------------------------ *
 * Seam mechanics
 * ------------------------------------------------------------------ */

describe('spacing at the seam', () => {
  it('does not put a space in front of punctuation that hugs the word before it', () => {
    expect(stitchSegments(['we shipped it', ', which was overdue'])).toBe(
      'we shipped it, which was overdue',
    );
  });

  it('puts exactly one space in the ordinary case', () => {
    expect(stitchSegments(['first', 'second', 'third'])).toBe('first second third');
  });
});

describe('rule 3 in reverse: a lower-case word promoted to a sentence start', () => {
  it('capitalises what de-duplication left at the front of a sentence', () => {
    // Found by replaying this user's real transcripts: dropping the repeated
    // "Or" promotes "the", which was mid-sentence a moment ago, to a sentence
    // start. Repairing one artefact must not introduce another.
    expect(
      stitchSegments(["we don't get wrong information or.", 'Or the agent gets confused']),
    ).toBe("we don't get wrong information or. The agent gets confused");
  });

  it('does not force a capital after a colon, where lower case is correct', () => {
    expect(stitchSegments(['the plan is this:', 'the first step is easy'])).toBe(
      'the plan is this: the first step is easy',
    );
  });

  it('leaves a name or a product alone, whatever the punctuation before it', () => {
    // `capitalise` is gated on the same closed-class list as `decapitalise`, so
    // a deliberately lower-case product name survives a sentence boundary.
    expect(stitchSegments(['I put the files there.', 'iCloud syncs them'])).toBe(
      'I put the files there. iCloud syncs them',
    );
    expect(stitchSegments(['we called the API.', 'xAI returned it'])).toBe(
      'we called the API. xAI returned it',
    );
  });

  it('is a no-op when the recogniser already capitalised it', () => {
    expect(stitchSegments(['That is done.', 'And then we ship.'])).toBe(
      'That is done. And then we ship.',
    );
  });
});

describe('several rules on one turn', () => {
  it('de-duplicates and then de-capitalises the word underneath', () => {
    // The overlap hides the real first word; rule 3 has to run on what is left.
    expect(stitchSegments(['I think that we', 'We And then it works'])).toBe(
      'I think that we and then it works',
    );
  });

  it('handles a four-segment turn end to end', () => {
    expect(
      stitchSegments([
        'Thank you.',
        'So the plan is that we',
        'We should probably',
        'Also check the logs',
        'Thanks.',
      ]),
    ).toBe('So the plan is that we should probably also check the logs');
  });
});
