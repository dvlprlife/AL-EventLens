// Flat config (ESLint 9+ dropped `.eslintrc.*`). Faithful port of the former
// `.eslintrc.json` — same parser, plugin, rules, and ignores — so lint
// behavior is unchanged. `@typescript-eslint` is on 8.x, which ships flat-
// config-compatible plugin/parser objects used directly here.
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    // Was `ignorePatterns` in .eslintrc.json.
    ignores: ['dist/**', 'node_modules/**', '**/*.d.ts']
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module'
    },
    plugins: {
      '@typescript-eslint': tsPlugin
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'error',
      '@typescript-eslint/naming-convention': [
        'warn',
        { selector: 'import', format: ['camelCase', 'PascalCase'] }
      ],
      semi: ['error', 'always'],
      curly: 'error',
      eqeqeq: ['error', 'always'],
      'no-throw-literal': 'error'
    }
  }
];
