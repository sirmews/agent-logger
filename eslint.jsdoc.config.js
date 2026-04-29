import tseslint from "typescript-eslint";
import jsdoc from "eslint-plugin-jsdoc";

export default tseslint.config(
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: { jsdoc },
    rules: {
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: {
            FunctionDeclaration: true,
            ArrowFunctionExpression: true,
            FunctionExpression: true,
            ClassDeclaration: false,
            MethodDefinition: false,
          },
        },
      ],
      "jsdoc/require-description": ["error", { descriptionStyle: "any" }],
      "jsdoc/check-tag-names": "error",
    },
  },
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.test.ts",
      "**/__tests__/**",
      "**/deprecated/**",
    ],
  },
);
