/**
 * @file
 *
 * ESLint configuration for TypeScript projects with various plugins.
 *
 * This module exports ESLint configurations for TypeScript projects, integrating multiple ESLint plugins
 * such as `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`,
 * `eslint-plugin-modules-newlines`, `@stylistic/eslint-plugin`.
 * It sets up parsers, plugins, and rules for maintaining code quality and consistency.
 */

import type { Linter } from 'eslint';

import commentsConfigs from '@eslint-community/eslint-plugin-eslint-comments/configs';
import {
  defineConfig,
  includeIgnoreFile
} from '@eslint/config-helpers';
import eslint from '@eslint/js';
// eslint-disable-next-line import-x/no-rename-default -- The default export name `plugin` is too confusing.
import stylistic from '@stylistic/eslint-plugin';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import { flatConfigs as eslintPluginImportXFlatConfigs } from 'eslint-plugin-import-x';
// eslint-disable-next-line import-x/no-rename-default, import-x/no-named-as-default -- The default export name `index` is too confusing.
import jsdoc from 'eslint-plugin-jsdoc';
import { configs as perfectionistConfigs } from 'eslint-plugin-perfectionist';
/* v8 ignore start -- Declarative ESLint rule/plugin configuration; correctness is verified by running ESLint, not unit tests. */
import eslintPluginTsdoc from 'eslint-plugin-tsdoc';
// eslint-disable-next-line import-x/no-rename-default -- The default export name `index` is too confusing.
import unicorn from 'eslint-plugin-unicorn';
import { existsSync } from 'node:fs';
import { join } from 'node:path/posix';
// eslint-disable-next-line import-x/no-rename-default -- The default export name `_default` is too confusing.
import tseslint from 'typescript-eslint';

import { obsidianDevUtilsPlugin } from './helpers/eslint-rules/obsidian-dev-utils-plugin.ts';
import { getRootFolder } from './helpers/root.ts';

const rootConfigFiles = [
  'commitlint.config.ts',
  'eslint.config.mts',
  'vitest.config.ts'
];
const sourceFiles = ['src/**/*.ts'];
const scriptFiles = ['scripts/**/*.ts'];
const testFiles = ['**/*.test.ts'];
const allFiles = [...sourceFiles, ...scriptFiles, ...rootConfigFiles];

/**
 * Build ESLint configurations.
 *
 * This function builds ESLint configurations for TypeScript projects, integrating multiple ESLint plugins
 *
 * @param params - The parameters for defining ESLint configurations.
 * @returns The ESLint configurations.
 */
export const configs = defineConfig(
  ...getGitIgnoreConfigs(),
  ...getEslintConfigs(),
  ...getTseslintConfigs(),
  ...getStylisticConfigs(),
  ...getImportXConfigs(),
  ...getPerfectionistConfigs(),
  ...getUnicornConfigs(),
  ...getEslintImportResolverTypescriptConfigs(),
  ...getEslintCommentsConfigs(),
  ...getObsidianDevUtilsPluginConfigs(),
  ...getJsdocsConfigs(),
  ...getNoRestrictedSyntaxRulesConfigs(),
  ...getTsdocsConfigs()
);

function getEslintCommentsConfigs(): Linter.Config[] {
  return defineConfig([
    {
      // eslint-disable-next-line import-x/no-named-as-default-member -- The default export name `recommended` is too confusing.
      extends: [commentsConfigs.recommended],
      files: allFiles,
      rules: {
        '@eslint-community/eslint-comments/require-description': 'error'
      }
    }
  ]);
}

