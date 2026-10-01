/**
 * The right side of a patch comparison: the file the patch changes, with the patch applied, as a document
 * that can be edited. VS Code shows the documents of a content provider read-only, so the side comes from
 * a file system provider.
 *
 * Typing in what the patch itself brings in goes into the patch as it happens, unsaved there and undone
 * there; the side is then saved (without the user's save actions, which would change the game's text in
 * it) once typing pauses, so that closing it does not ask to save it. Any other change leaves the side
 * pending: it does not follow the patch, and saving it asks the server what the patch must become, new
 * operations included, which go into the patch unsaved, the patch's editor scrolled to them. A change the
 * server cannot write keeps the side unsaved, with the reason. While the side is the active editor it
 * keeps what was typed; once it is not, or once it was saved, it shows the server's text again, which may
 * differ where half-typed markup or the patch's indentation is written out.
 *
 * A caret moved in the patch moves to its place in the side, and back, where the patch's own pieces are.
 */
import * as vscode from 'vscode';
import { gameFileScheme, patchAfterScheme, type PatchComparisonResult, type PatchWriteParams, type PatchWriteResult } from 'x4-script-core';
import { mapChanges, patchOffsetAt, sideOffsetAt, sideText, type Segment, type TextChange } from './patchPieces';

/** The scheme of the patched side; the patch document's uri is in the query. */
export const patchedScheme = patchAfterScheme;

/** What the sides need of the language server, and where they log. */
export interface SideServer {
  compare(patch: string): Promise<PatchComparisonResult>;
  write(params: PatchWriteParams): Promise<PatchWriteResult>;
  log(line: string): void;
}

/** The side as the server has it for a version of the patch document. */
interface Answer {
  text: string;
  segments: Segment[];
  patchVersion: number;
}

interface Side {
  uri: vscode.Uri;
  patch: vscode.Uri;
  /** What the provider serves: the text last given to the editor or saved by it, with its segments. */
  served: Answer;
  mtime: number;
  /** The patch's pieces in the editor's text now, and the version of the patch document they are for. */
  segments: Segment[];
  patchVersion: number;
  /** The editor's text as last seen, to tell what a change removed. */
  seen: string;
  /** A change had no place in the patch: nothing is written or taken from the server until a revert. */
  pending: boolean;
  /** The provider announced a change: the editor's next change loads it. */
  loading: boolean;
  /** Saved into the patch: the server's next answer is shown even while the side is the active editor. */
  takeNext: boolean;
  /** A newer answer the side could not take yet. */
  waiting?: Answer;
}

const placeholder = '<!-- X4CodeSense: open the patch document to see the file it changes with it. -->\n';

const saveDelay = 500;

