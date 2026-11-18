/**
 * A dependency-free Dart tokenizer.
 *
 * The lexer is deliberately error tolerant: malformed input always yields a
 * token stream plus diagnostics rather than an exception. Token `value` is the
 * exact source slice for the token (raw lexeme); consumers that need a decoded
 * string can use `stringLiteralText()`.
 */

export type TokenKind =
  | 'identifier'
  | 'keyword'
  | 'number'
  | 'string'
  | 'comment'
  | 'punct'
  | 'eof';

export type LexErrorCode =
  | 'UNTERMINATED_STRING'
  | 'UNTERMINATED_COMMENT'
  | 'INVALID_NUMBER'
  | 'INVALID_CHARACTER'
  | 'INTERPOLATION';

export interface LexError {
  code: LexErrorCode;
  message: string;
  /** Offset of the offending construct. */
  start: number;
  /** Exclusive end offset of the offending construct. */
  end: number;
  line: number;
  column: number;
}

export interface StringInterpolation {
  /** Offset of the expression content (after `${` or after `$`). */
  start: number;
  /** Exclusive end of the expression content (before the closing `}`). */
  end: number;
  line: number;
  column: number;
  /** True for `${expr}`, false for `$identifier`. */
  expression: boolean;
  tokens: Token[];
  errors: LexError[];
}

export interface Token {
  kind: TokenKind;
  /** Raw source slice for the token. */
  value: string;
  start: number;
  end: number;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** Documentation comments (triple-slash or star-slash star forms). */
  doc?: boolean;
  /** Quote delimiter for string tokens. */
  quote?: "'" | '"' | "'''" | '"""';
  /** True when the string token was prefixed with `r`. */
  rawString?: boolean;
  /** Interpolation regions inside a non-raw string. */
  interpolations?: StringInterpolation[];
}

export interface TokenizationResult {
  tokens: Token[];
  errors: LexError[];
}

/** Reserved words plus built-in/contextual identifiers (Dart 3). */
const KEYWORDS = new Set<string>([
  // Reserved words.
  'assert', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'default', 'do', 'else', 'enum', 'extends', 'false', 'final', 'finally',
  'for', 'if', 'in', 'is', 'new', 'null', 'rethrow', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'var', 'void', 'while', 'with',
  // Built-in identifiers.
  'abstract', 'as', 'covariant', 'deferred', 'dynamic', 'export', 'extension',
  'external', 'factory', 'Function', 'get', 'implements', 'import',
  'interface', 'late', 'library', 'mixin', 'operator', 'part', 'required',
  'set', 'static', 'typedef',
  // Contextual / modifier keywords.
  'async', 'await', 'base', 'hide', 'of', 'on', 'sealed', 'show', 'sync',
  'yield', 'augment',
]);

export function isKeyword(word: string): boolean {
  return KEYWORDS.has(word);
}

const OPERATORS = [
  '>>>=',
  '...?',
  '<<=',
  '>>=',
  '~/=',
  '??=',
  '?..',
  '>>>',
  '...',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '~/',
  '<<',
  '>>',
  '=>',
  '?.',
  '??',
  '..',
];

const SINGLE_PUNCT = new Set<string>([
  '(', ')', '[', ']', '{', '}', '<', '>', ';', ',', '.', ':', '?', '!',
  '+', '-', '*', '/', '%', '&', '|', '^', '~', '=', '@', '#', '\\', '$',
]);

function isWhitespaceCode(code: number): boolean {
  if (code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32) return true;
  if (code === 0xa0 || code === 0x1680 || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff) return true;
  return code >= 0x2000 && code <= 0x200a;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

function isBinaryDigit(code: number): boolean {
  return code === 48 || code === 49;
}

function isIdentifierStart(code: number): boolean {
  if (code >= 65 && code <= 90) return true;
  if (code >= 97 && code <= 122) return true;
  if (code === 95 || code === 36) return true;
  return code > 0x7f;
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || isDigit(code);
}

function isQuote(code: number): boolean {
  return code === 39 || code === 34;
}

class LineMap {
  private readonly starts: number[];
  private readonly length: number;

  constructor(source: string) {
    this.length = source.length;
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
      const code = source.charCodeAt(i);
      if (code === 13) {
        if (i + 1 < source.length && source.charCodeAt(i + 1) === 10) i++;
        starts.push(i + 1);
      } else if (code === 10) {
        starts.push(i + 1);
      }
    }
    this.starts = starts;
  }

  positionAt(offset: number): { line: number; column: number } {
    const clamped = offset < 0 ? 0 : offset > this.length ? this.length : offset;
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.starts[mid] <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: clamped - this.starts[low] + 1 };
  }

  get sourceLength(): number {
    return this.length;
  }
}

