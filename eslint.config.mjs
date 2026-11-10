import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['coverage/**', 'node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      complexity: ['error', 15],
      'max-depth': ['error', 3],
      'max-len': [
        'error',
        {
          code: 120,
          comments: 120,
          ignoreUrls: true,
          ignoreRegExpLiterals: true,
        },
      ],
      'max-lines-per-function': [
        'error',
        { max: 50, skipBlankLines: true, skipComments: true },
      ],
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
];
