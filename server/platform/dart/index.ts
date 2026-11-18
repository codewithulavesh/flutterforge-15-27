/**
 * Public API for the dependency-free Dart analysis engine.
 *
 * - `tokenize` / `significantTokens` / `stringLiteralText` — tolerant tokenizer
 * - `analyzeDart` — declaration index over significant tokens
 * - `buildImportGraph` — project import/part graph
 * - `validateDartFiles` — deterministic pre-write structural gate
 */
export * from './lexer.js';
export * from './ast.js';
export * from './imports.js';
export * from './validate.js';
