/**
 * Lightweight Dart declaration index built on the tolerant tokenizer.
 *
 * This is a structural analyzer, not a full front-end: it walks the
 * significant token stream with a small hand-rolled recursive-descent pass and
 * extracts declarations (classes, mixins, extensions, enums, typedefs,
 * top-level functions/getters/setters and class members) plus import/export
 * and part directives. It never throws: malformed input yields whatever could
 * be recovered plus diagnostics in `errors`.
 *
 * Notable limits (deliberate, everything here is best-effort):
 * - Function bodies are skipped as balanced token regions; declarations nested
 *   inside function bodies (local functions/classes) are not indexed.
 * - Generic signatures are consumed and discarded; only the declared name,
 *   clause types and modifiers are kept.
 * - `mixin M on A, B` bounds are consumed but not reported.
 * - Extension `on` types are consumed but not reported.
 * - `library` directives are recognized and skipped; the library name is not
 *   exposed on symbols.
 */
import { tokenize, significantTokens, stringLiteralText } from './lexer.js';
import type { Token } from './lexer.js';

export type SymbolKind =
  | 'class'
  | 'mixin'
  | 'extension'
  | 'enum'
  | 'typedef'
  | 'function'
  | 'method'
  | 'getter'
  | 'setter'
  | 'operator'
  | 'constructor'
  | 'field'
  | 'variable';

export interface DartSymbol {
  kind: SymbolKind;
  name: string;
  /** Offset of the declaration name token. */
  offset: number;
  /** 1-based line of the declaration name token. */
  line: number;
  /** 1-based column of the declaration name token. */
  column: number;
  abstract: boolean;
  isStatic: boolean;
  /** Enclosing class/mixin/extension/enum name for members. */
  enclosing?: string;
  /** Names from an `extends` clause. Dotted chains, generics stripped. */
  extends?: string[];
  /** Names from an `implements` clause. */
  implements?: string[];
  /** Names from a `with` clause. */
  with?: string[];
}

export interface DirectiveConditional {
  /** Raw condition text between the parentheses, e.g. `dart.library.io`. */
  condition: string;
  uri: string;
}

export interface ImportDirective {
  kind: 'import' | 'export';
  /** Decoded URI of the default branch. */
  uri: string;
  offset: number;
  line: number;
  column: number;
  /** `as` prefix, if any. */
  prefix: string | null;
  deferred: boolean;
  /** Names listed in a `show` combinator, or null when absent. */
  show: string[] | null;
  /** Names listed in a `hide` combinator, or null when absent. */
  hide: string[] | null;
  /** `if (condition) 'uri'` configurational branches. */
  conditionals: DirectiveConditional[];
}

export interface PartDirective {
  kind: 'part' | 'partOf';
  /** URI for `part 'x.dart'` / `part of 'x.dart'`; null for the `part of name;` form. */
  uri: string | null;
  /** Library name for the `part of name;` form; null for URI forms. */
  name: string | null;
  offset: number;
  line: number;
  column: number;
}

export interface DartAnalysisError {
  code: string;
  message: string;
  offset: number;
  line: number;
  column: number;
}

export interface DartStats {
  /** Total line count (LF/CRLF aware, at least 1). */
  lines: number;
  /** Significant tokens seen, excluding comments (EOF included). */
  tokens: number;
  symbols: number;
  imports: number;
  exports: number;
  parts: number;
}

export interface DartAnalysis {
  symbols: DartSymbol[];
  imports: ImportDirective[];
  exports: ImportDirective[];
  parts: PartDirective[];
  errors: DartAnalysisError[];
  stats: DartStats;
}

const DECL_STOP = new Set<string>([
  'class', 'enum', 'mixin', 'extension', 'typedef',
  'extends', 'on', 'with', 'implements', 'show', 'hide',
  'import', 'export', 'part', 'library', 'get', 'set', 'operator',
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'return', 'throw', 'catch', 'finally', 'try', 'rethrow', 'assert',
  'new', 'this', 'super', 'break', 'continue', 'as', 'is', 'in',
]);

const MODIFIERS = new Set<string>([
  'abstract', 'base', 'sealed', 'interface', 'static', 'external',
  'factory', 'late', 'covariant', 'const', 'final', 'required',
]);

const CLAUSE_KEYWORDS = new Set<string>([
  'extends', 'implements', 'with', 'on', 'show', 'hide',
]);

function isIdentifierLike(token: Token | undefined): boolean {
  if (!token) return false;
  if (token.kind === 'identifier') return true;
  if (token.kind === 'keyword') return !DECL_STOP.has(token.value);
  return false;
}

function countChars(value: string, ch: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) if (value[i] === ch) count++;
  return count;
}

interface Modifiers {
  values: Set<string>;
  /** Index of the first token after the modifier run. */
  next: number;
}

