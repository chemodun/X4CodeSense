/**
 * The window as "Edit This Patch Above What It Changes" arranges it: patches in one group, the comparison
 * of the one in front in the other. While the window has those two groups, a file that opens in the
 * comparisons' group (from the Explorer while a comparison has the focus, say) moves to the patches'
 * group, and the comparison below follows the patch in front above.
 *
 * Arranged or not, a patch's comparisons close with the patch's last tab, unless their side has unsaved
 * changes, which would be lost.
 */
import * as vscode from 'vscode';
import { patchedScheme } from './patchSides';

/** The patch document a tab compares, when it is a comparison of a patch with its editable side. */
function comparedPatch(tab: vscode.Tab | undefined): string | undefined {
  const input = tab?.input;
  return input instanceof vscode.TabInputTextDiff && input.modified.scheme === patchedScheme
    ? (new URLSearchParams(input.modified.query).get('patch') ?? undefined)
    : undefined;
}

export class PatchLayout implements vscode.Disposable {
  private arranged = false;
  private readonly disposables: vscode.Disposable[];

  /**
   * `moved` is called with a file moved to the patches' group: VS Code then reports no change of the active
   * editor (the comparison's side stays the last one reported), so the comparison would not follow it.
   */
  constructor(private readonly moved: (editor: vscode.TextEditor) => void) {
    this.disposables = [vscode.window.tabGroups.onDidChangeTabs((event) => this.tabsChanged(event))];
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  /** The window was just arranged so. */
  arrange(): void {
    this.arranged = true;
  }

  /** The two groups while the window is arranged so: two groups, one of them holding a comparison of a patch. */
  private groups(): { patches: vscode.TabGroup; comparisons: vscode.TabGroup } | undefined {
    const all = vscode.window.tabGroups.all;
    const comparisons = this.arranged && all.length === 2 ? all.find((group) => group.tabs.some((tab) => comparedPatch(tab) !== undefined)) : undefined;
    const patches = all.find((group) => group !== comparisons);
    if (!comparisons || !patches) {
      this.arranged = false;
      return undefined;
    }
    return { patches, comparisons };
  }

  private tabsChanged(event: vscode.TabChangeEvent): void {
    this.closeWithPatches(event.closed);
    const groups = this.groups();
    if (!groups) {
      return;
    }
    for (const tab of event.opened) {
      const input = tab.input;
      if (tab.group.viewColumn === groups.comparisons.viewColumn && input instanceof vscode.TabInputText && input.uri.scheme === 'file') {
        const preview = tab.isPreview;
        void Promise.resolve(vscode.window.tabGroups.close(tab))
          .then(() => vscode.window.showTextDocument(input.uri, { viewColumn: groups.patches.viewColumn, preview }))
          .then((editor) => this.moved(editor));
      }
    }
  }

  /** Closes the comparisons of patches no tab shows any more. */
  private closeWithPatches(closed: readonly vscode.Tab[]): void {
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
    const shown = new Set(tabs.flatMap((tab) => (tab.input instanceof vscode.TabInputText ? [tab.input.uri.toString()] : [])));
    const gone = new Set(
      closed.flatMap((tab) =>
        tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file' && !shown.has(tab.input.uri.toString()) ? [tab.input.uri.toString()] : []
      )
    );
    const comparisons = tabs.filter((tab) => {
      const patch = comparedPatch(tab);
      return patch !== undefined && gone.has(patch) && !tab.isDirty;
    });
    if (comparisons.length > 0) {
      void vscode.window.tabGroups.close(comparisons, true);
    }
  }

  /** Where to show the comparison of the patch in an editor that just came to the front: undefined when it is shown or not wanted. */
  comparisonColumn(editor: vscode.TextEditor): vscode.ViewColumn | undefined {
    const groups = this.groups();
    if (!groups || editor.viewColumn !== groups.patches.viewColumn || editor.document.uri.scheme !== 'file') {
      return undefined;
    }
    return comparedPatch(groups.comparisons.activeTab) === editor.document.uri.toString() ? undefined : groups.comparisons.viewColumn;
  }
}