interface LexRun {
  tokens: Token[];
  errors: LexError[];
  /** Offset where lexing stopped (the closing `}` for interpolation lexers). */
  end: number;
  /** Whether the region ended because an unmatched `}` was found. */
  stoppedAtBrace: boolean;
}

class Lexer {
  private readonly source: string;
  private readonly lines: LineMap;
  private readonly start: number;
  private readonly limit: number;
  private readonly stopAtCloseBrace: boolean;

  constructor(
    source: string,
    lines: LineMap,
    start: number,
    limit: number,
    stopAtCloseBrace: boolean,
  ) {
    this.source = source;
    this.lines = lines;
    this.start = start;
    this.limit = limit;
    this.stopAtCloseBrace = stopAtCloseBrace;
  }

  run(): LexRun {
    const tokens: Token[] = [];
    const errors: LexError[] = [];
    let i = this.start;
    let braceDepth = 0;

    while (i < this.limit) {
      const code = this.source.charCodeAt(i);

      if (isWhitespaceCode(code)) {
        i++;
        continue;
      }

      // Comments -----------------------------------------------------------
      if (code === 47 /* / */ && this.source.charCodeAt(i + 1) === 47) {
        const isDoc = this.source.charCodeAt(i + 2) === 47;
        const start = i;
        i += 2;
        while (i < this.limit) {
          const c = this.source.charCodeAt(i);
          if (c === 10 || c === 13) break;
          i++;
        }
        tokens.push(this.make('comment', start, i, isDoc ? { doc: true } : undefined));
        continue;
      }

      if (code === 47 /* / */ && this.source.charCodeAt(i + 1) === 42 /* * */) {
        const start = i;
        const isDoc = this.source.charCodeAt(i + 2) === 42 && this.source.charCodeAt(i + 3) !== 47;
        i += 2;
        let depth = 1;
        while (i < this.limit) {
          if (this.source.charCodeAt(i) === 47 && this.source.charCodeAt(i + 1) === 42) {
            depth++;
            i += 2;
            continue;
          }
          if (this.source.charCodeAt(i) === 42 && this.source.charCodeAt(i + 1) === 47) {
            depth--;
            i += 2;
            if (depth === 0) break;
            continue;
          }
          i++;
        }
        if (depth !== 0) {
          errors.push(this.error('UNTERMINATED_COMMENT', 'Unterminated block comment.', start, this.limit));
          i = this.limit;
        }
        tokens.push(this.make('comment', start, i, isDoc ? { doc: true } : undefined));
        continue;
      }

      // Raw strings: r'...', r"...", r'''...''', r"""..."""
      if (
        (code === 114 /* r */) &&
        isQuote(this.source.charCodeAt(i + 1))
      ) {
        const scanned = this.scanString(i, i + 1, true, errors);
        tokens.push(this.make('string', i, scanned.end, {
          quote: scanned.quote,
          rawString: true,
          ...(scanned.interpolations.length > 0 ? { interpolations: scanned.interpolations } : {}),
        }));
        i = scanned.end;
        continue;
      }

      // Strings ------------------------------------------------------------
      if (isQuote(code)) {
        const scanned = this.scanString(i, i, false, errors);
        tokens.push(this.make('string', i, scanned.end, {
          quote: scanned.quote,
          ...(scanned.interpolations.length > 0 ? { interpolations: scanned.interpolations } : {}),
        }));
        i = scanned.end;
        continue;
      }

      // Identifiers / keywords --------------------------------------------
      if (isIdentifierStart(code)) {
        const start = i;
        i++;
        while (i < this.limit && isIdentifierPart(this.source.charCodeAt(i))) i++;
        const value = this.source.slice(start, i);
        tokens.push(this.make(KEYWORDS.has(value) ? 'keyword' : 'identifier', start, i));
        continue;
      }

      // Numbers ------------------------------------------------------------
      if (isDigit(code) || (code === 46 /* . */ && isDigit(this.source.charCodeAt(i + 1)))) {
        const scanned = this.scanNumber(i, errors);
        tokens.push(this.make('number', i, scanned.end));
        i = scanned.end;
        continue;
      }

      // Interpolation close for sub-lexers --------------------------------
      if (this.stopAtCloseBrace && code === 125 /* } */) {
        if (braceDepth === 0) {
          return { tokens, errors, end: i, stoppedAtBrace: true };
        }
        braceDepth--;
        const start = i;
        i++;
        tokens.push(this.make('punct', start, i));
        continue;
      }

      if (this.stopAtCloseBrace && code === 123 /* { */) braceDepth++;

      // Operators / punctuation -------------------------------------------
      let matched = '';
      for (const op of OPERATORS) {
        if (this.source.startsWith(op, i) && i + op.length <= this.limit) {
          matched = op;
          break;
        }
      }
      if (!matched) {
        const ch = this.source[i];
        if (SINGLE_PUNCT.has(ch)) matched = ch;
      }
      if (matched) {
        const start = i;
        i += matched.length;
        tokens.push(this.make('punct', start, i));
        continue;
      }

      // Unknown character: emit a one-character punctuation token and recover.
      errors.push(this.error('INVALID_CHARACTER', `Unexpected character ${JSON.stringify(this.source[i])}.`, i, i + 1));
      const start = i;
      i++;
      tokens.push(this.make('punct', start, i));
    }

    return { tokens, errors, end: i, stoppedAtBrace: false };
  }