interface TypeAndName {
  /** Index of the last identifier of the (dotted) declarator name. */
  nameIndex: number;
  /** Full dotted name, e.g. `Foo.bar`. */
  name: string;
  /** Index of the matching `<` for a generic declarator, or the position right after the name. */
  afterName: number;
}

class Parser {
  private readonly toks: Token[];
  private readonly source: string;

  constructor(toks: Token[], source: string) {
    this.toks = toks;
    this.source = source;
  }

  get length(): number {
    return this.toks.length;
  }

  collectModifiers(index: number): Modifiers {
    const values = new Set<string>();
    let i = index;
    for (;;) {
      const token = this.toks[i];
      if (!token) break;
      if (MODIFIERS.has(token.value)) {
        values.add(token.value);
        i++;
        continue;
      }
      break;
    }
    return { values, next: i };
  }

  /** Consume a dotted chain `A.B.C` starting at `index`. */
  consumeDottedChain(index: number): { first: string; name: string; full: string; end: number; lastIndex: number } {
    const first = this.toks[index];
    const parts = [first.value];
    let lastIndex = index;
    let i = index + 1;
    for (;;) {
      const dot = this.toks[i];
      const next = this.toks[i + 1];
      if (dot && dot.value === '.' && next && (next.kind === 'identifier' || next.kind === 'keyword')) {
        parts.push(next.value);
        lastIndex = i + 1;
        i += 2;
        continue;
      }
      break;
    }
    return { first: parts[0], name: parts[parts.length - 1], full: parts.join('.'), end: i, lastIndex };
  }

  /** Skip a balanced `<...>` region starting at `<`. Returns index after `>`. */
  skipAngled(index: number): number {
    if (this.toks[index]?.value !== '<') return index;
    let depth = 1;
    let i = index + 1;
    while (i < this.length) {
      const value = this.toks[i].value;
      if (value === '<') {
        depth++;
        i++;
        continue;
      }
      if (value.includes('>') && !/[A-Za-z0-9]/.test(value)) {
        depth -= countChars(value, '>');
        i++;
        if (depth <= 0) return i;
        continue;
      }
      i++;
      if (depth <= 0) return i;
    }
    return i;
  }

