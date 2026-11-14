/**
 * A reader for SavedVariables files.
 *
 * SavedVariables are Lua source, not JSON: `GlobalName = { [1] = "x", money = 152079 }`. This
 * parses the data subset — tables, numbers, strings, booleans, nil, comments, long strings — and
 * never evaluates anything. Regex extraction is deliberately not used here: the same file can hold
 * keys with dots, escaped quotes, integer and string keys mixed, and `nil` holes, and a regex
 * cannot tell those apart from structure.
 *
 * The reader is the base of every SavedVariables adapter: an adapter is a projection over these
 * globals, so a shape change shows up as a parse warning rather than as silently wrong numbers.
 */

export type LuaKey = number | string;
export type LuaScalar = number | string | boolean;
export interface LuaTable {
  readonly t: 'table';
  readonly entries: [LuaKey, LuaValue][];
}
export type LuaValue = LuaScalar | LuaTable;

export interface ParsedGlobal {
  name: string;
  value: LuaValue;
  /** 1-based line where the assignment started, for pointing at a bad file */
  line: number;
}

export interface SavedVariablesFile {
  globals: ParsedGlobal[];
  warnings: string[];
  /** assignments seen, including `X = nil`: a file can be valid and hold no data */
  assignments: number;
  /** bytes of source consumed, for reporting */
  bytes: number;
}

export function isTable(v: LuaValue | undefined): v is LuaTable {
  return typeof v === 'object' && v !== null && (v as LuaTable).t === 'table';
}

const MAX_DEPTH = 200;

class Reader {
  private i = 0;
  private line = 1;
  readonly warnings: string[] = [];

  constructor(private readonly src: string) {}

  assignments = 0;