  private make(
    kind: TokenKind,
    start: number,
    end: number,
    extra?: Omit<Token, 'kind' | 'value' | 'start' | 'end' | 'line' | 'column'>,
  ): Token {
    const pos = this.lines.positionAt(start);
    return {
      kind,
      value: this.source.slice(start, end),
      start,
      end,
      line: pos.line,
      column: pos.column,
      ...(extra ?? {}),
    };
  }

  private error(code: LexErrorCode, message: string, start: number, end: number): LexError {
    const pos = this.lines.positionAt(start);
    return { code, message, start, end, line: pos.line, column: pos.column };
  }

  private scanNumber(start: number, errors: LexError[]): { end: number } {
    let i = start;
    const code0 = this.source.charCodeAt(i);

    if (code0 === 48 /* 0 */ && i + 1 < this.limit) {
      const next = this.source.charCodeAt(i + 1);
      if (next === 120 || next === 88) {
        i += 2;
        const digitsStart = i;
        while (i < this.limit && (isHexDigit(this.source.charCodeAt(i)) || this.source.charCodeAt(i) === 95)) i++;
        if (i === digitsStart) {
          errors.push(this.error('INVALID_NUMBER', 'Hexadecimal literal has no digits.', start, i));
        }
        return { end: i };
      }
      if (next === 98 || next === 66) {
        i += 2;
        const digitsStart = i;
        while (i < this.limit && (isBinaryDigit(this.source.charCodeAt(i)) || this.source.charCodeAt(i) === 95)) i++;
        if (i === digitsStart) {
          errors.push(this.error('INVALID_NUMBER', 'Binary literal has no digits.', start, i));
        }
        return { end: i };
      }
    }

    let sawDot = false;
    if (code0 === 46) {
      sawDot = true;
      i++;
    }
    while (i < this.limit) {
      const c = this.source.charCodeAt(i);
      if (isDigit(c) || c === 95) {
        i++;
        continue;
      }
      if (!sawDot && c === 46 && isDigit(this.source.charCodeAt(i + 1))) {
        sawDot = true;
        i++;
        continue;
      }
      break;
    }

    const exp = this.source.charCodeAt(i);
    if (exp === 101 || exp === 69) {
      const expStart = i;
      i++;
      const sign = this.source.charCodeAt(i);
      if (sign === 43 || sign === 45) i++;
      const digitsStart = i;
      while (i < this.limit && isDigit(this.source.charCodeAt(i))) i++;
      if (i === digitsStart) {
        errors.push(this.error('INVALID_NUMBER', 'Exponent has no digits.', expStart, i));
      }
    }

    return { end: i };
  }

