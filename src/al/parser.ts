import * as vscode from 'vscode';
import type { EventKind, ObjectKind, ObjectRef, Parameter, Publisher, Subscriber } from './types';

const OBJECT_KINDS: ReadonlyArray<ObjectKind> = [
  'codeunit', 'table', 'tableextension', 'page', 'pageextension',
  'report', 'reportextension', 'query', 'xmlport', 'enum',
  'enumextension', 'permissionset', 'interface'
];

const OBJECT_KIND_PATTERN = OBJECT_KINDS.join('|');

const objectHeaderRe = new RegExp(
  `^\\s*(${OBJECT_KIND_PATTERN})\\b\\s+(?:(\\d+)\\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))`,
  'i'
);

const publisherAttrRe = /\[\s*(IntegrationEvent|BusinessEvent)\s*(?:\([^)]*\))?\s*\]/gi;

const subscriberAttrRe =
  /\[\s*EventSubscriber\s*\(\s*ObjectType::([A-Za-z]+)\s*,\s*[A-Za-z]+::(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*,\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))[\s\S]*?\)\s*\]/gi;

const procedureRe =
  /^[ \t]*(?:local|internal|protected)?[ \t]*procedure[ \t]+("([^"]+)"|[A-Za-z_][A-Za-z0-9_]*)/m;

// Maximum distance (chars) we scan past an event attribute for the
// `procedure` keyword. Valid AL places `procedure` immediately after the
// attribute decorator(s); 2048 covers a generous stack of attributes (e.g.
// [Scope], [Obsolete], [IntegrationEvent]) plus leading whitespace before
// the keyword. Bounding the scan keeps a procedure-less tail O(window)
// instead of O(remaining file), which is what causes the extension-host
// freeze on pathological/adversarial .al (issue #125).
const PROCEDURE_SEARCH_WINDOW = 2048;

/**
 * Parse a single AL source file's text into the publishers and subscribers
 * it declares.
 *
 * Supports both pre-BC22 (`'Codeunit Name'`, `'OnEvent'` — string literals)
 * and BC22+ (`Codeunit::"Name"`, `OnEvent` — bare identifier) subscriber
 * syntaxes. Recognizes `[IntegrationEvent]` and `[BusinessEvent]` attribute
 * forms with any of their parameter shapes.
 *
 * When `appId` is supplied (the workspace `app.json` GUID the file belongs
 * to), it is stamped onto every object's `owner` ref so publishers and
 * subscribers are attributed to their project. Subscriber `target` refs are
 * never stamped — the target lives in some other, possibly unknown app.
 * Callers that omit `appId` (e.g. the `.app` bundled-source pass) keep the
 * previous `owner.appId === undefined` behavior.
 */
export function parseAl(
  uri: vscode.Uri,
  text: string,
  appId?: string
): { publishers: Publisher[]; subscribers: Subscriber[] } {
  const ctx = makeObjectContext(text, appId);
  return ctx ? parseAlFrom(uri, ctx) : { publishers: [], subscribers: [] };
}

/**
 * `parseAl` against an already-built object context.
 *
 * Exported so a caller that runs several sweeps over the same document —
 * `AlEventLensCodeLensProvider`, which needs both events and handlers — can
 * build the context once and pay for `stripComments` / `findObjects` once,
 * rather than once per parser entry point.
 */
export function parseAlFrom(
  uri: vscode.Uri,
  ctx: AlObjectContext
): { publishers: Publisher[]; subscribers: Subscriber[] } {
  const publishers: Publisher[] = [];
  for (const b of bindAttributes(ctx, publisherAttrRe)) {
    const kind: EventKind =
      b.match[1].toLowerCase() === 'integrationevent' ? 'integration' : 'business';
    publishers.push({
      owner: b.owner,
      eventName: stripQuotes(b.proc.name),
      kind,
      location: new vscode.Location(uri, new vscode.Position(b.proc.line, b.proc.col)),
      parameters: b.proc.parameters
    });
  }

  const subscribers: Subscriber[] = [];
  for (const b of bindAttributes(ctx, subscriberAttrRe)) {
    const m = b.match;
    const targetKind = objectKindFromString(m[1]);
    const targetName = m[2] ?? m[3] ?? m[4];
    const targetEvent = m[5] ?? m[6] ?? m[7];
    if (!targetKind || !targetName || !targetEvent) {
      continue;
    }
    subscribers.push({
      owner: b.owner,
      target: { kind: targetKind, name: targetName },
      targetEvent,
      location: new vscode.Location(uri, new vscode.Position(b.proc.line, b.proc.col)),
      resolved: false
    });
  }

  return { publishers, subscribers };
}

