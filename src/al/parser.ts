import * as vscode from 'vscode';
import type { EventKind, ObjectKind, ObjectRef, Publisher, Subscriber } from './types';

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
 */
export function parseAl(
  uri: vscode.Uri,
  text: string
): { publishers: Publisher[]; subscribers: Subscriber[] } {
  const cleaned = stripComments(text);

  const objects = findObjects(cleaned);
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
      location: new vscode.Location(uri, new vscode.Position(proc.line, proc.col))
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

function findObjects(cleaned: string): ObjectBoundary[] {
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
        name
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
  return { line, col, name: m[1] };
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
