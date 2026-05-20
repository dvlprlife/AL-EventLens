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
  const cleaned = stripComments(text);

  const objects = findObjects(cleaned, appId);
  if (objects.length === 0) {
    return { publishers: [], subscribers: [] };
  }

  const ownerForLine = makeOwnerLookup(objects);

  const publishers: Publisher[] = [];
  for (const m of cleaned.matchAll(publisherAttrRe)) {
    const attrEnd = (m.index ?? 0) + m[0].length;
    const proc = findProcedureAfter(cleaned, attrEnd);
    if (!proc) {
      continue;
    }
    const kind: EventKind =
      m[1].toLowerCase() === 'integrationevent' ? 'integration' : 'business';
    publishers.push({
      owner: ownerForLine(proc.line),
      eventName: stripQuotes(proc.name),
      kind,
      location: new vscode.Location(uri, new vscode.Position(proc.line, proc.col)),
      parameters: proc.parameters
    });
  }

  const subscribers: Subscriber[] = [];
  for (const m of cleaned.matchAll(subscriberAttrRe)) {
    const attrEnd = (m.index ?? 0) + m[0].length;
    const proc = findProcedureAfter(cleaned, attrEnd);
    if (!proc) {
      continue;
    }
    const targetKind = objectKindFromString(m[1]);
    const targetName = m[2] ?? m[3] ?? m[4];
    const targetEvent = m[5] ?? m[6] ?? m[7];
    if (!targetKind || !targetName || !targetEvent) {
      continue;
    }
    subscribers.push({
      owner: ownerForLine(proc.line),
      target: { kind: targetKind, name: targetName },
      targetEvent,
      location: new vscode.Location(uri, new vscode.Position(proc.line, proc.col)),
      resolved: false
    });
  }

  return { publishers, subscribers };
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

interface ProcedureSite {
  readonly line: number;
  readonly col: number;
  readonly name: string;
  readonly parameters: ReadonlyArray<Parameter>;
}

function findProcedureAfter(text: string, fromIdx: number): ProcedureSite | undefined {
  const rest = text.slice(fromIdx);
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
  const { line, col } = absToLineCol(text, nameAbs);

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
  // can appear inside type expressions like `Dictionary of [Code[20], Text]`
  // even though AL parameter lists rarely nest deeply. Strings inside AL
  // identifiers are quoted with `"…"` and cannot contain literal parens, so
  // a simple depth counter is sufficient.
  let depth = 0;
  const start = i + 1;
  let end = -1;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === '(') {
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
 * expression and must not be treated as a separator.
 */
function splitParameterList(inner: string): string[] {
  const parts: string[] = [];
  let depthBracket = 0;
  let depthParen = 0;
  let last = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '[') {
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

function absToLineCol(text: string, idx: number): { line: number; col: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < idx && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: idx - lineStart };
}

function objectKindFromString(s: string): ObjectKind | undefined {
  const lower = s.toLowerCase();
  return (OBJECT_KINDS as ReadonlyArray<string>).includes(lower)
    ? (lower as ObjectKind)
    : undefined;
}

function stripQuotes(s: string): string {
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
 */
export function stripComments(text: string): string {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    m.replace(/[^\n]/g, ' ')
  );
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  return out;
}
