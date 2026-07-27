import * as assert from 'assert';
import * as vscode from 'vscode';

// ─── Command Palette contribution guards ─────────────────────────────────
// Five commands are only meaningful when invoked with arguments — from a
// CodeLens, an activity-bar tree row, or a webview message. Listed in the
// palette they hit their own no-arg guard in `activate()` and return with
// no feedback at all (#180), so `contributes.menus.commandPalette` gates
// exactly those five behind `when: "false"`. That filters the picker only:
// registration, `executeCommand`, `TreeItem.command`, and `CodeLens.command`
// are untouched — which the `getCommands` case below pins down.
//
// The manifest is read back from the extension host rather than imported:
// `tsconfig.json` sets `"rootDir": "src"`, so `package.json` sits outside
// the compilation root and cannot be imported from a test.
// ─────────────────────────────────────────────────────────────────────────

const EXTENSION_ID = 'dvlprlife.al-eventlens';

/** Argument-only commands — must be hidden from the palette. */
const ARGUMENT_ONLY: readonly string[] = [
  'alEventLens.revealPublisher',
  'alEventLens.revealObject',
  'alEventLens.revealSubscriber',
  'alEventLens.gotoSubscriber',
  'alEventLens.showHandlerUsages'
];

/**
 * Commands that do something useful with no arguments — must stay in the
 * palette. `exportMermaid` is argument-*optional*: it falls back to the
 * panel's current selection and warns when there is none.
 */
const PALETTE_VISIBLE: readonly string[] = [
  'alEventLens.openPanel',
  'alEventLens.refresh',
  'alEventLens.exportMermaid'
];

interface CommandContribution {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
}

interface PaletteEntry {
  readonly command: string;
  readonly when?: string;
}

interface Manifest {
  readonly contributes: {
    readonly commands: readonly CommandContribution[];
    readonly menus?: { readonly commandPalette?: readonly PaletteEntry[] };
  };
}

function extension(): vscode.Extension<unknown> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) {
    throw new Error(`extension ${EXTENSION_ID} is not present in the test host`);
  }
  return ext;
}

function manifest(): Manifest {
  return extension().packageJSON as Manifest;
}

function declaredCommands(): readonly string[] {
  return manifest().contributes.commands.map((c) => c.command);
}

function paletteEntries(): readonly PaletteEntry[] {
  return manifest().contributes.menus?.commandPalette ?? [];
}

// ─── Tests ───────────────────────────────────────────────────────────────

suite('package.json: Command Palette contributions', () => {
  test('contributes.commands declares exactly the eight known commands', () => {
    const declared = declaredCommands();
    for (const id of [...ARGUMENT_ONLY, ...PALETTE_VISIBLE]) {
      assert.ok(declared.includes(id), `contributes.commands is missing ${id}`);
    }
    assert.strictEqual(
      declared.length,
      ARGUMENT_ONLY.length + PALETTE_VISIBLE.length,
      `unexpected command contributions: ${declared.join(', ')} — a new command ` +
        'needs a deliberate palette decision (visible, or hidden via commandPalette)'
    );
  });

  test('each argument-only command is gated behind when: "false"', () => {
    const entries = paletteEntries();
    for (const id of ARGUMENT_ONLY) {
      const entry = entries.find((e) => e.command === id);
      assert.ok(entry, `${id} has no contributes.menus.commandPalette entry`);
      assert.strictEqual(
        entry?.when,
        'false',
        `${id} must be hidden from the palette with when: "false"`
      );
    }
  });

  test('openPanel, refresh, and exportMermaid stay palette-visible', () => {
    const entries = paletteEntries();
    for (const id of PALETTE_VISIBLE) {
      const entry = entries.find((e) => e.command === id);
      assert.strictEqual(
        entry,
        undefined,
        `${id} works without arguments and must not be gated out of the palette`
      );
    }
  });

  test('the hidden set is exactly the five argument-only commands', () => {
    const hidden = paletteEntries()
      .filter((e) => e.when === 'false')
      .map((e) => e.command)
      .sort();
    assert.deepStrictEqual(
      hidden,
      [...ARGUMENT_ONLY].sort(),
      'the palette-hidden set drifted from the argument-only set'
    );
    assert.strictEqual(
      paletteEntries().length,
      ARGUMENT_ONLY.length,
      'commandPalette carries an entry that is not one of the five argument-only commands'
    );
    const declared = declaredCommands();
    for (const entry of paletteEntries()) {
      assert.ok(
        declared.includes(entry.command),
        `commandPalette names ${entry.command}, which contributes.commands does not declare`
      );
    }
  });

  test('hiding from the palette does not unregister any command', async () => {
    await extension().activate();
    const all = await vscode.commands.getCommands(true);
    for (const id of [...ARGUMENT_ONLY, ...PALETTE_VISIBLE]) {
      assert.ok(
        all.includes(id),
        `${id} is not registered — when: "false" must hide, never unregister`
      );
    }
  });
});