  read(): ParsedGlobal[] {
    const globals: ParsedGlobal[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.i >= this.src.length) break;
      const startLine = this.line;
      const name = this.tryName();
      if (name === null) {
        this.recover(startLine, `expected a global name`);
        continue;
      }
      this.skipTrivia();
      if (this.peek() !== '=') {
        this.recover(startLine, `expected "=" after ${name}`);
        continue;
      }
      this.i++;
      this.assignments++;
      this.skipTrivia();
      try {
        const value = this.parseValue(0);
        if (value !== undefined) globals.push({ name, value, line: startLine });
      } catch (err) {
        this.recover(startLine, `${name}: ${(err as Error).message}`);
      }
      this.skipTrivia();
      if (this.peek() === ';') this.i++;
    }
    return globals;
  }

  /**
   * After a bad assignment, skip to the next line that starts at column 0 with `Name =`. Addons
   * write one global per line, so this recovers everything after the broken one instead of
   * reporting the whole file as unreadable.
   */
  private recover(fromLine: number, why: string): void {
    this.warnings.push(`line ${fromLine}: ${why} — skipped to the next assignment`);
    const rest = this.src.slice(this.i);
    const re = /\r?\n[A-Za-z_][A-Za-z0-9_]*\s*=/g;
    const m = re.exec(rest);
    if (!m) {
      this.i = this.src.length;
      return;
    }
    this.i += m.index + m[0].indexOf(m[0].trimStart());
    this.yank();
  }

  // ---- trivia ------------------------------------------------------------------------------

  /** Recompute the line counter after a jump, so later warnings point at the right line. */
  private yank(): void {
    this.line = 1;
    for (let k = 0; k < this.i && k < this.src.length; k++) if (this.src[k] === '\n') this.line++;
  }

  private peek(offset = 0): string | undefined {
    return this.src[this.i + offset];
  }

  private skipTrivia(): void {
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) return;
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v' || c === '\uFEFF') {
        if (c === '\n') this.line++;
        this.i++;
        continue;
      }
      if (c === '-' && this.src[this.i + 1] === '-') {
        this.i += 2;
        const long = this.tryLongBracket();
        if (long !== null) continue; // long comment already consumed
        while (this.i < this.src.length && this.src[this.i] !== '\n') this.i++;
        continue;
      }
      return;
    }
  }

  /** `[[ ... ]]` or `[==[ ... ]==]` at the cursor; returns its body and consumes it, else null. */
  private tryLongBracket(): string | null {
    if (this.peek() !== '[') return null;
    let eq = 0;
    while (this.src[this.i + 1 + eq] === '=') eq++;
    if (this.src[this.i + 1 + eq] !== '[') return null;
    const open = this.i;
    this.i += 2 + eq;
    const close = `]${'='.repeat(eq)}]`;
    const end = this.src.indexOf(close, this.i);
    const body = end === -1 ? this.src.slice(this.i) : this.src.slice(this.i, end);
    this.i = end === -1 ? this.src.length : end + close.length;
    this.yank();
    if (end === -1) this.warnings.push(`line ${this.line}: unterminated long string starting at ${open}`);
    // A long string's first newline is not part of the value.
    return body.startsWith('\n') ? body.slice(1) : body;
  }

  // ---- values ------------------------------------------------------------------------------

  /** Returns undefined for an explicit `nil`, or a value that could not be read (after warning). */
  private parseValue(depth: number): LuaValue | undefined {
    if (depth > MAX_DEPTH) throw new Error(`table nested deeper than ${MAX_DEPTH} levels`);
    this.skipTrivia();
    const c = this.peek();
    if (c === undefined) throw new Error('unexpected end of file');
    if (c === '{') return this.parseTable(depth);
    if (c === '"' || c === "'") return this.parseQuoted();
    if (c === '[') {
      const long = this.tryLongBracket();
      if (long !== null) return long;
      throw new Error('unexpected "["');
    }
    const num = this.tryNumber();
    if (num !== null) return num;
    const word = this.tryName();
    if (word === null) throw new Error(`unexpected character ${JSON.stringify(c)}`);
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'nil') return undefined;
    // Anything else is a function call, a variable reference, or an operator expression. That is
    // not data: warn once and treat the field as absent rather than inventing a value.
    this.skipTrivia();
    if (this.peek() === '(' || this.peek() === '.' || this.peek() === '[' || this.peek() === '+' || this.peek() === '..') {
      this.skipExpression();
      this.warnings.push(`line ${this.line}: ${word} is an expression, not a literal — recorded as nil`);
      return undefined;
    }
    this.warnings.push(`line ${this.line}: bare word ${JSON.stringify(word)} — recorded as nil`);
    return undefined;
  }

  private parseTable(depth: number): LuaTable {
    this.i++; // '{'
    const entries: [LuaKey, LuaValue][] = [];
    let nextIndex = 1;
    for (;;) {
      this.skipTrivia();
      const c = this.peek();
      if (c === undefined) throw new Error('unterminated table');
      if (c === '}') {
        this.i++;
        return { t: 'table', entries };
      }
      if (c === ',' || c === ';') {
        this.i++;
        continue;
      }
      if (c === '[') {
        this.i++;
        this.skipTrivia();
        const keyVal = this.parseValue(depth + 1);
        this.skipTrivia();
        if (this.peek() !== ']') throw new Error('unterminated table key');
        this.i++;
        this.skipTrivia();
        if (this.peek() !== '=') throw new Error('expected "=" after table key');
        this.i++;
        const val = this.parseValue(depth + 1);
        if (keyVal !== undefined && val !== undefined) entries.push([toKey(keyVal), val]);
        continue;
      }
      const word = this.peekIsName() ? this.tryName() : null;
      if (word !== null) {
        this.skipTrivia();
        if (this.peek() === '=') {
          this.i++;
          const val = this.parseValue(depth + 1);
          if (val !== undefined) entries.push([word, val]);
          continue;
        }
        // Not an assignment after all: a bare keyword used as an array item (`{ true, false }`).
        // `nil` there is a hole: it keeps the positional index but carries no value.
        if (word === 'nil') {
          nextIndex++;
          continue;
        }
        const v = word === 'true' ? true : word === 'false' ? false : undefined;
        if (v !== undefined) {
          entries.push([nextIndex++, v]);
          continue;
        }
        throw new Error(`unexpected word ${JSON.stringify(word)} in table`);
      }
      const val = this.parseValue(depth + 1);
      if (val !== undefined) entries.push([nextIndex++, val]);
    }
  }

  /** Skip an expression we cannot represent, stopping at the end of the line or the table field. */
  private skipExpression(): void {
    let depth = 0;
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === '(' || c === '{') depth++;
      else if (c === ')' || c === '}') {
        if (depth === 0) return;
        depth--;
      } else if ((c === ',' || c === ';') && depth === 0) return;
      else if (c === '\n' && depth === 0) return;
      this.i++;
    }
  }

  private parseQuoted(): string {
    const quote = this.src[this.i]!;
    this.i++;
    let out = '';
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) throw new Error('unterminated string');
      if (c === quote) {
        this.i++;
        return out;
      }
      if (c === '\\') {
        const esc = this.src[this.i + 1];
        this.i += 2;
        switch (esc) {
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'a': out += '\x07'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'v': out += '\v'; break;
          case '\\': out += '\\'; break;
          case '"': out += '"'; break;
          case "'": out += "'"; break;
          case '\n': this.line++; out += '\n'; break;
          case 'z':
            while (this.src[this.i] === ' ' || this.src[this.i] === '\t' || this.src[this.i] === '\r' || this.src[this.i] === '\n') {
              if (this.src[this.i] === '\n') this.line++;
              this.i++;
            }
            break;
          case 'x': {
            const hex = this.src.slice(this.i, this.i + 2);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
              out += String.fromCharCode(parseInt(hex, 16));
              this.i += 2;
            } else out += 'x';
            break;
          }
          default:
            if (esc !== undefined && /[0-9]/.test(esc)) {
              let digits = esc;
              while (digits.length < 3 && this.src[this.i] !== undefined && /[0-9]/.test(this.src[this.i]!)) {
                digits += this.src[this.i];
                this.i++;
              }
              out += String.fromCharCode(parseInt(digits, 10));
            } else if (esc !== undefined) out += esc;
        }
        continue;
      }
      if (c === '\n') {
        this.line++;
        throw new Error('unterminated string (newline inside quotes)');
      }
      out += c;
      this.i++;
    }
  }

  private tryNumber(): number | null {
    const rest = this.src.slice(this.i, this.i + 40);
    const m = /^-?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(rest);
    if (!m) return null;
    // `-` in front of a word is a unary minus on a variable, not a number.
    const text = m[0]!;
    if (text === '-' || text === '+') return null;
    this.i += text.length;
    const n = text.startsWith('0x') || text.startsWith('-0x') ? Number.parseInt(text.replace('-', ''), 16) * (text[0] === '-' ? -1 : 1) : Number(text);
    return Number.isFinite(n) ? n : 0;
  }

  private peekIsName(): boolean {
    const c = this.peek();
    return !!c && /[A-Za-z_]/.test(c);
  }

  private tryName(): string | null {
    if (!this.peekIsName()) return null;
    let out = '';
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (!/[A-Za-z0-9_]/.test(c)) break;
      out += c;
      this.i++;
    }
    return out;
  }
}

function toKey(v: LuaValue): LuaKey {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return 'table';
}

/**
 * Parse a SavedVariables file body. Never throws: a broken file comes back with warnings and
 * whatever globals were recoverable, because a half-read file is more useful than an error page.
 */
export function parseSavedVariables(text: string): SavedVariablesFile {
  const reader = new Reader(text.replace(/^\uFEFF/, ''));
  let globals: ParsedGlobal[] = [];
  try {
    globals = reader.read();
  } catch (err) {
    reader.warnings.push(`stopped early: ${(err as Error).message}`);
  }
  return { globals, warnings: reader.warnings, assignments: reader.assignments, bytes: text.length };
}
