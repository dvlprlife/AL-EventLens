import type { ObjectKind } from './types';

/** AL kind label-cased for display (`Codeunit`, `TableExtension`, ...).
 *  Shared by the activity-bar tree, the Mermaid exporter, and anywhere
 *  else that needs to render an `ObjectKind` to a human-readable label. */
export function formatKind(kind: ObjectKind): string {
  switch (kind) {
    case 'codeunit':         return 'Codeunit';
    case 'table':            return 'Table';
    case 'tableextension':   return 'TableExtension';
    case 'page':             return 'Page';
    case 'pageextension':    return 'PageExtension';
    case 'report':           return 'Report';
    case 'reportextension':  return 'ReportExtension';
    case 'query':            return 'Query';
    case 'xmlport':          return 'XmlPort';
    case 'enum':             return 'Enum';
    case 'enumextension':    return 'EnumExtension';
    case 'permissionset':    return 'PermissionSet';
    case 'interface':        return 'Interface';
  }
}
