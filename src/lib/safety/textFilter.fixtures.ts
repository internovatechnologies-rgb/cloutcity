/**
 * Shared fixtures for the text filter: textFilter.test.ts runs them through the TypeScript twin,
 * tests/integration/safety.test.ts through `private.normalize_text` and
 * `private.contains_contact_info`, and both must give these answers.
 */
export interface TextFilterFixture {
  readonly text: string
  /** What normalizeText returns. */
  readonly normalized: string
  readonly contact: boolean
}

export const TEXT_FILTER_FIXTURES: readonly TextFilterFixture[] = [
  // Ordinary notes, insults included: the note is evidence, so only contact details are refused.
  { text: 'kept spamming emotes at me', normalized: 'kept spamming emotes at me', contact: false },
  {
    text: 'Called me a damn clown and a bastard',
    normalized: 'called me a damn clown and a bastard',
    contact: false,
  },
  { text: '  Two   spaces\tand\nlines  ', normalized: 'two spaces and lines', contact: false },
  {
    text: 'at 10:30 pm near the bodega',
    normalized: 'at 10:30 pm near the bodega',
    contact: false,
  },
  { text: 'level 12345 player', normalized: 'level 12345 player', contact: false },
  { text: 'i.e. me and my friend', normalized: 'i.e. me and my friend', contact: false },
  { text: 'the snap judgement', normalized: 'the snap judgement', contact: false },
  { text: 'ugh ❤\ufe0f not cool', normalized: 'ugh ❤\ufe0f not cool', contact: false },
  { text: 'Ünïcödé café', normalized: 'Ünïcödé café', contact: false },
  { text: '', normalized: '', contact: false },
  // Links.
  { text: 'go to https://evil.example', normalized: 'go to https://evil.example', contact: true },
  { text: 'WWW.Example.org', normalized: 'www.example.org', contact: true },
  { text: 'join discord dot gg slash x', normalized: 'join discord dot gg slash x', contact: true },
  { text: 'visit cloutcity.com now', normalized: 'visit cloutcity.com now', contact: true },
  { text: 'site(dot)io', normalized: 'site(dot)io', contact: true },
  // Full-width letters fold to plain ones.
  { text: 'ｅｖｉｌ．ｃｏｍ', normalized: 'evil.com', contact: true },
  // Emails.
  { text: 'mail me@x.co', normalized: 'mail me@x.co', contact: true },
  { text: 'name (at) mail [dot] net', normalized: 'name (at) mail [dot] net', contact: true },
  // Phone numbers.
  { text: 'call 555 123 4567', normalized: 'call 555 123 4567', contact: true },
  { text: 'text +1 (212) 555-0100', normalized: 'text +1 (212) 555-0100', contact: true },
  { text: '5551234', normalized: '5551234', contact: true },
  { text: 'only 555-12 here', normalized: 'only 555-12 here', contact: false },
  // Social handles.
  { text: 'dm @someone', normalized: 'dm @someone', contact: true },
  { text: 'IG: cool.cat', normalized: 'ig: cool.cat', contact: true },
  { text: 'snap=coolcat', normalized: 'snap=coolcat', contact: true },
  // Hidden characters.
  { text: 'link\u200bhere', normalized: 'link\u200bhere', contact: true },
  { text: 'bell\u0007', normalized: 'bell\u0007', contact: true },
  { text: 'rtl\u202eflip', normalized: 'rtl\u202eflip', contact: true },
  { text: 'family 👨\u200d👩\u200d👧', normalized: 'family 👨\u200d👩\u200d👧', contact: true },
]
