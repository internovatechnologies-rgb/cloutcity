/**
 * Word lists for the event content scan (src/lib/data/events.test.ts), from CLAUDE.md
 * "Safety rules": nightlife and alcohol only as flavour, never rewarded or required; no drugs,
 * sexual content or gambling; mild profanity at most.
 *
 * Limits: this is a keyword scan of every event string in base copy and every slang pack. It
 * catches the plain words and common slang below, matched as whole words, case-insensitively.
 * It cannot understand euphemism, innuendo or context, so new event copy still needs a human
 * read. Words that are common in innocent copy ("high" as in the High Line, "pot", "bar",
 * "club", "party", "smoke") are deliberately not listed; extend the lists when new slang shows
 * up.
 */

/**
 * Drinking as an action or a reward. Event titles and bodies may mention nightlife (clubs,
 * bars, last call); no event string may mention drinking itself, and no choice can offer it.
 */
export const DRINKING_WORDS = [
  'drink',
  'drinks',
  'drinking',
  'drunk',
  'tipsy',
  'wasted',
  'booze',
  'boozy',
  'alcohol',
  'beer',
  'beers',
  'wine',
  'cocktail',
  'cocktails',
  'liquor',
  'vodka',
  'tequila',
  'whiskey',
  'whisky',
  'rum',
  'gin',
  'champagne',
  'prosecco',
  'shots',
  'bottle service',
  'happy hour',
  'hangover',
  'hungover',
  'open bar',
  'bartender',
  'brewery',
] as const

export const DRUG_WORDS = [
  'drug',
  'drugs',
  'weed',
  'cannabis',
  'marijuana',
  'joint',
  'blunt',
  'edible',
  'edibles',
  'stoned',
  'stoner',
  'cocaine',
  'coke',
  'molly',
  'mdma',
  'ecstasy',
  'pill',
  'pills',
  'xanax',
  'lsd',
  'acid',
  'shrooms',
  'ketamine',
  'heroin',
  'meth',
  'dealer',
  'dope',
  '420',
  'vape',
  'vaping',
  'narcotic',
  'narcotics',
  'overdose',
] as const

export const SEXUAL_WORDS = [
  'sex',
  'sexy',
  'sexual',
  'hookup',
  'hook up',
  'nude',
  'nudes',
  'naked',
  'strip club',
  'stripper',
  'porn',
  'horny',
  'booty call',
  'one-night stand',
  'make out',
  'thirst trap',
  'onlyfans',
  'dtf',
  'body count',
  'lingerie',
] as const

export const GAMBLING_WORDS = [
  'bet',
  'bets',
  'betting',
  'gamble',
  'gambling',
  'casino',
  'poker',
  'blackjack',
  'roulette',
  'lottery',
  'scratch-off',
  'wager',
  'slot machine',
  'three-card monte',
  'dice game',
] as const

/** Above "damn" level. */
export const PROFANITY_WORDS = [
  'shit',
  'fuck',
  'fucking',
  'bitch',
  'ass',
  'asshole',
  'bastard',
  'crap',
  'dick',
  'piss',
] as const

/** Whole-word, case-insensitive matches of any of `words` in `text`. */
export function findWords(text: string, words: readonly string[]): string[] {
  const lower = text.toLowerCase()
  return words.filter((word) => {
    const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(lower)
  })
}