/**
 * The parsed skeleton of one AL file: its comment-stripped text, the line →
 * owning `ObjectRef` lookup, and an offset → (line, col) mapper.
 *
 * Built once per file and shared across every attribute sweep over that file.
 * `stripComments` and `findObjects` are both O(file), so re-deriving this per
 * sweep would re-scan the whole file for each attribute kind.
 */
export interface AlObjectContext {
  readonly cleaned: string;
  readonly ownerForLine: (line: number) => ObjectRef;
  /** Absolute offset into `cleaned` → its 0-based line and column. */
  readonly lineColAt: (idx: number) => { line: number; col: number };
}

/** One attribute match bound to the procedure it decorates. */
export interface AttributeBinding {
  /** The attribute regex's match, for reading its capture groups. */
  readonly match: RegExpMatchArray;
  /** Object declaring the decorated procedure. */
  readonly owner: ObjectRef;
  /** The decorated procedure's name, position, and parameter list. */
  readonly proc: ProcedureSite;
}

/**
 * Build the shared skeleton for one AL file's **raw** source, or `undefined`
 * when the file declares no AL object at all (nothing can be bound then).
 *
 * Comment stripping happens here rather than at the call site: every sweep
 * must see exactly the same comment-stripped view, and a caller that passed
 * raw text to a context that assumed stripped text would silently treat
 * commented-out object headers as real declarations.
 *
 * Exported so other AL-domain modules (`handlers.ts`) can run their own
 * attribute sweeps against exactly `parseAl`'s view of the file.
 */
export function makeObjectContext(
  text: string,
  appId?: string
): AlObjectContext | undefined {
  const cleaned = stripComments(text);
  const objects = findObjects(cleaned, appId);
  if (objects.length === 0) {
    return undefined;
  }
  const lineStarts = computeLineStarts(cleaned);
  return {
    cleaned,
    ownerForLine: makeOwnerLookup(objects),
    lineColAt: (idx: number) => lineColFrom(lineStarts, idx)
  };
}

/** Offsets at which each line of `text` begins. Index i → start of line i. */
function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * Map an absolute offset to (line, col) by binary-searching precomputed line
 * starts — O(log lines) per lookup.
 *
 * The previous `absToLineCol` counted newlines from offset 0 on every call,
 * which is O(offset). Called once per attribute match (and once more per
 * bound procedure), that made a file with many attributes O(matches × length)
 * overall — the same shape as the pathological scan bounded by
 * `PROCEDURE_SEARCH_WINDOW` in issue #125, and it runs on the CodeLens path,
 * i.e. on every edit and scroll of an open document.
 */
function lineColFrom(lineStarts: ReadonlyArray<number>, idx: number): { line: number; col: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= idx) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { line: lo, col: idx - lineStarts[lo] };
}

/**
 * Find every match of `attrRe` (which must be a global regex) and bind it to
 * the procedure it decorates, dropping any match that fails to bind.
 *
 * A match is dropped when either:
 * - no `procedure` keyword follows within `PROCEDURE_SEARCH_WINDOW`, or
 * - that procedure lives in a *different* object than the attribute.
 *
 * The second case is the dangling-attribute guard (issue #159): the bounded
 * procedure search can reach into the NEXT object when an attribute is left
 * with no procedure beneath it, which is common mid-edit. `ownerForLine`
 * returns the same `ObjectRef` instance for every line of one object, so an
 * identity mismatch means the procedure crossed an object boundary — binding
 * it would attribute a phantom publisher/subscriber/handler to the wrong
 * object. Valid AL, where an attribute always decorates a procedure in its own
 * object, is unaffected.
 *
 * Shared by `parseAl`'s publisher and subscriber sweeps and by
 * `parseHandlers`, so the boundary rule has exactly one implementation.
 *
 * A generator, so a file with thousands of attributes streams one binding at
 * a time instead of materializing every `RegExpMatchArray` (each of which
 * retains a back-reference to the whole input) at once.
 */
