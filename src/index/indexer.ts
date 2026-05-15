import type * as vscode from 'vscode';
import type { Publisher, Subscriber } from '../al/types';

/** A fully built, resolved event index for one workspace session. */
export interface EventIndex {
  readonly publishers: ReadonlyArray<Publisher>;
  readonly subscribers: ReadonlyArray<Subscriber>;
}

/**
 * Build the full event index for the current workspace: walk every `.al`
 * file under workspace folders, walk every `.app` under `.alpackages`,
 * synthesize trigger publishers, then resolve subscriber → publisher
 * links.
 */
export async function buildIndex(context: vscode.ExtensionContext): Promise<EventIndex> {
  throw new Error(`buildIndex(extensionUri=${context.extensionUri.toString()}): not yet implemented`);
}