  /** Skip a balanced region of `open`/`close` tokens. Returns index after the closer (or at end of input). */
  skipBalanced(index: number, open: string, close: string): number {
    if (this.toks[index]?.value !== open) return index;
    let depth = 1;
    let i = index + 1;
    while (i < this.length) {
      const value = this.toks[i].value;
      if (value === open) depth++;
      else if (value === close) {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  }

  /** Skip a balanced `(...)` region starting at `(`. Returns index after `)`. */
  skipParens(index: number): number {
    return this.skipBalanced(index, '(', ')');
  }

  /** After a parameter list, consume `async`/`sync*` modifiers and the body or `;`. */
  skipCallableTail(index: number): number {
    let i = index;
    for (;;) {
      const value = this.toks[i]?.value;
      if (value === 'async' || value === 'sync' || value === '*') {
        i++;
        continue;
      }
      break;
    }
    const value = this.toks[i]?.value;
    if (value === '{') return this.skipBalanced(i, '{', '}');
    if (value === '=>') return this.skipExpression(i + 1);
    // Redirecting factory constructor: `factory Foo() = Foo.other;`
    if (value === '=') return this.skipExpression(i + 1);
    if (value === ';') return i + 1;
    return i;
  }

  /** Skip an expression up to a top-level `;` (consumed) or a region boundary (left in place). */
  skipExpression(index: number): number {
    let i = index;
    let depth = 0;
    while (i < this.length) {
      const value = this.toks[i].value;
      if (value === '(' || value === '[' || value === '{') depth++;
      else if (value === ')' || value === ']' || value === '}') {
        if (depth === 0) return i;
        depth--;
      } else if (value === ';' && depth === 0) return i + 1;
      i++;
    }
    return i;
  }

  /**
   * Skip an initializer expression up to a top-level `,` or `;`.
   * For `;` the delimiter is consumed; for `,` it is left in place.
   */
  skipInitializer(index: number): { next: number; delimiter: ',' | ';' | '}' | ')' | ']' | null } {
    let i = index;
    let depth = 0;
    while (i < this.length) {
      const value = this.toks[i].value;
      if (value === '(' || value === '[' || value === '{') depth++;
      else if (value === ')' || value === ']' || value === '}') {
        if (depth === 0) return { next: i, delimiter: value as '}' | ')' | ']' };
        depth--;
      } else if (value === ',' && depth === 0) return { next: i, delimiter: ',' };
      else if (value === ';' && depth === 0) return { next: i + 1, delimiter: ';' };
      i++;
    }
    return { next: i, delimiter: null };
  }

  /**
   * Scan the maximal run of type-ish tokens starting at `index` (angle-aware,
   * `void Function(int)`-safe). Returns the index after the run.
   *
   * The run may cover `Map<String, int> counts` in its entirety — the split
   * between type and declarator name is recovered by `splitTypeAndName`.
   */
  scanTypeSpec(index: number): number {
    let i = index;
    let angle = 0;
    while (i < this.length) {
      const token = this.toks[i];
      const value = token.value;
      if (angle === 0 && DECL_STOP.has(value)) break;
      if (token.kind === 'identifier' || token.kind === 'keyword') {
        if (value === 'Function' && this.toks[i + 1]?.value === '(') {
          i = this.skipParens(i + 1);
          continue;
        }
        i++;
        continue;
      }
      if (value === '.' || value === '?' || value === '&' || value === '[' || value === ']') {
        i++;
        continue;
      }
      if (value === '<') {
        angle++;
        i++;
        continue;
      }
      if (value.includes('>') && !/[A-Za-z0-9]/.test(value)) {
        angle = Math.max(0, angle - countChars(value, '>'));
        i++;
        continue;
      }
      if (angle > 0 && value === ',') {
        i++;
        continue;
      }
      break;
    }
    return i;
  }

  /**
   * Split a type-spec run scanned by `scanTypeSpec` into (type, declarator
   * name). The name is the trailing dotted chain, possibly preceded by a
   * generic parameter list `<T, S extends Foo>` for generic callables.
   */
  splitTypeAndName(start: number, specEnd: number): TypeAndName | null {
    let nameEnd = specEnd;
    const last = this.toks[specEnd - 1];
    if (last && last.value.includes('>') && !/[A-Za-z0-9]/.test(last.value)) {
      // Walk backwards to the matching `<`.
      let i = specEnd - 1;
      let depth = countChars(last.value, '>');
      while (i > start) {
        i--;
        const value = this.toks[i].value;
        if (value.includes('>') && !/[A-Za-z0-9]/.test(value)) depth += countChars(value, '>');
        if (value === '<') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) return null;
      nameEnd = i; // position of `<`; the name ends right before it
    }
    // The name is the dotted chain ending at nameEnd - 1.
    let k = nameEnd - 1;
    if (k < start || !isIdentifierLike(this.toks[k])) return null;
    const nameIndex = k;
    while (k - 2 >= start && this.toks[k - 1]?.value === '.' && isIdentifierLike(this.toks[k - 2])) {
      k -= 2;
    }
    const name = this.toks[nameIndex].value;
    return { nameIndex, name, afterName: nameEnd };
  }

  /** Collect comma-separated type references (angle-depth aware) until a stop token. */
  collectTypeList(index: number): { names: string[]; next: number } {
    const names: string[] = [];
    let i = index;
    let angle = 0;
    let current = '';
    const flush = (): void => {
      const trimmed = current.trim();
      if (trimmed) names.push(trimmed);
      current = '';
    };
    for (;;) {
      if (i >= this.length) break;
      const token = this.toks[i];
      const value = token.value;
      if (value === '<') {
        angle++;
        i++;
        continue;
      }
      if (value.includes('>') && !/[A-Za-z0-9]/.test(value)) {
        angle = Math.max(0, angle - countChars(value, '>'));
        i++;
        continue;
      }
      if (value === ',' && angle === 0) {
        flush();
        i++;
        continue;
      }
      if (
        angle === 0 &&
        (CLAUSE_KEYWORDS.has(value) ||
          value === '{' ||
          value === ';' ||
          value === '}' ||
          value === ')' ||
          value === ']' ||
          token.kind === 'eof')
      ) {
        break;
      }
      if (angle === 0 && isIdentifierLike(token)) {
        if (current === '') {
          const chain = this.consumeDottedChain(i);
          current = chain.full;
          i = chain.end;
          continue;
        }
        i++;
        continue;
      }
      i++;
    }
    flush();
    return { names, next: i };
  }

  /** Skip past a generic parameter list on a declaration (`<T extends Foo>`). */
  skipDeclarationTypeParams(index: number): number {
    if (this.toks[index]?.value === '<') return this.skipAngled(index);
    return index;
  }

  /** Skip an annotation starting at `@`. */
  skipAnnotation(index: number): number {
    let i = index + 1;
    const target = this.toks[i];
    if (target && (target.kind === 'identifier' || target.kind === 'keyword')) {
      i = this.consumeDottedChain(i).end;
      i = this.skipDeclarationTypeParams(i);
      if (this.toks[i]?.value === '(') i = this.skipParens(i);
      return i;
    }
    return i;
  }

  sliceTokens(from: number, to: number): string {
    const start = this.toks[from]?.start ?? 0;
    const end = this.toks[to - 1]?.end ?? start;
    return this.source.slice(start, end);
  }
}

class RegionAnalyzer {
  private readonly parser: Parser;
  private readonly source: string;
  private readonly toks: Token[];
  private readonly symbols: DartSymbol[] = [];
  private readonly imports: ImportDirective[] = [];
  private readonly exportsArr: ImportDirective[] = [];
  private readonly parts: PartDirective[] = [];
  private readonly errors: DartAnalysisError[] = [];

  constructor(source: string) {
    const lexed = tokenize(source);
    for (const error of lexed.errors) {
      this.errors.push({ code: error.code, message: error.message, offset: error.start, line: error.line, column: error.column });
    }
    this.toks = significantTokens(lexed.tokens);
    this.parser = new Parser(this.toks, source);
    this.source = source;
  }

  analyze(): DartAnalysis {
    this.parseRegion(0, null);
    const lines = this.source.length === 0 ? 1 : this.source.split('\n').length;
    return {
      symbols: this.symbols,
      imports: this.imports,
      exports: this.exportsArr,
      parts: this.parts,
      errors: this.errors,
      stats: {
        lines,
        tokens: this.toks.length,
        symbols: this.symbols.length,
        imports: this.imports.length,
        exports: this.exportsArr.length,
        parts: this.parts.length,
      },
    };
  }

  // ------------------------------------------------------------------
  // Region parsing
  // ------------------------------------------------------------------

  /** Parse a sequence of declarations. Stops at (and consumes) a closing `}` when inside a body. */
  private parseRegion(start: number, enclosing: string | null): number {
    let i = start;
    let steps = 0;
    const maxSteps = this.toks.length + 8;
    while (i < this.toks.length) {
      if (steps++ > maxSteps) break;
      const token = this.toks[i];
      const value = token.value;

      if (value === '}') return i + 1;

      if (value === '{') {
        i = this.parser.skipBalanced(i, '{', '}');
        continue;
      }

      if (value === '@') {
        const next = this.parser.skipAnnotation(i);
        i = next > i ? next : i + 1;
        continue;
      }

      if (value === 'import' || value === 'export') {
        const directive = this.tryParseImportDirective(i, value);
        if (directive) {
          if (!enclosing) {
            if (directive.kind === 'import') this.imports.push(directive);
            else this.exportsArr.push(directive);
          }
          i = directive.end;
          continue;
        }
        i++;
        continue;
      }

      if (value === 'part') {
        const directive = this.tryParsePartDirective(i);
        if (directive) {
          if (!enclosing) this.parts.push(directive);
          i = directive.end;
          continue;
        }
        i++;
        continue;
      }

      if (value === 'library') {
        i = this.skipToSemicolon(i + 1);
        continue;
      }

      const declEnd = this.tryParseDeclaration(i, enclosing);
      if (declEnd > i) {
        i = declEnd;
        continue;
      }
      i++;
    }
    return i;
  }

  // ------------------------------------------------------------------
  // Declarations
  // ------------------------------------------------------------------

  private tryParseDeclaration(i: number, enclosing: string | null): number {
    try {
      const end = this.tryParseDeclarationInner(i, enclosing);
      return end > i ? end : i;
    } catch {
      // Recovery: never let a parser bug wedge the analysis.
      return i + 1;
    }
  }

  private tryParseDeclarationInner(i: number, enclosing: string | null): number {
    const mods = this.parser.collectModifiers(i);
    const j = mods.next;
    if (j >= this.toks.length) return i;

    const token = this.toks[j];
    const value = token.value;

    if (value === 'class' || value === 'enum') {
      return this.parseNominal(j, value === 'class' ? 'class' : 'enum', mods.values, enclosing);
    }
    if (value === 'mixin') {
      if (this.toks[j + 1]?.value === 'class') {
        return this.parseNominal(j, 'class', new Set([...mods.values, 'mixin']), enclosing);
      }
      return this.parseNominal(j, 'mixin', mods.values, enclosing);
    }
    if (value === 'extension') {
      return this.parseExtension(j, mods.values, enclosing);
    }
    if (value === 'typedef') {
      return this.parseTypedef(j, mods.values, enclosing);
    }
    if (value === 'get') return this.parseAccessor(j, mods.values, 'getter', enclosing);
    if (value === 'set') return this.parseAccessor(j, mods.values, 'setter', enclosing);
    if (value === 'operator') return this.parseOperator(j, mods.values, enclosing);

    // Constructor: `Name(` / `Name.named(` with no return type, inside a class body.
    if (enclosing && isIdentifierLike(token)) {
      const chain = this.parser.consumeDottedChain(j);
      const afterAngles = this.toks[chain.end]?.value === '<' ? this.parser.skipAngled(chain.end) : chain.end;
      if (this.toks[afterAngles]?.value === '(' && chain.first === enclosing) {
        const nameToken = this.toks[chain.lastIndex];
        this.symbols.push({
          kind: 'constructor',
          name: chain.name,
          offset: nameToken.start,
          line: nameToken.line,
          column: nameToken.column,
          abstract: false,
          isStatic: false,
          enclosing,
        });
        const afterParams = this.parser.skipParens(afterAngles);
        return this.parser.skipCallableTail(afterParams);
      }
    }

    // Callable / variable declaration with (possibly `var`/`final`) leading type spec.
    const specEnd = this.parser.scanTypeSpec(j);
    if (specEnd <= j) return i;

    // Accessors and operators with a return type: the type run ends at the
    // accessor keyword. Drop the type and parse from there.
    const boundary = this.toks[specEnd]?.value;
    if (boundary === 'get') return this.parseAccessor(specEnd, mods.values, 'getter', enclosing);
    if (boundary === 'set') return this.parseAccessor(specEnd, mods.values, 'setter', enclosing);
    if (boundary === 'operator') return this.parseOperator(specEnd, mods.values, enclosing);

    const split = this.parser.splitTypeAndName(j, specEnd);
    if (!split) return i;

    const afterNameToken = this.toks[split.afterName]?.value;
    if (afterNameToken === 'get') return this.parseAccessor(split.afterName, mods.values, 'getter', enclosing);
    if (afterNameToken === 'set') return this.parseAccessor(split.afterName, mods.values, 'setter', enclosing);
    if (afterNameToken === 'operator') return this.parseOperator(split.afterName, mods.values, enclosing);

    // Generic callable: `<T>` followed by the parameter list.
    if (afterNameToken === '<') {
      const afterAngles = this.parser.skipAngled(split.afterName);
      if (this.toks[afterAngles]?.value === '(') {
        this.recordNamedLike(enclosing ? 'method' : 'function', split, mods.values, enclosing);
        return this.parser.skipCallableTail(this.parser.skipParens(afterAngles));
      }
      return split.afterName;
    }

    if (afterNameToken === '(') {
      this.recordNamedLike(enclosing ? 'method' : 'function', split, mods.values, enclosing);
      return this.parser.skipCallableTail(this.parser.skipParens(split.afterName));
    }

    // Variable declarator(s) — possibly several sharing the type.
    this.symbols.push({
      kind: enclosing ? 'field' : 'variable',
      name: split.name,
      offset: this.toks[split.nameIndex].start,
      line: this.toks[split.nameIndex].line,
      column: this.toks[split.nameIndex].column,
      abstract: false,
      isStatic: mods.values.has('static'),
      ...(enclosing ? { enclosing } : {}),
    });
    const next = split.afterName;
    if (this.toks[next]?.value === '=') {
      const skipped = this.parser.skipInitializer(next + 1);
      if (skipped.delimiter === ',') return this.parseMoreDeclarators(skipped.next + 1, mods.values, enclosing);
      if (skipped.delimiter === null) return this.parseMoreDeclarators(skipped.next, mods.values, enclosing);
      return skipped.next; // ';' consumed elsewhere; '}'/')'/']' left to the region parser
    }
    if (this.toks[next]?.value === ';') return next + 1;
    if (this.toks[next]?.value === ',') return this.parseMoreDeclarators(next + 1, mods.values, enclosing);
    return next + 1;
  }

  private parseMoreDeclarators(start: number, mods: Set<string>, enclosing: string | null): number {
    let j = start;
    let guard = 0;
    for (;;) {
      if (guard++ > 100) return j;
      const token = this.toks[j];
      if (!isIdentifierLike(token)) return j;
      if (CLAUSE_KEYWORDS.has(token.value) || DECL_STOP.has(token.value)) return j;
      this.symbols.push({
        kind: enclosing ? 'field' : 'variable',
        name: token.value,
        offset: token.start,
        line: token.line,
        column: token.column,
        abstract: false,
        isStatic: mods.has('static'),
        ...(enclosing ? { enclosing } : {}),
      });
      const after = this.toks[j + 1]?.value;
      if (after === '=') {
        const skipped = this.parser.skipInitializer(j + 2);
        if (skipped.delimiter === ',') { j = skipped.next + 1; continue; }
        if (skipped.delimiter === null) return this.parseMoreDeclarators(skipped.next, mods, enclosing);
        return skipped.next;
      }
      if (after === ',') { j = j + 2; continue; }
      if (after === ';') return j + 2;
      if (after === '}') return j + 1;
      return j + 1;
    }
  }

  private recordNamedLike(
    kind: SymbolKind,
    split: TypeAndName,
    mods: Set<string>,
    enclosing: string | null,
  ): void {
    this.symbols.push({
      kind,
      name: split.name,
      offset: this.toks[split.nameIndex].start,
      line: this.toks[split.nameIndex].line,
      column: this.toks[split.nameIndex].column,
      abstract: mods.has('abstract'),
      isStatic: mods.has('static'),
      ...(enclosing ? { enclosing } : {}),
    });
  }

  private parseAccessor(i: number, mods: Set<string>, kind: 'getter' | 'setter', enclosing: string | null): number {
    let j = i + 1;
    const nameToken = this.toks[j];
    if (!isIdentifierLike(nameToken)) return i + 1;
    this.symbols.push({
      kind,
      name: nameToken.value,
      offset: nameToken.start,
      line: nameToken.line,
      column: nameToken.column,
      abstract: mods.has('abstract'),
      isStatic: mods.has('static'),
      ...(enclosing ? { enclosing } : {}),
    });
    j++;
    if (kind === 'setter' && this.toks[j]?.value === '(') {
      j = this.parser.skipParens(j);
    }
    return this.parser.skipCallableTail(j);
  }

  private parseOperator(i: number, mods: Set<string>, enclosing: string | null): number {
    let j = i + 1;
    let symbol = '?';
    const first = this.toks[j];
    if (first?.value === '[' && this.toks[j + 1]?.value === ']') {
      symbol = '[]';
      j += 2;
      if (this.toks[j]?.value === '=') {
        symbol = '[]=';
        j++;
      }
    } else if (first) {
      symbol = first.value;
      j++;
    }
    this.symbols.push({
      kind: 'operator',
      name: `operator ${symbol}`,
      offset: first?.start ?? this.toks[i].start,
      line: first?.line ?? this.toks[i].line,
      column: first?.column ?? this.toks[i].column,
      abstract: mods.has('abstract'),
      isStatic: false,
      ...(enclosing ? { enclosing } : {}),
    });
    if (this.toks[j]?.value === '(') j = this.parser.skipParens(j);
    return this.parser.skipCallableTail(j);
  }

  private parseNominal(
    i: number,
    kind: 'class' | 'mixin' | 'enum',
    mods: Set<string>,
    enclosing: string | null,
  ): number {
    let j = i;
    if (this.toks[j]?.value === 'mixin') {
      j++;
      if (this.toks[j]?.value === 'class') j++;
    } else {
      j++; // class | enum
    }

    const nameToken = this.toks[j];
    const hasName = isIdentifierLike(nameToken);
    const name = hasName ? nameToken.value : '<unnamed>';
    j = hasName ? j + 1 : j;
    j = this.parser.skipDeclarationTypeParams(j);

    const clauses = this.parseClauses(j);
    j = clauses.next;

    this.symbols.push({
      kind,
      name,
      offset: hasName && nameToken ? nameToken.start : this.toks[i].start,
      line: hasName && nameToken ? nameToken.line : this.toks[i].line,
      column: hasName && nameToken ? nameToken.column : this.toks[i].column,
      abstract: mods.has('abstract'),
      isStatic: false,
      ...(enclosing ? { enclosing } : {}),
      ...(clauses.extends.length > 0 ? { extends: clauses.extends } : {}),
      ...(clauses.implements.length > 0 ? { implements: clauses.implements } : {}),
      ...(clauses.with.length > 0 ? { with: clauses.with } : {}),
    });

    if (this.toks[j]?.value === '{') {
      if (kind === 'enum') return this.parseEnumBody(j, name);
      return this.parseMembers(j, name);
    }
    return j;
  }

  private parseExtension(i: number, mods: Set<string>, enclosing: string | null): number {
    let j = i + 1; // past `extension`
    if (this.toks[j]?.value === 'type') j++; // Dart 3 `extension type`

    let nameToken: Token | undefined;
    if (isIdentifierLike(this.toks[j]) && this.toks[j]?.value !== 'on') {
      nameToken = this.toks[j];
      j++;
    }
    const name = nameToken?.value ?? '<unnamed>';
    j = this.parser.skipDeclarationTypeParams(j);
    if (this.toks[j]?.value === '(') j = this.parser.skipParens(j); // extension-type primary constructor

    if (this.toks[j]?.value === 'on') {
      j = this.parser.collectTypeList(j + 1).next; // bounds consumed, not reported
    }
    const clauses = this.parseClauses(j);
    j = clauses.next;

    this.symbols.push({
      kind: 'extension',
      name,
      offset: nameToken?.start ?? this.toks[i].start,
      line: nameToken?.line ?? this.toks[i].line,
      column: nameToken?.column ?? this.toks[i].column,
      abstract: mods.has('abstract'),
      isStatic: false,
      ...(enclosing ? { enclosing } : {}),
    });

    if (this.toks[j]?.value === '{') return this.parseMembers(j, name);
    return j;
  }

  private parseClauses(j: number): { extends: string[]; implements: string[]; with: string[]; next: number } {
    const extendsNames: string[] = [];
    const implementsNames: string[] = [];
    const withNames: string[] = [];
    let i = j;
    for (;;) {
      const value = this.toks[i]?.value;
      if (value === 'extends') {
        const list = this.parser.collectTypeList(i + 1);
        extendsNames.push(...list.names);
        i = list.next;
        continue;
      }
      if (value === 'on') {
        const list = this.parser.collectTypeList(i + 1);
        i = list.next;
        continue;
      }
      if (value === 'implements') {
        const list = this.parser.collectTypeList(i + 1);
        implementsNames.push(...list.names);
        i = list.next;
        continue;
      }
      if (value === 'with') {
        const list = this.parser.collectTypeList(i + 1);
        withNames.push(...list.names);
        i = list.next;
        continue;
      }
      break;
    }
    return { extends: extendsNames, implements: implementsNames, with: withNames, next: i };
  }

  private parseMembers(openBrace: number, enclosing: string): number {
    return this.parseRegion(openBrace + 1, enclosing);
  }

  private parseEnumBody(openBrace: number, enclosing: string): number {
    let i = openBrace + 1;
    let paren = 0;
    let brace = 0;
    let steps = 0;
    const maxSteps = this.toks.length + 8;
    for (;;) {
      if (i >= this.toks.length || steps++ > maxSteps) return i;
      const value = this.toks[i].value;
      if (value === '(') paren++;
      else if (value === ')') paren = Math.max(0, paren - 1);
      else if (value === '{') brace++;
      else if (value === '}') {
        if (brace > 0) {
          brace--;
          i++;
          continue;
        }
        if (paren === 0) return i + 1;
        i++;
        continue;
      } else if (value === ';' && paren === 0 && brace === 0) {
        i++;
        return this.parseRegion(i, enclosing);
      }
      i++;
    }
  }

  private parseTypedef(i: number, mods: Set<string>, enclosing: string | null): number {
    const startMods = mods;
    let j = i + 1; // past `typedef`
    let name: string | null = null;
    let nameIndex = -1;

    // Dart 3 form: `typedef Name<T>? = Type;` or `typedef Name = Type;`
    const first = this.toks[j];
    if (isIdentifierLike(first)) {
      const afterName = this.toks[j + 1]?.value === '<' ? this.parser.skipAngled(j + 1) : j + 1;
      if (this.toks[afterName]?.value === '=') {
        name = first.value;
        nameIndex = j;
        j = this.skipToSemicolon(afterName + 1);
      }
    }
    if (!name) {
      // Legacy form: `typedef ReturnType Name<T>(params);` or without type params.
      const specEnd = this.parser.scanTypeSpec(j);
      const split = specEnd > j ? this.parser.splitTypeAndName(j, specEnd) : null;
      if (split) {
        name = split.name;
        nameIndex = split.nameIndex;
        const afterName = this.toks[split.afterName]?.value === '<' ? this.parser.skipAngled(split.afterName) : split.afterName;
        const paramStart = this.findNextParen(afterName);
        j = paramStart >= 0 ? this.skipToSemicolon(this.parser.skipParens(paramStart)) : this.skipToSemicolon(afterName);
      } else {
        j = this.skipToSemicolon(j);
      }
    }
    if (name && nameIndex >= 0) {
      this.symbols.push({
        kind: 'typedef',
        name,
        offset: this.toks[nameIndex].start,
        line: this.toks[nameIndex].line,
        column: this.toks[nameIndex].column,
        abstract: startMods.has('abstract'),
        isStatic: false,
        ...(enclosing ? { enclosing } : {}),
      });
    }
    return j;
  }

  private findNextParen(index: number): number {
    let i = index;
    let guard = 0;
    while (i < this.toks.length && guard++ < 200) {
      const value = this.toks[i].value;
      if (value === '(') return i;
      if (value === ';' || value === '{' || value === '}') return -1;
      i++;
    }
    return -1;
  }

  private skipToSemicolon(index: number): number {
    let i = index;
    let depth = 0;
    while (i < this.toks.length) {
      const value = this.toks[i].value;
      if (value === '(' || value === '[' || value === '{') depth++;
      else if (value === ')' || value === ']' || value === '}') {
        if (depth === 0) return i; // leave the region boundary to the caller
        depth--;
      } else if (value === ';' && depth === 0) return i + 1;
      i++;
    }
    return i;
  }

  // ------------------------------------------------------------------
  // Directives
  // ------------------------------------------------------------------

  private readStringToken(index: number): { uri: string; end: number } | null {
    const token = this.toks[index];
    if (!token || token.kind !== 'string') return null;
    return { uri: stringLiteralText(token), end: index + 1 };
  }

  private tryParseImportDirective(
    i: number,
    kind: 'import' | 'export',
  ): (ImportDirective & { end: number }) | null {
    const keyword = this.toks[i];
    let j = i + 1;
    const defaultUri = this.readStringToken(j);
    if (!defaultUri) {
      // Only report malformed directives that at least look like import/export;
      // bare keywords are skipped by the caller.
      return null;
    }
    const uri = defaultUri.uri;
    const offset = keyword.start;
    const line = keyword.line;
    const column = keyword.column;
    j = defaultUri.end;

    const conditionals: DirectiveConditional[] = [];
    for (;;) {
      if (this.toks[j]?.value !== 'if') break;
      if (this.toks[j + 1]?.value !== '(') break;
      let depth = 1;
      let k = j + 2;
      const condStartToken = k;
      while (k < this.toks.length) {
        const v = this.toks[k].value;
        if (v === '(') depth++;
        else if (v === ')') {
          depth--;
          if (depth === 0) break;
        }
        k++;
      }
      const condition = this.parser.sliceTokens(condStartToken, k).trim();
      if (k >= this.toks.length) {
        j = k;
        break;
      }
      j = k + 1; // past the close paren
      const branch = this.readStringToken(j);
      if (!branch) break;
      conditionals.push({ condition, uri: branch.uri });
      j = branch.end;
    }

    let prefix: string | null = null;
    let deferred = false;
    if (this.toks[j]?.value === 'deferred') {
      deferred = true;
      j++;
    }
    if (this.toks[j]?.value === 'as') {
      const name = this.toks[j + 1];
      if (name && (name.kind === 'identifier' || name.kind === 'keyword')) {
        prefix = name.value;
        j += 2;
      } else {
        j += 1;
      }
    }

    let show: string[] | null = null;
    let hide: string[] | null = null;
    for (;;) {
      const value = this.toks[j]?.value;
      if (value !== 'show' && value !== 'hide') break;
      const names: string[] = [];
      j++;
      for (;;) {
        const name = this.toks[j];
        if (name && (name.kind === 'identifier' || name.kind === 'keyword')) {
          if (!names.includes(name.value)) names.push(name.value);
          j++;
          if (this.toks[j]?.value === ',') {
            j++;
            continue;
          }
          break;
        }
        break;
      }
      if (value === 'show') show = show ? [...show, ...names] : names;
      else hide = hide ? [...hide, ...names] : names;
    }

    if (this.toks[j]?.value === ';') j++;

    return { kind, uri, offset, line, column, prefix, deferred, show, hide, conditionals, end: j };
  }

  private tryParsePartDirective(i: number): (PartDirective & { end: number }) | null {
    const keyword = this.toks[i];
    let j = i + 1;
    const offset = keyword.start;
    const line = keyword.line;
    const column = keyword.column;

    if (this.toks[j]?.value === 'of') {
      j++;
      const target = this.toks[j];
      if (target?.kind === 'string') {
        const uri = stringLiteralText(target);
        j++;
        if (this.toks[j]?.value === ';') j++;
        return { kind: 'partOf', uri, name: null, offset, line, column, end: j };
      }
      // `part of my_library;` — dotted library name; captured verbatim.
      const parts: string[] = [];
      while (j < this.toks.length) {
        const t = this.toks[j];
        if (t.kind === 'identifier' || t.kind === 'keyword') {
          parts.push(t.value);
          j++;
          continue;
        }
        if (t.value === '.') {
          parts.push('.');
          j++;
          continue;
        }
        break;
      }
      if (this.toks[j]?.value === ';') j++;
      const name = parts.length > 0 ? parts.join('') : null;
      return { kind: 'partOf', uri: null, name, offset, line, column, end: j };
    }

    const target = this.toks[j];
    if (target?.kind === 'string') {
      const uri = stringLiteralText(target);
      j++;
      if (this.toks[j]?.value === ';') j++;
      return { kind: 'part', uri, name: null, offset, line, column, end: j };
    }
    return null;
  }
}

/**
 * Analyze Dart source text into a declaration index. Never throws; malformed
 * input yields a best-effort result with diagnostics in `errors`.
 */
export function analyzeDart(source: string): DartAnalysis {
  try {
    const input = typeof source === 'string' ? source : String(source ?? '');
    return new RegionAnalyzer(input).analyze();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      symbols: [],
      imports: [],
      exports: [],
      parts: [],
      errors: [{ code: 'ANALYSIS', message: `Analysis failed: ${message}`, offset: 0, line: 1, column: 1 }],
      stats: { lines: 1, tokens: 0, symbols: 0, imports: 0, exports: 0, parts: 0 },
    };
  }
}