export function* bindAttributes(
  ctx: AlObjectContext,
  attrRe: RegExp
): Generator<AttributeBinding> {
  for (const m of ctx.cleaned.matchAll(attrRe)) {
    const attrStart = m.index ?? 0;
    const proc = findProcedureAfter(ctx, attrStart + m[0].length);
    if (!proc) {
      continue;
    }
    const procOwner = ctx.ownerForLine(proc.line);
    if (procOwner !== ctx.ownerForLine(ctx.lineColAt(attrStart).line)) {
      continue;
    }
    yield { match: m, owner: procOwner, proc };
  }
}

interface ObjectBoundary {
  readonly ref: ObjectRef;
  readonly startLine: number;
}

function findObjects(cleaned: string, appId?: string): ObjectBoundary[] {
  const out: ObjectBoundary[] = [];
  const lines = cleaned.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = objectHeaderRe.exec(lines[i]);
    if (!m) {
      continue;
    }
    const kind = objectKindFromString(m[1]);
    if (!kind) {
      continue;
    }
    const name = m[3] ?? m[4] ?? '';
    if (!name) {
      continue;
    }
    out.push({
      ref: {
        kind,
        id: m[2] ? parseInt(m[2], 10) : undefined,
        name,
        appId
      },
      startLine: i
    });
  }
  return out;
}

function makeOwnerLookup(objects: ReadonlyArray<ObjectBoundary>): (line: number) => ObjectRef {
  return (line: number): ObjectRef => {
    let owner = objects[0].ref;
    for (const o of objects) {
      if (o.startLine <= line) {
        owner = o.ref;
      } else {
        break;
      }
    }
    return owner;
  };
}

/** A procedure declaration site found beneath an attribute. */
export interface ProcedureSite {
  readonly line: number;
  readonly col: number;
  readonly name: string;
  readonly parameters: ReadonlyArray<Parameter>;
}

function findProcedureAfter(ctx: AlObjectContext, fromIdx: number): ProcedureSite | undefined {
  const text = ctx.cleaned;
  // Bound the keyword search to a fixed window so a procedure-less tail is
  // O(window) instead of O(remaining file) — see PROCEDURE_SEARCH_WINDOW.
  // The parameter list below is still read against the full `text`, so a
  // long multi-line signature that extends past the window parses in full.
  const rest = text.slice(fromIdx, fromIdx + PROCEDURE_SEARCH_WINDOW);
  const m = procedureRe.exec(rest);
  if (!m) {
    return undefined;
  }
  const absMatchStart = fromIdx + (m.index ?? 0);

  const nameOffsetInMatch = m[0].search(/[A-Za-z_"]/);
  const procKwIdx = m[0].toLowerCase().indexOf('procedure');
  const afterKw = m[0].slice(procKwIdx + 'procedure'.length);
  const wsLen = afterKw.length - afterKw.trimStart().length;
  const nameStartInMatch = nameOffsetInMatch >= 0
    ? procKwIdx + 'procedure'.length + wsLen
    : 0;
  const nameAbs = absMatchStart + nameStartInMatch;
  const { line, col } = ctx.lineColAt(nameAbs);

  // Locate the parameter list `(...)` immediately after the procedure name
  // and parse it. The name regex matched a single token, so the open paren
  // is the next non-whitespace character starting from the end of m[0].
  const afterMatchAbs = absMatchStart + m[0].length;
  const parameters = parseParameterListAt(text, afterMatchAbs);

  return { line, col, name: m[1], parameters };
}

/**
 * Starting at `fromIdx`, skip whitespace, expect `(`, then collect the
 * balanced contents through the matching `)` and parse them into a parameter
 * list. Returns `[]` for `()`, and `[]` (as a soft fallback) if no opening
 * paren is found within a few characters — pathological AL that lacks a
 * parameter list at all shouldn't crash parsing.
 */
function parseParameterListAt(text: string, fromIdx: number): ReadonlyArray<Parameter> {
  let i = fromIdx;
  while (i < text.length && /\s/.test(text[i])) {
    i++;
  }
  if (text[i] !== '(') {
    return [];
  }
  // Scan forward to the matching close paren, ignoring nested parens that
  // can appear inside type expressions like `Dictionary of [Code[20], Text]`.
  // A quoted AL identifier (`"Weird (Name)"` as a parameter name or quoted
  // Record subtype) can legally contain parens, so spans inside `"…"` are
  // skipped — their structural characters are part of the name, not the
  // list structure. (AL quoted identifiers have no embedded-quote escape, so
  // a single toggle on `"` suffices.)
  let depth = 0;
  let inQuote = false;
  const start = i + 1;
  let end = -1;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (inQuote) {
      continue;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        end = j;
        break;
      }
    }
  }
  if (end < 0) {
    return [];
  }
  const inner = text.slice(start, end).trim();
  if (!inner) {
    return [];
  }
  return splitParameterList(inner)
    .map(parseOneParameter)
    .filter((p): p is Parameter => p !== undefined);
}