function getEslintConfigs(): Linter.Config[] {
  return defineConfig([
    {
      extends: [eslint.configs.recommended],
      files: allFiles,
      rules: {
        'accessor-pairs': 'error',
        'array-callback-return': 'error',
        'camelcase': 'error',
        'capitalized-comments': ['error', 'always', { block: { ignorePattern: 'v8' } }],
        'complexity': 'error',
        'consistent-this': 'error',
        'curly': 'error',
        'default-case': 'error',
        'default-case-last': 'error',
        'default-param-last': 'error',
        'eqeqeq': 'error',
        'func-name-matching': 'error',
        'func-names': 'error',
        'func-style': [
          'error',
          'declaration',
          {
            allowArrowFunctions: false
          }
        ],
        'grouped-accessor-pairs': [
          'error',
          'getBeforeSet'
        ],
        'guard-for-in': 'error',
        'no-alert': 'error',
        'no-array-constructor': 'error',
        'no-bitwise': 'error',
        'no-caller': 'error',
        'no-console': [
          'error',
          {
            allow: [
              'warn',
              'error'
            ]
          }
        ],
        'no-constructor-return': 'error',
        'no-div-regex': 'error',
        'no-else-return': [
          'error',
          {
            allowElseIf: false
          }
        ],
        'no-empty-function': 'error',
        'no-extend-native': 'error',
        'no-extra-bind': 'error',
        'no-extra-label': 'error',
        'no-implicit-coercion': [
          'error',
          {
            allow: [
              '!!'
            ]
          }
        ],
        'no-implied-eval': 'error',
        'no-inner-declarations': 'error',
        'no-iterator': 'error',
        'no-label-var': 'error',
        'no-labels': 'error',
        'no-lone-blocks': 'error',
        'no-lonely-if': 'error',
        'no-loop-func': 'error',
        'no-magic-numbers': [
          'error',
          {
            detectObjects: true,
            enforceConst: true,
            ignore: [
              -1,
              0,
              1
            ]
          }
        ],
        'no-multi-assign': 'error',
        'no-multi-str': 'error',
        'no-negated-condition': 'error',
        'no-nested-ternary': 'error',
        'no-new-func': 'error',
        'no-new-wrappers': 'error',
        'no-object-constructor': 'error',
        'no-octal-escape': 'error',
        'no-promise-executor-return': 'error',
        'no-proto': 'error',
        'no-return-assign': 'error',
        'no-script-url': 'error',
        'no-self-compare': 'error',
        'no-sequences': 'error',
        'no-shadow': 'error',
        'no-template-curly-in-string': 'error',
        'no-throw-literal': 'error',
        'no-unmodified-loop-condition': 'error',
        'no-unneeded-ternary': 'error',
        'no-unreachable-loop': 'error',
        'no-unused-expressions': 'error',
        'no-useless-assignment': 'error',
        'no-useless-call': 'error',
        'no-useless-computed-key': 'error',
        'no-useless-concat': 'error',
        'no-useless-constructor': 'error',
        'no-useless-rename': 'error',
        'no-useless-return': 'error',
        'no-var': 'error',
        'no-void': 'error',
        'object-shorthand': 'error',
        'operator-assignment': 'error',
        'prefer-arrow-callback': 'error',
        'prefer-const': 'error',
        'prefer-exponentiation-operator': 'error',
        'prefer-named-capture-group': 'error',
        'prefer-numeric-literals': 'error',
        'prefer-object-has-own': 'error',
        'prefer-object-spread': 'error',
        'prefer-promise-reject-errors': 'error',
        'prefer-regex-literals': 'error',
        'prefer-rest-params': 'error',
        'prefer-spread': 'error',
        'prefer-template': 'error',
        'radix': 'error',
        'require-atomic-updates': 'error',
        'require-await': 'error',
        'symbol-description': 'error',
        'unicode-bom': 'error',
        'vars-on-top': 'error',
        'yoda': 'error'
      }
    },
    {
      files: [...testFiles, 'scripts/eslint-config.ts'],
      rules: {
        'no-magic-numbers': 'off'
      }
    },
    {
      files: ['scripts/helpers/@types/markdownlint-cli2-config-schema.d.ts'],
      rules: {
        'no-restricted-syntax': 'off'
      }
    },
    {
      files: scriptFiles,
      rules: {
        'no-console': 'off'
      }
    }
  ]);
}

function getEslintImportResolverTypescriptConfigs(): Linter.Config[] {
  return defineConfig([
    {
      settings: {
        'import-x/resolver-next': [
          createTypeScriptImportResolver({
            alwaysTryTypes: true
          })
        ]
      }
    }
  ]);
}

function getGitIgnoreConfigs(): Linter.Config[] {
  const gitignorePath = join(getRootFolder() ?? '', '.gitignore');
  if (!existsSync(gitignorePath)) {
    return [];
  }
  return [includeIgnoreFile(gitignorePath)];
}

