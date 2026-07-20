import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist', '**/node_modules', '**/.next', '**/*.js', '**/*.mjs'] },
  ...tseslint.configs.recommended,
  prettierConfig,
);
