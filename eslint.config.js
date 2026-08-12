import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'node_modules/**',
      'grok-build/**',
      'docs/spike-raw/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /* §4: "no `any` without a written justification". An explicit `any` is a
         hard error; the escape hatch is an eslint-disable line carrying the
         justification, which makes every instance greppable and reviewable. */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      /* §4: "No secrets in logs, ever." Bare console calls bypass the redaction
         sink in src/shared/logger.ts, so they are banned outside of the debug
         renderer and standalone scripts (overridden below). */
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            'Read configuration through src/shared/env.ts so nothing reaches a log sink unredacted.',
        },
      ],
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    // `configs.flat['recommended-latest']` is the flat-config form; the legacy
    // `configs.recommended` still declares `plugins` as an array of strings.
    ...reactHooks.configs.flat['recommended-latest'],
  },
  {
    // Standalone spike scripts print to stdout by design; they use the same
    // redaction layer but are not part of the app's logging pipeline.
    files: ['scripts/**/*.ts', 'scripts/**/*.mjs', 'mocks/**/*.mjs'],
    rules: { 'no-console': 'off', 'no-restricted-syntax': 'off' },
  },
  {
    files: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Standalone Node/Electron processes, outside every tsconfig project by
    // design — the app never imports them, so type-aware linting has no
    // program to resolve them against.
    files: ['*.config.js', '*.config.ts', 'mocks/**/*.mjs', 'scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The mock helper runs as a standalone Node process, like the Swift binary
    // it stands in for — it is not part of the bundled app.
    files: ['mocks/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
      },
    },
  },
  prettier,
);