function getImportXConfigs(): Linter.Config[] {
  return defineConfig([
    {
      extends: [
        eslintPluginImportXFlatConfigs.recommended,
        eslintPluginImportXFlatConfigs.typescript,
        eslintPluginImportXFlatConfigs.errors,
        eslintPluginImportXFlatConfigs.warnings
      ],
      files: allFiles,
      rules: {
        'import-x/consistent-type-specifier-style': 'error',
        'import-x/extensions': ['error', 'ignorePackages'],
        'import-x/first': 'error',
        'import-x/imports-first': 'error',
        'import-x/newline-after-import': 'error',
        'import-x/no-absolute-path': 'error',
        'import-x/no-amd': 'error',
        'import-x/no-anonymous-default-export': 'error',
        'import-x/no-commonjs': 'error',
        'import-x/no-cycle': 'error',
        'import-x/no-default-export': 'error',
        'import-x/no-deprecated': 'error',
        'import-x/no-duplicates': 'error',
        'import-x/no-dynamic-require': 'error',
        'import-x/no-empty-named-blocks': 'error',
        'import-x/no-extraneous-dependencies': 'error',
        'import-x/no-import-module-exports': 'error',
        'import-x/no-mutable-exports': 'error',
        'import-x/no-named-default': 'error',
        'import-x/no-namespace': 'error',
        'import-x/no-nodejs-modules': 'off',
        'import-x/no-relative-packages': 'error',
        'import-x/no-restricted-paths': 'error',
        'import-x/no-self-import': 'error',
        'import-x/no-unassigned-import': [
          'error',
          {
            allow: [
              '**/*.css',
              '**/*.sass',
              '**/*.scss'
            ]
          }
        ],
        'import-x/no-unused-modules': 'off',
        'import-x/no-useless-path-segments': 'error',
        'import-x/no-webpack-loader-syntax': 'error'
      }
    },
    {
      files: rootConfigFiles,
      rules: {
        'import-x/no-default-export': 'off'
      }
    }
  ]);
}

function getJsdocsConfigs(): Linter.Config[] {
  return defineConfig([
    {
      ...jsdoc.configs['flat/recommended-typescript-error'],
      files: sourceFiles,
      ignores: testFiles
    },
    {
      files: sourceFiles,
      ignores: testFiles,
      plugins: {
        jsdoc
      },
      rules: {
        'jsdoc/check-tag-names': [
          'error',
          {
            definedTags: [
              'fileoverview',
              'remarks',
              'typeParam'
            ]
          }
        ],
        /*
         * Empty JSDoc blocks are never a valid substitute for real documentation, regardless of how they appear
         * (hand-written or inserted by `jsdoc/require-jsdoc`'s autofix as a placeholder). `enableFixer: false` keeps
         * the empty block in place and reports it, forcing a real description to be written instead of silently
         * deleting the placeholder and re-triggering `require-jsdoc`.
         */
        'jsdoc/no-blank-blocks': ['error', { enableFixer: false }],
        'jsdoc/require-description': 'error',
        'jsdoc/require-file-overview': [
          'error',
          {
            tags: {
              fileoverview: {
                initialCommentsOnly: true,
                mustExist: true,
                preventDuplicates: true
              }
            }
          }
        ],
        'jsdoc/require-jsdoc': [
          'error',
          {
            contexts: [
              {
                context: 'ExportNamedDeclaration > FunctionDeclaration'
              },
              {
                context: 'ExportDefaultDeclaration > FunctionDeclaration'
              },
              {
                context: 'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression'
              },
              {
                context: 'ExportDefaultDeclaration > ArrowFunctionExpression'
              },
              {
                context: 'ExportNamedDeclaration MethodDefinition:not([accessibility="private"])'
              },
              {
                context: 'ExportDefaultDeclaration MethodDefinition:not([accessibility="private"])'
              },
              {
                context: 'ExportNamedDeclaration > ClassDeclaration > ClassBody > PropertyDefinition:not([accessibility=\'private\'])'
              },
              {
                context: 'ExportDefaultDeclaration > ClassDeclaration > ClassBody > PropertyDefinition:not([accessibility=\'private\'])'
              },
              {
                context: 'ExportNamedDeclaration > ClassDeclaration > ClassBody > TSAbstractPropertyDefinition:not([accessibility=\'private\'])'
              },
              {
                context: 'ExportDefaultDeclaration > ClassDeclaration > ClassBody > TSAbstractPropertyDefinition:not([accessibility=\'private\'])'
              },
              {
                context: 'ExportNamedDeclaration > TSInterfaceDeclaration'
              },
              {
                context: 'ExportNamedDeclaration > TSTypeAliasDeclaration'
              },
              {
                context: 'ExportNamedDeclaration > TSEnumDeclaration'
              },
              {
                context: 'ExportNamedDeclaration > ClassDeclaration'
              },
              {
                context: 'ExportDefaultDeclaration > ClassDeclaration'
              }
            ],
            publicOnly: false,
            require: {
              ArrowFunctionExpression: false,
              ClassDeclaration: false,
              ClassExpression: false,
              FunctionDeclaration: false,
              MethodDefinition: false
            }
          }
        ],
        'jsdoc/require-throws-type': 'off',
        'jsdoc/tag-lines': [
          'error',
          'any',
          {
            startLines: 1
          }
        ]
      },
      settings: {
        jsdoc: {
          tagNamePreference: {
            template: 'typeParam'
          }
        }
      }
    }
  ]);
}

