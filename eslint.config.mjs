import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
    // Global ignores
    {
        ignores: [
            'out/**',
            'dist/**',
            'coverage/**',
            '.build-resources/**',
            'node_modules/**',
            '*.config.*',
        ],
    },

    // Base JS recommended rules
    js.configs.recommended,

    // TypeScript recommended rules
    ...tseslint.configs.recommended,

    // React hooks rules
    {
        files: ['src/**/*.{ts,tsx}'],
        plugins: {
            'react-hooks': reactHooks,
        },
        rules: {
            ...reactHooks.configs.recommended.rules,
        },
    },

    // Project-specific overrides
    {
        rules: {
            // Allow unused vars prefixed with _
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            // Allow explicit any in specific cases (already used in codebase)
            '@typescript-eslint/no-explicit-any': 'warn',
            // Allow require() in specific files (settingsManager fallback)
            '@typescript-eslint/no-require-imports': 'off',
        },
    },

    // Disable rules that conflict with Prettier (must be last)
    prettier,
);