export class PatchedSides implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  private readonly sides = new Map<string, Side>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Changes of the sides are handled one after another: each may wait for an edit of the patch. */
  private queue: Promise<void> = Promise.resolve();
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private readonly server: SideServer) {
    this.disposables.push(
      this.changed,
      vscode.workspace.onDidChangeTextDocument((event) => this.changedDocument(event)),
      vscode.workspace.onDidCloseTextDocument((document) => this.sides.delete(document.uri.toString())),
      vscode.window.onDidChangeTextEditorSelection((event) => this.follow(event)),
      vscode.window.onDidChangeActiveTextEditor(() => this.activeEditorChanged()),
      { dispose: () => clearTimeout(this.saveTimer) }
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** The side of a patch document; its path names the file, so that the editor shows that name. */
  uriOf(patch: vscode.Uri, targetName: string): vscode.Uri {
    return vscode.Uri.from({ scheme: patchedScheme, path: `/${targetName}`, query: new URLSearchParams({ patch: patch.toString() }).toString() });
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const side = await this.sideOf(uri);
    // A patch of the installed game is one of its files, read only: so is its side.
    const readOnly = side.patch.scheme === gameFileScheme ? { permissions: vscode.FilePermission.Readonly } : {};
    return { type: vscode.FileType.File, ctime: 0, mtime: side.mtime, size: Buffer.byteLength(side.served.text), ...readOnly };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return Buffer.from((await this.sideOf(uri)).served.text, 'utf8');
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const side = this.sides.get(uri.toString());
    if (!side) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const written = Buffer.from(content).toString('utf8');
    // The editor writes the byte order mark back that it dropped when loading.
    const text = written.charCodeAt(0) === 0xfeff ? written.slice(1) : written;
    if (side.pending) {
      await this.writeIntoPatch(side, text);
      // What the patch gives now comes with the server's next answer.
      side.pending = false;
      side.takeNext = true;
      side.segments = [];
      side.patchVersion = -1;
    }
    side.served = { text, segments: side.segments, patchVersion: side.patchVersion };
    side.mtime = Math.max(side.mtime + 1, Date.now());
  }

  /** Asks the server what the patch must become for the side's text, and makes it so; throws what cannot be written. */
  private async writeIntoPatch(side: Side, text: string): Promise<void> {
    const patch = this.documentOf(side.patch);
    if (!patch) {
      throw vscode.FileSystemError.NoPermissions('X4CodeSense: open the patch to write this side into it.');
    }
    let result: PatchWriteResult | undefined;
    try {
      result = await this.server.write({ uri: side.patch.toString(), version: side.patchVersion, edited: text });
    } catch {
      // The server is starting or stopping.
    }
    if (!result) {
      throw vscode.FileSystemError.Unavailable('X4CodeSense: the language server did not answer; save again once it is ready.');
    }
    const name = side.uri.path.slice(1);
    if (result.refused.length > 0) {
      this.server.log(
        [`Not written into the patch, from ${name}:`, ...result.refused.map((refusal) => `  line ${refusal.line + 1}: ${refusal.reason}`)].join('\n')
      );
      const [first] = result.refused;
      const more = result.refused.length > 1 ? ` (and ${result.refused.length - 1} more in the output)` : '';
      throw vscode.FileSystemError.NoPermissions(`X4CodeSense cannot write line ${first.line + 1} into the patch: ${first.reason}${more}.`);
    }
    if (result.edits.length === 0) {
      return;
    }
    this.server.log([`Written into the patch, from ${name}:`, ...result.changes.map((change) => `  line ${change.line + 1}: ${change.label}`)].join('\n'));
    // Into the patch unsaved, where Undo takes it back. VS Code's refactor preview would hold the save
    // until it is answered, and starts entries that need confirmation unchecked.
    const edit = new vscode.WorkspaceEdit();
    const ranges = result.edits.map(
      (change) => new vscode.Range(change.range.start.line, change.range.start.character, change.range.end.line, change.range.end.character)
    );
    result.edits.forEach((change, number) => edit.replace(patch.uri, ranges[number], change.newText));
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw vscode.FileSystemError.NoPermissions('X4CodeSense: the patch could not be changed.');
    }
    const operations = result.changes.filter((change) => change.kind === 'operation').length;
    vscode.window.setStatusBarMessage(
      `$(check) X4CodeSense: ${result.changes.length} change${result.changes.length === 1 ? '' : 's'} written into the patch, ${operations} as new operation${operations === 1 ? '' : 's'}`,
      8000
    );
    // Where the first change went, in the patch's editor.
    const first = ranges[0].start;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document === patch) {
        editor.selection = new vscode.Selection(first, first);
        editor.revealRange(new vscode.Range(first, first), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  /** Asks the server again for every side the editor has, after the patch or the file it changes changed. */
  refreshAll(): void {
    for (const side of this.sides.values()) {
      void this.refresh(side);
    }
  }

  private async sideOf(uri: vscode.Uri): Promise<Side> {
    const known = this.sides.get(uri.toString());
    if (known) {
      return known;
    }
    const patch = vscode.Uri.parse(new URLSearchParams(uri.query).get('patch') ?? '');
    const answer = (await this.answerFor(patch)) ?? { text: placeholder, segments: [], patchVersion: -1 };
    // Asked twice at once, the first answer stays.
    const side = this.sides.get(uri.toString()) ?? {
      uri,
      patch,
      served: answer,
      mtime: Date.now(),
      segments: answer.segments,
      patchVersion: answer.patchVersion,
      seen: answer.text,
      pending: false,
      loading: false,
      takeNext: false,
    };
    this.sides.set(uri.toString(), side);
    return side;
  }

  private documentOf(uri: vscode.Uri): vscode.TextDocument | undefined {
    const key = uri.toString();
    return vscode.workspace.textDocuments.find((document) => document.uri.toString() === key);
  }

  /** The server's answer for the patch document as it is now, as the side's editor holds it. */
  private async answerFor(patch: vscode.Uri): Promise<Answer | undefined> {
    const document = this.documentOf(patch);
    if (!document) {
      return undefined;
    }
    let answer: PatchComparisonResult = null;
    try {
      answer = await this.server.compare(patch.toString());
    } catch {
      // The server is starting or stopping.
    }
    if (!answer || answer.version !== document.version) {
      return undefined;
    }
    const side = sideText(answer.after, answer.own, document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    return { text: side.text, segments: side.segments, patchVersion: answer.version };
  }

  private async refresh(side: Side): Promise<void> {
    const answer = await this.answerFor(side.patch);
    const document = this.documentOf(side.uri);
    if (!answer || !document) {
      return;
    }
    if (answer.text === document.getText()) {
      side.segments = answer.segments;
      side.patchVersion = answer.patchVersion;
      side.waiting = undefined;
      side.takeNext = false;
      if (!document.isDirty) {
        side.served = answer;
      }
      return;
    }
    side.waiting = answer;
    this.takeWaiting(side, document);
  }

  /**
   * Shows the waiting answer, unless the side has unsaved or pending changes or is being typed in (and was
   * not just saved, and does not show the placeholder, as a side restored from the last session does).
   */
  private takeWaiting(side: Side, document: vscode.TextDocument): void {
    const answer = side.waiting;
    const typedIn = vscode.window.activeTextEditor?.document === document && !side.takeNext && side.served.text !== placeholder;
    if (!answer || document.isDirty || side.pending || typedIn) {
      return;
    }
    side.waiting = undefined;
    side.takeNext = false;
    if (answer.patchVersion !== this.documentOf(side.patch)?.version) {
      void this.refresh(side);
      return;
    }
    side.served = answer;
    side.segments = answer.segments;
    side.patchVersion = answer.patchVersion;
    side.mtime = Math.max(side.mtime + 1, Date.now());
    side.loading = true;
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri: side.uri }]);
  }

  private activeEditorChanged(): void {
    const active = vscode.window.activeTextEditor?.document;
    for (const side of this.sides.values()) {
      const document = this.documentOf(side.uri);
      if (!document) {
        continue;
      }
      if (document === active) {
        if (document.isDirty && !side.pending) {
          this.saveSoon(side);
        }
      } else {
        this.takeWaiting(side, document);
      }
    }
  }

  private changedDocument(event: vscode.TextDocumentChangeEvent): void {
    const document = event.document;
    const side = document.uri.scheme === patchedScheme ? this.sides.get(document.uri.toString()) : undefined;
    if (!side) {
      return;
    }
    const text = document.getText();
    const changes: TextChange[] = event.contentChanges.map((change) => ({ offset: change.rangeOffset, length: change.rangeLength, text: change.text }));
    this.queue = this.queue.then(
      () => this.handle(side, document, changes, text),
      () => this.handle(side, document, changes, text)
    );
  }

  private async handle(side: Side, document: vscode.TextDocument, changes: TextChange[], text: string): Promise<void> {
    if (changes.length === 0) {
      // Saved: the side may take what the server has now.
      this.takeWaiting(side, document);
      return;
    }
    const before = side.seen;
    side.seen = text;
    const loading = side.loading;
    side.loading = false;
    if (text === side.served.text && (loading || side.pending)) {
      // The editor loaded what the provider serves: an announced change, or a revert of pending changes.
      // Otherwise the same text is an edit like any other, such as undoing what was typed.
      side.pending = false;
      side.segments = side.served.segments;
      side.patchVersion = side.served.patchVersion;
      if (side.waiting) {
        this.takeWaiting(side, document);
      } else {
        void this.refresh(side);
      }
      return;
    }
    const result = mapChanges(side.segments, changes, before);
    side.segments = result.segments;
    const patch = this.documentOf(side.patch);
    if (side.pending || !result.mapped || !patch || patch.version !== side.patchVersion) {
      if (!side.pending) {
        side.pending = true;
        vscode.window.setStatusBarMessage('$(info) X4CodeSense: save this side to write the change into the patch', 8000);
      }
      return;
    }
    if (result.edits.length > 0) {
      const edit = new vscode.WorkspaceEdit();
      for (const change of result.edits) {
        edit.replace(patch.uri, new vscode.Range(patch.positionAt(change.offset), patch.positionAt(change.offset + change.length)), change.text);
      }
      if (!(await vscode.workspace.applyEdit(edit))) {
        side.pending = true;
        return;
      }
      side.patchVersion = patch.version;
    }
    this.saveSoon(side);
  }

  /**
   * Saves the side once typing pauses. Only the active editor can be saved without the user's save
   * actions (formatting, trimming), which would change the game's text in the side.
   */
  private saveSoon(side: Side): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const active = vscode.window.activeTextEditor?.document;
      if (active?.uri.toString() === side.uri.toString() && active.isDirty && !side.pending) {
        void vscode.commands.executeCommand('workbench.action.files.saveWithoutFormatting');
      }
    }, saveDelay);
  }

  /** Moves the caret of the other editor to the same place, when the patch's own pieces hold it. */
  private follow(event: vscode.TextEditorSelectionChangeEvent): void {
    if (event.kind !== vscode.TextEditorSelectionChangeKind.Keyboard && event.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
      return;
    }
    const document = event.textEditor.document;
    const offset = document.offsetAt(event.selections[0].active);
    if (document.uri.scheme === patchedScheme) {
      const side = this.sides.get(document.uri.toString());
      const patch = side && this.documentOf(side.patch);
      const at = side && patch?.version === side.patchVersion ? patchOffsetAt(side.segments, offset) : undefined;
      if (patch && at !== undefined) {
        reveal(patch, patch.positionAt(at));
      }
      return;
    }
    for (const side of this.sides.values()) {
      const sideDocument = this.documentOf(side.uri);
      if (side.patch.toString() !== document.uri.toString() || document.version !== side.patchVersion || !sideDocument) {
        continue;
      }
      const at = sideOffsetAt(side.segments, offset);
      if (at !== undefined) {
        reveal(sideDocument, sideDocument.positionAt(at));
      }
    }
  }
}

/** Puts the caret of the visible editors of a document at a position, scrolled into view. */
function reveal(document: vscode.TextDocument, position: vscode.Position): void {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document === document) {
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }
}