function getNoRestrictedSyntaxRulesConfigs(): Linter.Config[] {
  return defineConfig([
    {
      files: allFiles,
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            message: 'Do not use definite assignment assertions (!). Initialize the field or make it optional.',
            selector: 'PropertyDefinition[definite=true]'
          },
          {
            message: 'Do not use definite assignment assertions (!) on abstract fields.',
            selector: 'TSAbstractPropertyDefinition[definite=true]'
          },
          {
            message: 'Do not use double type assertions (as X as Y). Use strictProxy<T>() or ensureGenericObject() instead.',
            selector: 'TSAsExpression > TSAsExpression'
          },
          {
            message: 'Do not use _ prefix on methods or functions. The _ prefix is for unused parameters only.',
            selector: 'MethodDefinition[key.name=/^_/]:not([override=true])'
          },
          {
            message: 'Do not use _ prefix on methods or functions. The _ prefix is for unused parameters only.',
            selector: 'FunctionDeclaration[id.name=/^_/]'
          },
          {
            message: 'Do not rename imports with "Mock" in the alias. Mock classes are the canonical types — use the original name.',
            selector: 'ImportSpecifier[local.name=/Mock/]:not([imported.name=/Mock/])'
          },
          {
            message: 'Avoid dynamic import(). Use static imports instead. Only use dynamic imports for lazy/conditional loading.',
            selector: 'ImportExpression'
          },
          {
            message: 'Do not use `declare` on class properties. Initialize the property or use a regular type annotation.',
            selector: 'PropertyDefinition[declare=true]'
          },
          {
            message: 'Do not use anonymous inline object types. Define a named interface or `type` alias instead.',
            selector: 'TSTypeLiteral:not(TSTypeAliasDeclaration > TSTypeLiteral)'
          },
          {
            message: 'Do not use anonymous inline mapped types. Define a named `type` alias instead.',
            selector: 'TSMappedType:not(TSTypeAliasDeclaration > TSMappedType)'
          }
        ]
      }
    },
    {
      files: ['scripts/helpers/@types/markdownlint-cli2-config-schema.d.ts'],
      rules: {
        'no-restricted-syntax': 'off'
      }
    }
  ]);
}

function getObsidianDevUtilsPluginConfigs(): Linter.Config[] {
  return defineConfig([
    {
      files: allFiles,
      plugins: {
        'obsidian-dev-utils': obsidianDevUtilsPlugin
      },
      rules: {
        'obsidian-dev-utils/no-unused-params-members': 'error',
        'obsidian-dev-utils/no-used-underscore-variables': 'error',
        'obsidian-dev-utils/readonly-params-options-result-members': 'error'
      }
    }
  ]);
}

function getPerfectionistConfigs(): Linter.Config[] {
  return defineConfig([{
    extends: [perfectionistConfigs['recommended-alphabetical']],
    files: allFiles
  }]);
}

function getStylisticConfigs(): Linter.Config[] {
  return defineConfig([
    {
      extends: [
        stylistic.configs.recommended,
        stylistic.configs.customize({
          arrowParens: true,
          braceStyle: '1tbs',
          commaDangle: 'never',
          semi: true
        })
      ],
      files: allFiles,
      rules: {
        '@stylistic/generator-star-spacing': 'off',
        '@stylistic/indent': 'off',
        '@stylistic/indent-binary-ops': 'off',
        '@stylistic/jsx-one-expression-per-line': 'off',
        '@stylistic/no-extra-semi': 'error',
        '@stylistic/object-curly-newline': [
          'error',
          {
            ExportDeclaration: {
              minProperties: 2,
              multiline: true
            },
            ImportDeclaration: {
              minProperties: 2,
              multiline: true
            }
          }
        ],
        '@stylistic/operator-linebreak': [
          'error',
          'before',
          {
            overrides: {
              '=': 'after'
            }
          }
        ],
        '@stylistic/quotes': [
          'error',
          'single',
          {
            allowTemplateLiterals: 'never'
          }
        ]
      }
    }
  ]);
}