  private scanString(
    tokenStart: number,
    quoteStart: number,
    raw: boolean,
    errors: LexError[],
  ): { end: number; quote: "'" | '"' | "'''" | '"""'; interpolations: StringInterpolation[] } {
    const source = this.source;
    const quoteChar = source[quoteStart];
    const triple = source.startsWith(quoteChar.repeat(3), quoteStart);
    const quoteLen = triple ? 3 : 1;
    const quote = (triple ? quoteChar.repeat(3) : quoteChar) as "'" | '"' | "'''" | '"""';
    const interpolations: StringInterpolation[] = [];
    let i = quoteStart + quoteLen;
    let closed = false;
    let hitNewline = false;

    while (i < this.limit) {
      const code = source.charCodeAt(i);

      if (triple) {
        if (source.startsWith(quote, i)) {
          i += 3;
          closed = true;
          break;
        }
      } else {
        if (code === quoteChar.charCodeAt(0)) {
          i++;
          closed = true;
          break;
        }
        if (code === 10 || code === 13) {
          hitNewline = true;
          break;
        }
      }

      if (!raw && code === 92 /* \ */) {
        i += Math.min(2, this.limit - i);
        continue;
      }

      if (!raw && code === 36 /* $ */) {
        const next = source.charCodeAt(i + 1);
        if (next === 123 /* { */) {
          const innerStart = i + 2;
          if (innerStart > this.limit) {
            errors.push(this.error('INTERPOLATION', 'Unterminated string interpolation.', i, this.limit));
            i = this.limit;
            break;
          }
          const sub = new Lexer(source, this.lines, innerStart, this.limit, true).run();
          const tokens = sub.tokens.filter((token) => token.kind !== 'eof');
          for (const err of sub.errors) errors.push(err);
          const pos = this.lines.positionAt(innerStart);
          interpolations.push({
            start: innerStart,
            end: sub.end,
            line: pos.line,
            column: pos.column,
            expression: true,
            tokens,
            errors: sub.errors,
          });
          if (!sub.stoppedAtBrace) {
            errors.push(this.error('INTERPOLATION', 'Unterminated string interpolation; expected `}`.', i, this.limit));
            i = this.limit;
            break;
          }
          i = sub.end + 1;
          continue;
        }
        if (isIdentifierStart(next)) {
          const identStart = i + 1;
          let j = identStart + 1;
          while (j < this.limit && isIdentifierPart(source.charCodeAt(j))) j++;
          const pos = this.lines.positionAt(identStart);
          interpolations.push({
            start: identStart,
            end: j,
            line: pos.line,
            column: pos.column,
            expression: false,
            tokens: [{
              kind: 'identifier',
              value: source.slice(identStart, j),
              start: identStart,
              end: j,
              line: pos.line,
              column: pos.column,
            }],
            errors: [],
          });
          i = j;
          continue;
        }
      }

      i++;
    }

    if (!closed) {
      const message = hitNewline
        ? 'Unterminated string literal (newline in single-line string).'
        : 'Unterminated string literal.';
      errors.push(this.error('UNTERMINATED_STRING', message, tokenStart, i));
    }

    return { end: i, quote, interpolations };
  }
}

/**
 * Tokenize Dart source. Never throws; malformed input produces a best-effort
 * token stream plus `LexError` entries.
 */
export function tokenize(source: string): TokenizationResult {
  const input = typeof source === 'string' ? source : String(source ?? '');
  try {
    const lines = new LineMap(input);
    const result = new Lexer(input, lines, 0, input.length, false).run();
    const pos = lines.positionAt(input.length);
    const tokens = result.tokens;
    tokens.push({
      kind: 'eof',
      value: '',
      start: input.length,
      end: input.length,
      line: pos.line,
      column: pos.column,
    });
    return { tokens, errors: result.errors };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      tokens: [{
        kind: 'eof',
        value: '',
        start: 0,
        end: 0,
        line: 1,
        column: 1,
      }],
      errors: [{
        code: 'INVALID_CHARACTER',
        message: `Tokenizer failed: ${message}`,
        start: 0,
        end: 0,
        line: 1,
        column: 1,
      }],
    };
  }
}

/** Tokens without comments. EOF is retained; callers may filter it. */
export function significantTokens(tokens: Token[]): Token[] {
  return tokens.filter((token) => token.kind !== 'comment');
}

/**
 * Decode the textual content of a string token (quotes and `r` prefix removed,
 * common escapes decoded). Interpolation markers are left verbatim.
 */
export function stringLiteralText(token: Token): string {
  if (token.kind !== 'string') return token.value;
  let body = token.value;
  if (token.rawString && body.startsWith('r')) body = body.slice(1);
  if (body.length >= 6 && (body.startsWith("'''") || body.startsWith('"""'))) {
    body = body.slice(3, Math.max(3, body.length - 3));
    return token.rawString ? body : decodeEscapes(body);
  }
  if (body.length >= 2) {
    body = body.slice(1, Math.max(1, body.length - 1));
    return token.rawString ? body : decodeEscapes(body);
  }
  return body;
}

function decodeEscapes(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '\\' || i + 1 >= value.length) {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    switch (next) {
      case 'n': out += '\n'; i++; break;
      case 'r': out += '\r'; i++; break;
      case 't': out += '\t'; i++; break;
      case 'b': out += '\b'; i++; break;
      case 'f': out += '\f'; i++; break;
      case 'v': out += '\v'; i++; break;
      case '\\': out += '\\'; i++; break;
      case "'": out += "'"; i++; break;
      case '"': out += '"'; i++; break;
      case '$': out += '$'; i++; break;
      case 'u': {
        if (value[i + 2] === '{') {
          const close = value.indexOf('}', i + 3);
          if (close > i + 3) {
            const hex = value.slice(i + 3, close);
            const code = Number.parseInt(hex, 16);
            if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
              out += String.fromCodePoint(code);
              i = close;
              break;
            }
          }
        }
        const hex = value.slice(i + 2, i + 6);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 5;
          break;
        }
        out += next;
        i++;
        break;
      }
      case 'x': {
        const hex = value.slice(i + 2, i + 4);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 3;
          break;
        }
        out += next;
        i++;
        break;
      }
      default:
        out += next;
        i++;
        break;
    }
  }
  return out;
}
