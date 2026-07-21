import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist', '**/node_modules', '**/.next', '**/next-env.d.ts', '**/*.js', '**/*.mjs'],
  },
  ...tseslint.configs.recommended,
  prettierConfig,
);