/**
 * Split a parameter list body by `;` at the **top level only** — `;` inside
 * brackets (e.g. `Dictionary of [Code[20]; Text]`) is part of a type
 * expression and must not be treated as a separator. Spans inside a quoted
 * identifier (`"Weird ; Name"`) are skipped too, so a `;`/`[`/`]`/`(`/`)`
 * inside a quoted name or subtype is never mistaken for list structure.
 */
function splitParameterList(inner: string): string[] {
  const parts: string[] = [];
  let depthBracket = 0;
  let depthParen = 0;
  let inQuote = false;
  let last = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (inQuote) {
      continue;
    } else if (ch === '[') {
      depthBracket++;
    } else if (ch === ']') {
      depthBracket--;
    } else if (ch === '(') {
      depthParen++;
    } else if (ch === ')') {
      depthParen--;
    } else if (ch === ';' && depthBracket === 0 && depthParen === 0) {
      parts.push(inner.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(inner.slice(last));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Parse one AL parameter declaration of the form `[var ] Name : Type`. The
 * `Type` portion is preserved verbatim (whitespace trimmed) — collapsing it
 * into a richer model isn't necessary for display.
 */
function parseOneParameter(raw: string): Parameter | undefined {
  let s = raw.trim();
  let isVar = false;
  const varMatch = /^var\s+/i.exec(s);
  if (varMatch) {
    isVar = true;
    s = s.slice(varMatch[0].length);
  }
  const colonIdx = s.indexOf(':');
  if (colonIdx < 0) {
    return undefined;
  }
  const nameRaw = s.slice(0, colonIdx).trim();
  const typeText = s.slice(colonIdx + 1).trim();
  if (!nameRaw || !typeText) {
    return undefined;
  }
  return { name: stripQuotes(nameRaw), typeText, isVar };
}

function objectKindFromString(s: string): ObjectKind | undefined {
  const lower = s.toLowerCase();
  return (OBJECT_KINDS as ReadonlyArray<string>).includes(lower)
    ? (lower as ObjectKind)
    : undefined;
}

/**
 * Unwrap an AL quoted identifier or string literal — `"Weird Name"` and
 * `'Weird Name'` both yield `Weird Name`.
 *
 * Exported so `handlers.ts` unwraps procedure names through this one
 * implementation; a second copy would drift the moment AL identifier
 * unwrapping needs a fix (e.g. doubled-quote escapes).
 */
export function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Replace comment content with spaces (preserving newlines and string offsets),
 * so downstream regex matches don't fire on text inside line or block comments.
 *
 * Exported so callers that run their own regex sweeps over AL source (e.g. the
 * indexer's trigger-owner collection) match `parseAl`'s view of the file —
 * commented-out object headers must not be treated as real declarations.
 *
 * Implemented as a single forward character scan with five exclusive states
 * (preprocessor directive, single-quote string, double-quote quoted identifier,
 * line comment, block comment). A `//` or `/*` is only a comment opener while
 * in code state, so comment delimiters that appear *inside* an AL string
 * literal (`'…'`) or quoted identifier (`"…"`) are left verbatim rather than
 * blanking real code. AL's doubled-quote escapes (`''` inside `'…'`, `""`
 * inside `"…"`) are honored so an escaped quote doesn't prematurely close the
 * span. The result is the same length as the input: only non-newline comment
 * content is blanked to `' '`; every `\n`/`\r` is preserved, so all downstream
 * line/column and byte offsets are unchanged.
 *
 * A line whose first non-whitespace character is `#` is a **preprocessor
 * directive** (`#region` / `#endregion` / `#pragma`) and its text runs to
 * end-of-line as free text, not code. Directive text may legally contain any
 * delimiter — `#region Customer's balance` is ordinary BC code — so nothing in
 * it may open a string or comment state; letting the apostrophe there open a
 * phantom string inverts every subsequent boundary in the file and silently
 * both drops real events and fabricates ones from commented-out code (#182).
 * A comment delimiter on a directive line is the one exception: a trailing
 * `//` (or `/*`) is a genuine comment and is blanked to end-of-line like any
 * other, so nothing inside it reaches the attribute regexes. The rule is per
 * *line*, not per region: a `//`-commented object header between `#region` and
 * `#endregion` is still blanked like any other comment.
 */
export function stripComments(text: string): string {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  // True while nothing but whitespace has been seen since the last `\n`. Kept
  // as a running flag, updated by each branch below, rather than scanning
  // backwards over leading whitespace per `#`: a backwards scan is O(indent)
  // per character and reintroduces the quadratic shape #125 removed.
  let atLineStart = true;
  while (i < n) {
    const ch = text[i];
    // 1. Preprocessor directive: `#region` / `#endregion` / `#pragma`.
    //    Directive *text* is free text, not code — copy it through verbatim to
    //    end of line so nothing in it (`'`, `"`) opens a scanner state.
    //    Verbatim rather than blanked: `findObjects`' header regex is anchored
    //    at `^\s*(kind)` and can't match a directive line anyway, and copying
    //    preserves length/`\r`/`\n` for downstream offsets.
    //
    //    A comment delimiter on the line is the exception. A trailing `//` on a
    //    directive line genuinely *is* a comment and is blanked to end of line
    //    like any other, so a line such as
    //    `#pragma warning disable AA0005 // [IntegrationEvent(false, false)]`
    //    cannot feed the attribute regexes and fabricate a publisher. `/*` is
    //    blanked the same way — and, like `//`, only to the newline, so neither
    //    opens a state that could run into the following lines: the rule stays
    //    per line, not per region. A lone `/` is just directive text.
    //
    //    What #182 requires verbatim is the directive text itself (`#region
    //    Don't break`), which stays untouched up to any comment delimiter. The
    //    text before the delimiter is still swept by the attribute regexes, so
    //    `#region [IntegrationEvent] helpers` can still bind a phantom — that
    //    is the line-anchor bug class tracked by #179, not this one.
    if (atLineStart && ch === '#') {
      let inComment = false;
      while (i < n && text[i] !== '\n') {
        if (!inComment && text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
          inComment = true;
        }
        // Blank the comment, never the `\r` of a CRLF terminator: output length
        // and every `\n`/`\r` offset must match the input exactly.
        out[i] = inComment && text[i] !== '\r' ? ' ' : text[i];
        i++;
      }
      atLineStart = false;
      continue;
    }
    // 2. Single-quote string: spans lines; only a lone `'` closes it.
    if (ch === "'") {
      out[i] = ch;
      i++;
      while (i < n) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            // Doubled-quote escape — stays inside the string.
            out[i] = text[i];
            out[i + 1] = text[i + 1];
            i += 2;
            continue;
          }
          out[i] = text[i]; // closing quote
          i++;
          break;
        }
        out[i] = text[i];
        i++;
      }
      atLineStart = false;
      continue;
    }
    // 3. Double-quote quoted identifier: same shape as (2) with `"`.
    if (ch === '"') {
      out[i] = ch;
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            out[i] = text[i];
            out[i + 1] = text[i + 1];
            i += 2;
            continue;
          }
          out[i] = text[i];
          i++;
          break;
        }
        out[i] = text[i];
        i++;
      }
      atLineStart = false;
      continue;
    }
    // 4. Line comment: blank through to (but not including) the newline.
    if (ch === '/' && text[i + 1] === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && text[i] !== '\n') {
        out[i] = text[i] === '\r' ? '\r' : ' ';
        i++;
      }
      // Halts *before* the `\n`; the code branch consumes it and re-arms the
      // line-start flag on the next iteration.
      atLineStart = false;
      continue;
    }
    // 5. Block comment: blank through the first real `*/`; preserve newlines.
    if (ch === '/' && text[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n) {
        if (text[i] === '*' && text[i + 1] === '/') {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          break;
        }
        out[i] = text[i] === '\n' || text[i] === '\r' ? text[i] : ' ';
        i++;
      }
      atLineStart = false;
      continue;
    }
    // 6. Code: copy through verbatim.
    out[i] = ch;
    if (ch === '\n') {
      atLineStart = true;
    } else if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
      // `\r` is neutral, not a line ending: for CRLF the following `\n` arms
      // the flag, matching the `\r?\n` terminator the rest of the parser uses.
      atLineStart = false;
    }
    i++;
  }
  return out.join('');
}
