import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import prettier from 'eslint-config-prettier/flat'

// Number.prototype / Date.prototype locale formatting, banned outside src/lib/format.ts.
const NUMBER_FORMAT_METHODS =
  '/^(toLocaleString|toLocaleDateString|toLocaleTimeString|toPrecision|toFixed)$/'

// UX-2 / GR-11: player-facing numbers and money go through src/lib/format.ts only.
// Any reference to `Intl` is banned (it also catches aliases, destructuring, computed
// access and globalThis.Intl / window.Intl), as are the Number/Date locale formatters
// however they are reached, and hand-built "$" amounts.
const FORMAT_SELECTORS = [
  {
    selector: "Identifier[name='Intl']",
    message: 'Format numbers with src/lib/format.ts (formatMoney, formatCount).',
  },
  {
    selector: `MemberExpression[property.name=${NUMBER_FORMAT_METHODS}]`,
    message: 'Format numbers with src/lib/format.ts (formatMoney, formatCount).',
  },
  {
    selector: `MemberExpression[computed=true][property.value=${NUMBER_FORMAT_METHODS}]`,
    message: 'Format numbers with src/lib/format.ts (formatMoney, formatCount).',
  },
  {
    selector: `MemberExpression[computed=true] > TemplateLiteral.property > TemplateElement[value.raw=${NUMBER_FORMAT_METHODS}]`,
    message: 'Format numbers with src/lib/format.ts (formatMoney, formatCount).',
  },
  {
    selector: `ObjectPattern > Property[key.name=${NUMBER_FORMAT_METHODS}]`,
    message: 'Format numbers with src/lib/format.ts (formatMoney, formatCount).',
  },
  {
    selector: 'TemplateLiteral > TemplateElement[tail=false][value.raw=/\\$$/]',
    message: 'Money must go through formatMoney (src/lib/format.ts), not a "$" template.',
  },
  {
    selector: "BinaryExpression[operator='+'] > Literal.left[value=/\\$$/]",
    message: 'Money must go through formatMoney (src/lib/format.ts), not "$" + value.',
  },
  {
    selector: 'JSXText[value=/\\$\\s*$/] + JSXExpressionContainer',
    message: 'Money must go through formatMoney (src/lib/format.ts), not "$" in JSX.',
  },
]

// The engine is pure and deterministic: no real clock, no randomness, no browser or
// framework APIs (CLAUDE.md "Architecture rules"). Time and any randomness are passed in.
// `Date`, `Reflect`, `self` and `globalThis` are banned outright (no-restricted-globals), so
// they cannot be aliased or destructured; city-time parts come from src/lib/format.ts.
// `Math` is allowed only as `Math.<name>` for names other than `random`.
const PURE = 'The engine is pure: pass what it needs in (time, randomness, services).'
const ENGINE_SELECTORS = [
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message: 'The engine is deterministic: pass a seeded random source in.',
  },
  {
    selector: "MemberExpression[object.name='Math'][computed=true]",
    message: 'Use Math.<name> directly: computed Math access could reach Math.random.',
  },
  {
    selector: "Identifier[name='Math']:not(MemberExpression > Identifier.object)",
    message: 'Use Math.<name> directly: an aliased or destructured Math could reach Math.random.',
  },
  { selector: 'ImportExpression', message: `No dynamic import() in the engine. ${PURE}` },
  { selector: "CallExpression[callee.name='require']", message: `No require() in the engine.` },
]

const ENGINE_GLOBALS = [
  'Date',
  'Reflect',
  'self',
  'globalThis',
  'window',
  'document',
  'navigator',
  'performance',
  'crypto',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'requestAnimationFrame',
  'requestIdleCallback',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'process',
  'require',
  'module',
]

// Matched against the import string, so relative paths ('../state/store') are caught too.
const ENGINE_IMPORT_PATTERNS = [
  {
    group: ['react', 'react-dom', 'react/**', 'react-dom/**'],
    message: 'The engine has no React imports.',
  },
  {
    group: ['three', 'three/**', '@react-three/**'],
    message: 'The engine has no three imports.',
  },
  { group: ['@supabase/**'], message: 'The engine has no Supabase imports.' },
  {
    group: [
      'zustand',
      'zustand/**',
      'next',
      'next/**',
      '**/state',
      '**/state/**',
      '**/components',
      '**/components/**',
      '**/scene',
      '**/scene/**',
      '**/realtime',
      '**/realtime/**',
      '**/server',
      '**/server/**',
      '**/app/**',
    ],
    message: 'The engine does not depend on the store, UI, scene, server or framework.',
  },
]

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // eslint-config-next registers jsx-a11y with only a handful of rules; turn on the full
  // recommended set (A11Y-2). The plugin object is the same instance, so no redefinition.
  {
    files: ['**/*.{js,jsx,mjs,ts,tsx}'],
    rules: jsxA11y.flatConfigs.recommended.rules,
  },
  {
    rules: {
      // All logging goes through src/lib/log.ts.
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['src/**/*.{js,jsx,mjs,ts,tsx}'],
    ignores: ['src/lib/format.ts'],
    rules: { 'no-restricted-syntax': ['error', ...FORMAT_SELECTORS] },
  },
  {
    // Repeats FORMAT_SELECTORS: a later block's rule options replace an earlier block's.
    files: ['src/engine/**/*.ts'],
    ignores: ['src/engine/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...FORMAT_SELECTORS, ...ENGINE_SELECTORS],
      'no-restricted-globals': [
        'error',
        ...ENGINE_GLOBALS.map((name) => ({ name, message: PURE })),
      ],
      'no-restricted-imports': ['error', { patterns: ENGINE_IMPORT_PATTERNS }],
    },
  },
  {
    // Playwright fixtures receive a `use` callback that is not React's `use` hook.
    files: ['tests/e2e/**/*.ts'],
    rules: { 'react-hooks/rules-of-hooks': 'off' },
  },
  prettier,
  globalIgnores([
    '.next/**',
    '.next-e2e/**',
    '.next-e2e-supabase/**',
    '.next-e2e-dpl/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    'coverage/**',
    'test-results/**',
    'playwright-report/**',
    'blob-report/**',
    'supabase/.temp/**',
    '.cache/**',
    '.claude/**',
    'docs/**',
  ]),
])

export default eslintConfig
