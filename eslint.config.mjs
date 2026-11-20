import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  { ignores: ['**/dist/', '**/node_modules/', '**/coverage/', 'backend/prisma/'] },

  // Base: recommended JS + TS rules for all files
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // All TS files: no explicit any, allow _prefixed unused vars
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Frontend React files: hooks + refresh rules
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // ARCHITECTURE §3 rule 3: simulation engine and recommend must not import Prisma or core/db
  {
    files: [
      'backend/src/modules/simulation/engine.ts',
      'backend/src/modules/simulation/recommend.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@prisma/client', '@prisma/client/*'], message: 'Simulation engine must not import Prisma (ARCHITECTURE §3 rule 3).' },
            { group: ['**/core/db', '**/core/db.js'], message: 'Simulation engine must not import core/db (ARCHITECTURE §3 rule 3).' },
          ],
        },
      ],
    },
  },
);