function getTsdocsConfigs(): Linter.Config[] {
  return defineConfig([
    {
      files: sourceFiles,
      ignores: testFiles,
      plugins: {
        tsdoc: eslintPluginTsdoc
      }
    }
  ]);
}

function getTseslintConfigs(): Linter.Config[] {
  return defineConfig([
    {
      extends: [
        // eslint-disable-next-line import-x/no-named-as-default-member -- The default export name `_default` is too confusing.
        ...tseslint.configs.strictTypeChecked,
        // eslint-disable-next-line import-x/no-named-as-default-member -- The default export name `_default` is too confusing.
        ...tseslint.configs.stylisticTypeChecked
      ],
      files: allFiles,
      languageOptions: {
        parserOptions: {
          ecmaFeatures: {
            jsx: true
          },
          projectService: true,
          // eslint-disable-next-line unicorn/name-replacements -- `tsconfigRootDir` is a `typescript-eslint` parser option name.
          tsconfigRootDir: getRootFolder() ?? ''
        }
      },
      rules: {
        '@typescript-eslint/explicit-function-return-type': 'error',
        '@typescript-eslint/explicit-member-accessibility': 'error',
        '@typescript-eslint/no-invalid-void-type': ['error', {
          allowAsThisParameter: true
        }],
        '@typescript-eslint/no-this-alias': ['error', {
          allowedNames: [
            'that'
          ]
        }],
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            // eslint-disable-next-line unicorn/name-replacements -- `args` is a `typescript-eslint` rule option name.
            args: 'all',
            // eslint-disable-next-line unicorn/name-replacements -- `argsIgnorePattern` is a `typescript-eslint` rule option name.
            argsIgnorePattern: '^_',
            caughtErrors: 'all',
            caughtErrorsIgnorePattern: '^_',
            destructuredArrayIgnorePattern: '^_',
            ignoreRestSiblings: true,
            // eslint-disable-next-line unicorn/name-replacements -- `varsIgnorePattern` is a `typescript-eslint` rule option name.
            varsIgnorePattern: '^_'
          }
        ],
        '@typescript-eslint/prefer-readonly': 'error',
        'obsidian-dev-utils/no-async-callback-to-unsafe-return': 'error',
        'obsidian-dev-utils/no-used-underscore-variables': 'error'
      }
    },
    {
      settings: {
        react: {
          version: 'detect'
        }
      }
    }
  ]);
}

function getUnicornConfigs(): Linter.Config[] {
  return defineConfig([
    {
      extends: [unicorn.configs.recommended],
      files: allFiles,
      rules: {
        /*
         * A good rule, but its default prefixes force ungrammatical names: `vaultExists` would become
         * `isVaultExists` rather than `doesVaultExist`. These entries EXTEND the defaults (`is`, `has`, `can`,
         * `should`, ...) rather than replacing them, so a boolean with no boolean-reading prefix at all is still
         * rejected -- the rule just stops insisting the prefix come from a shorter list.
         *
         * The list is bidirectional: adding a prefix also asserts that everything named with it IS a boolean.
         * `check` earns its place on both counts: it validates the `checkIs*` predicate family (`checkIsLockStale`,
         * `checkIsRemovableDir`, `checkIsProcessAlive`, ...), and most of the non-boolean `check*` names it
         * surfaced were genuinely mis-named -- the `scripts/version.ts` preflight helpers throw rather than
         * return, and now say `assert*`. Turning it OFF was measured and rejected: it costs nine real predicates
         * to spare three exported verdict-returning functions, which carry a scoped disable instead.
         */
        'unicorn/consistent-boolean-name': [
          'error',
          {
            prefixes: {
              allows: true,
              check: true,
              contains: true,
              does: true,
              includes: true,
              must: true,
              needs: true,
              supports: true
            }
          }
        ],
        /*
         * Unsatisfiable alongside `perfectionist/sort-classes`, which is configured here as a plain alphabetical
         * sort. This rule wants a category order (all fields, then the constructor, then all methods), so a
         * `private _x` field paired with a `public get x()` accessor is rejected by whichever rule loses:
         * alphabetically the accessor precedes the field, by category the field precedes the accessor. Both are
         * `error` and this rule ships no fixer, so no arrangement of members satisfies them both. The
         * alphabetical sort is the one already rolled out here, so it keeps precedence.
         */
        'unicorn/consistent-class-member-order': 'off',
        /*
         * The default style for `node:path` is a default import, but this codebase imports its members by name
         * throughout, consistently with every other `node:` module it uses. Configure the rule to enforce the
         * style actually in use rather than annotate every site that is not going to change.
         */
        'unicorn/import-style': [
          'error',
          {
            styles: {
              // Keyed by the UNPREFIXED module name: the rule's own table uses `path`, so a `node:path` key never matches.
              path: {
                named: true
              }
            }
          }
        ],
        /*
         * The rule counts constructor calls and counts through array and object literals, so its default of 3
         * reports ordinary composition. Raising the limit by one clears the noise while still catching the
         * genuinely unreadable nesting the rule is for.
         */
        'unicorn/max-nested-calls': [
          'error',
          {
            max: 4
          }
        ],
        'unicorn/name-replacements': [
          'error',
          {
            /*
             * Property and member names are checked too, so an abbreviation cannot survive by living on an
             * object rather than in a variable.
             *
             * The rule is purely syntactic: it cannot tell a member we declare from one belonging to a
             * dependency, and it offers no autofix for properties. Sites naming a foreign member carry an inline
             * disable, so everything still reported is ours to rename.
             *
             * The disabled replacements below are established vocabulary rather than abbreviations to be
             * expanded. `params` is the parameter-bag convention, enforced by
             * `obsidian-dev-utils/readonly-params-options-result-members` and its siblings, which require bag
             * types to be named `<Owner>Params` / `<Owner>Options`; expanding it to `Parameters` would put the
             * two rules in direct contradiction. `el` is exempt because Obsidian names every element member that
             * way (`containerEl`, `contentEl`, `inputEl`), so expanding ours would leave this harness reading
             * inconsistently beside the Obsidian API it drives. `dev`, `lib`, `util`/`utils`, `doc`/`docs`,
             * `env`, `dist` and `src` are the clearer spelling here and name real directories and entry points.
             *
             * NOTE: this rule's autofix is NOT reference-aware for declarations that participate in a contract --
             * enum members, interface members, and TypeScript parameter properties are renamed while
             * `this.member` and `Enum.Member` references are left dangling. Apply its reports by hand; never run
             * `--fix` over it.
             */
            checkProperties: true,
            replacements: {
              /*
               * `attr` / `attrs` are Obsidian's own: `createEl('a', { attr: { ... } })` takes them by those
               * names on `DomElementInfo`, so ours have to match to be passed through. `props` is the universal
               * component vocabulary, exempt for the same reason `params` is.
               */
              attr: false,
              attrs: false,
              dev: false,
              /*
               * Every `dir` here is a filesystem directory, never a direction, so the rule is narrowed to the
               * one expansion rather than left offering a choice it cannot make.
               */

              // eslint-disable-next-line unicorn/name-replacements -- This is the rule's own replacement key, which has to be spelled the way the rule reads it.
              dir: {
                direction: false,
                directory: true
              },
              dist: false,
              doc: false,
              docs: false,
              el: false,
              env: false,
              lib: false,
              params: false,
              props: false,
              ref: false,
              refs: false,
              src: false,
              util: false,
              utils: false
            }
          }
        ],
        /*
         * The next six rules all suggest an API newer than this project's `lib` (`ES2022`), so following any of
         * them fails to compile. The target is not arbitrary: `metadata.json` in this repo records
         * `ecmaScriptVersion: "ES2022"` for installer 1.1.9, the oldest one still able to run current Obsidian,
         * and this harness has to keep working against it. Each is off at the config level rather than annotated
         * per site, because none can ever be satisfied while that floor holds. Revisit them together if the
         * floor moves.
         *
         * `Array#toReversed` and `Array#toSorted` are ES2023.
         */
        'unicorn/no-array-reverse': 'off',
        'unicorn/no-array-sort': 'off',
        /*
         * `continue` inside a nested loop is ordinary, readable control flow here. The rule's remedy is to
         * extract every such loop into its own function, which spreads one coherent traversal across two
         * declarations without making anything clearer.
         */
        'unicorn/no-break-in-nested-loop': 'off',
        /*
         * Every report is a group of named constants or destructured params deliberately gathered at the top of
         * a function; pushing each one below the first guard splits a cohesive block to no benefit. The rule
         * also cannot see through a hoisted function declaration, so a binding a nested function already reads
         * looks unused before the exit, and its own fixer declines those sites for the same reason.
         */
        'unicorn/no-declarations-before-early-exit': 'off',
        /*
         * Installing the harness namespace ON a global object is what this package does: the Node side writes
         * `globalThis.__obsidianIntegrationTesting` so test workers can read the setup result, and the injected
         * renderer bootstrap writes the same key onto Obsidian's `window`. The rule cannot separate that from an
         * accidental global write, and it has no fixer.
         */
        'unicorn/no-global-object-property-assignment': 'off',
        /*
         * The rule's list of standard `Symbol` properties predates explicit resource management, so it reports
         * `Symbol.dispose` and `Symbol.asyncDispose` as non-standard. Every report here is an `await using`
         * disposable (`ContextId`, `TemporaryVault`, the CDP connection) -- part of this package's public surface, so
         * they are the rule being out of date rather than a finding.
         */
        'unicorn/no-nonstandard-builtin-properties': 'off',
        // `null` is load-bearing here: an optional collaborator is modelled as a required `null | X` field rather than an optional `X`, so `null` and `undefined` are not interchangeable.
        'unicorn/no-null': 'off',
        /*
         * TypeScript's explicit `this` parameter makes `this` outside a class both legal and type-checked, but
         * the rule is syntactic and flags it identically to a genuinely unbound `this`. It has no options and no
         * fixer, so there is no way to separate the idiom from the bug it targets. The report here is a
         * monkey-patched `app.plugins.loadPlugin`, which must forward `this` to the original.
         */
        'unicorn/no-this-outside-of-class': 'off',
        /*
         * Module-level state written from a function is this package's registry / cache / once-guard pattern:
         * `setTransportOptionsResolver` and `setVaultPathResolver` exist precisely to install a resolver into
         * module scope, `createTransport` memoizes the transport there, and the process-cleanup handler is
         * registered behind a module-level once-flag. The rule's remedy -- hold the state in a `const` object --
         * renames every read for no behavioral gain. The same shape is standard in tests, where a fixture is
         * assigned from `beforeEach`.
         */
        'unicorn/no-top-level-assignment-in-function': 'off',
        /*
         * Module-initialization side effects ARE the contract for this package's entry points: the framework
         * setup modules register their context resolvers at import time (see AGENTS.md L6), and the script
         * entry points call `exitIfScriptDisabled()` / `defineObsidianMetadataGlobal()` before anything reads
         * what they set up. Deferring them into a function would mean consumers had to call something extra,
         * which is exactly what these modules exist to avoid.
         */
        'unicorn/no-top-level-side-effects': 'off',
        /*
         * The destructuring depth flagged here is deliberate and reads well -- `const [, , ...paths] =
         * process.argv` drops the node and script arguments in one step, and the rule's remedy (`.slice(2)`)
         * trades a self-explaining pattern for a magic number.
         */
        'unicorn/no-unreadable-array-destructuring': 'off',
        /*
         * The reports are all `for (const entry of readdirSync(...))` and the like, which read exactly as
         * intended. Hoisting the call into a variable named after the loop's own iterable adds a line and a name
         * without adding information.
         */
        'unicorn/no-unreadable-for-of-expression': 'off',
        /*
         * `checkArguments` strips `undefined` arguments, which shifts the remaining positional arguments into
         * the wrong slots; `checkArrowFunctionBody` rewrites `() => undefined` to `() => {}`, which then trips
         * `@typescript-eslint/no-empty-function`. The rule's remaining cases (a bare `undefined` initializer,
         * `return undefined;` in a void function) are still worth having.
         */
        'unicorn/no-useless-undefined': [
          'error',
          {
            checkArguments: false,
            checkArrowFunctionBody: false
          }
        ],
        // `Array.fromAsync` is ES2024. See the ES2022 floor note above.
        'unicorn/prefer-array-from-async': 'off',
        /*
         * Every hit here is a promise deliberately NOT awaited, and `await` would change what the code does: a
         * `.catch()` on a poll scheduled from `setInterval`, the fire-and-forget teardown of every still-active
         * setup from a `beforeExit` handler, and a `.then()` branch inside a `Promise.all`. The rule cannot tell
         * a forgotten `await` from an intentional one, and this harness schedules fire-and-forget work as a core
         * pattern.
         */
        'unicorn/prefer-await': 'off',
        /*
         * Iterator helpers (`Iterator#some` and friends) are ES2025, so this belongs with `no-array-reverse` and
         * `no-array-sort` above: the same ES2022 floor rules it out, and the same note applies -- revisit them
         * together if that floor moves.
         */
        'unicorn/prefer-iterator-helpers': 'off',
        // `Iterator#toArray` is ES2025. See the ES2022 floor note above.
        'unicorn/prefer-iterator-to-array': 'off',
        /*
         * The suggested replacement is `Math.trunc(Number(x))`, which is longer than `Number.parseInt(x, 10)`
         * and not the same function: `parseInt` stops at the first character that cannot be part of the number,
         * so `'114.0.5735.289'` parses to 114 where `Number` yields `NaN`. Both reports read a dotted version
         * string through exactly that difference, which is the documented behavior at each site.
         */
        'unicorn/prefer-number-coercion': 'off',
        // `Promise.withResolvers` is ES2024. See the ES2022 floor note above.
        'unicorn/prefer-promise-with-resolvers': 'off',
        // `Set#union` and friends are ES2025. See the ES2022 floor note above.
        'unicorn/prefer-set-methods': 'off',
        /*
         * The rule ranks operands by syntactic shape, not cost, so every report here swaps one property read
         * ahead of another and buys nothing. Its own message concedes it cannot check the part that matters --
         * "after verifying short-circuit behavior". The current orders also carry intent: a platform guard
         * before the value it guards, and the success condition reported before the error state it contradicts.
         */
        'unicorn/prefer-simple-condition-first': 'off',
        /*
         * `URL.canParse` requires Node 18.17, above the Node 16.16.0 floor that the oldest still-runnable
         * Obsidian installer (1.1.9, Electron 21.3.3) ships. The rule can therefore never be satisfied for code
         * that has to run there, so it is off at the config level rather than annotated at each call site.
         */
        'unicorn/prefer-url-can-parse': 'off',
        /*
         * The array reported here holds strings, where the default sort is already well defined and correct.
         * Adding the comparator the rule asks for would mean choosing between code-unit and locale ordering, so
         * following it would CHANGE the sort rather than document it. The rule earns its place on numeric
         * arrays; it does not have any here.
         */
        'unicorn/require-array-sort-compare': 'off',
        // The codebase already spells encodings the way the Encoding Standard does (`utf-8`), which is also what `TextDecoder` reports. Keep the rule enforcing consistency, just in the direction already in use.
        'unicorn/text-encoding-identifier-case': [
          'error',
          {
            withDash: true
          }
        ]
      }
    },
    {
      /*
       * Unsatisfiable in this file alongside `perfectionist/sort-union-types`, and the clash is a genuine
       * circular fix rather than a style preference: every rule option in the vendored markdownlint schema is
       * `boolean | { ... }`, so this rule moves the object literal to the end and the alphabetical sort moves it
       * straight back in front of `boolean`. Both ship fixers and both are `error`, so `--fix` never converges.
       * The file is generated from markdownlint's published JSON schema, so neither order is ours to choose.
       */
      files: ['scripts/helpers/@types/*.d.ts'],
      rules: {
        /*
         * These are vendored ambient declarations transcribed from a dependency's own published schema /
         * type surface. Their member and type names have to match what the dependency ships, so neither the
         * abbreviation expansions nor the union ordering below is ours to choose.
         */
        'unicorn/name-replacements': 'off',
        'unicorn/prefer-type-literal-last': 'off'
      }
    },
    {
      // Build/lint/version scripts are CLI entry points, where exiting with a status code is the interface.
      files: scriptFiles,
      rules: {
        'unicorn/no-process-exit': 'off'
      }
    },
    {
      files: testFiles,
      rules: {
        /*
         * A helper defined inside an `evalInObsidian` callback cannot be hoisted at all: the callback is
         * serialized with `toString()` and runs inside Obsidian, so anything left behind in the module scope is
         * simply not there. A per-suite factory is also deliberately local, keeping each suite's fixture next to
         * the assertions that read it. Production code keeps the check.
         */
        'unicorn/consistent-function-scoping': 'off'
      }
    }
  ]);
}

/* v8 ignore stop */
