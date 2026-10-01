# X4CodeSense

Language support for **X4: Foundations** scripts in Visual Studio Code: AI scripts (`aiscripts/*.xml`), Mission Director scripts (`md/*.xml`) and the patches (`<diff>`) that change them or the game's library files (`libraries/*.xml`). X4CodeSense reads the game's schemas, script properties and texts, and the scripts of the game, its DLCs and your extensions, and checks your scripts as you type.

X4CodeSense is the successor of X4CodeComplete, written anew around a language server, so the same analysis also runs from the command line and in CI. It replaces X4CodeComplete and offers to take its settings.

> While the version is 0.x, features and settings may still change from one version to the next.

## ✨ Features

### Checks as you type

- XML well-formedness: unclosed tags, missing or unquoted attribute values, missing end tags, repeated attributes.
- Validation against the game's XSD schemas: unknown elements and attributes, elements in the wrong place or missing, missing required attributes, invalid attribute values.
- Expressions, parsed as the game parses them: syntax errors, `@` combined with `?`, text references that are not `{page, id}` literals, `%d` in format strings.
- Formats, `'%s of %s'.[$a, $b]` and `{page, id}.[…]`: fewer arguments than the placeholders take is a warning; arguments no placeholder takes, which are not shown, are reported as information.
- Property chains, checked against `scriptproperties.xml`: a property the type at hand does not have (`player.ship.frobnicate`) and, in AI scripts, a chain head that is no keyword.
- Names, checked across the game, its DLCs and your extensions: labels, cues and libraries, interrupt library items, `md.Script.Cue`, and text references that no file defines; names defined twice.
- Variables that are read but never set, following the cue namespace rules of the Mission Director.
- Parameters a call passes that the script, order or library it names does not declare: a `<param name="…">` of `run_script`, `create_order`, `run_actions`, a `cue` with `ref` and the like. Parameters a call leaves out are not reported; the game takes them as null.
- AI script names and order ids a call writes as is (`run_script name="'move.generic'"`, `create_order id="'Attack'"`) that no script of the game, its DLCs, the extensions or your workspace defines.

All of it keeps working while a tag, an attribute or a quote is still being typed. Open files count with their unsaved changes, and files changed on disk in the workspace are read again.

The Problems panel lists the problems of the open scripts, also of those in tabs that VS Code restored at start but has not shown yet, as they are on disk. With `x4CodeSense.diagnosticMode` set to `workspace`, it also lists those of every other script and patch in the workspace folders, as they are on disk. They are checked once the scripts are indexed, and again when something they refer to changes, for example when a cue or an order is renamed in the editor; an open script's problems follow the editor as before.

### Completion and hover

- Child elements allowed at the caret, attribute names, and attribute values from the schemas.
- Property chains in expressions (`player.ship.cargo.{$ware}.count`), keywords, and the values of lookups such as `class` or `ware`.
- Variables visible at the caret, also after `this.`, `parent.` or a cue name, and the variables other scripts set for this one: interrupt library items, libraries spliced in with `include_actions`, `md.Script.Cue.$x`.
- Labels, cues, libraries and interrupt library items; script names after `md.` and cue names after `md.Script.`, cues that an extension's patch adds included.
- Texts: pages after `{` and text ids after `{page,`, and in `page="…" line="…"` the page and the line. Hover over `{page, id}` or `page="…" line="…"` shows the text as the game shows it. Both work in any XML file, wares, macros, the text files and their patches included.
- The parameters of calls: in `run_script`, `run_interrupt_script`, `start_script`, `create_order`, `run_actions` and a `cue` with `ref`, signature help lists what the script, order or library declares, the parameter at the caret highlighted. `<param name="…">` completes the parameters not passed yet, those without a default first. Hover shows a parameter's description, default and type; go to definition leads to its declaration. The target must be written as is: `'order.trade.routine'`, `'Attack'`, `Lib` or `md.Script.Lib`.
- The arguments of a format: in `'%s of %s'.[$a, $b]` and `{page, id}.[…]`, signature help shows the format, for a text as the game shows it, with the placeholder of the argument at the caret highlighted. `%s` takes the next argument, also with flags such as `%,s`; `%1`, `%2` take the numbered one, and letters after the digits are text, as in `%4s` for seconds; `%%` is a percent sign.
- AI script names and order ids: in `run_script name`, `run_interrupt_script name`, `start_script name` and `create_order id`, completion offers the AI scripts and orders of the game, its DLCs, the extensions and your workspace, inserted with their quotes. Hover over one, or over `<aiscript name>` and `<order id>`, shows what it is: an order's name and description as the game shows them, the parameters, where it is defined, and how often other scripts name it.
- Hover documentation for elements, attributes, enumeration values, keywords and properties; for a variable, where it is set, its type when it can be told, and how often it is read.

### Texts in Lua files

In Lua files, hovering between the parentheses of `ReadText(page, id)` shows the text, as for `{page, id}` in scripts. The page and the id may be numbers, or names the file sets to one number, such as `local PAGE_ID = 1972092427`. When one of them is not known, the hover says why: a parameter, a loop variable, a field of a table, an expression. The Lua extension you use keeps its own hover and everything else. `.xpl` files count when VS Code opens them as Lua, for example with `"files.associations": { "*.xpl": "lua" }`.

### Navigation and rename

- Go to definition: an element or attribute in the schema, a keyword or property in `scriptproperties.xml`, a lookup value in the game file it comes from, and a variable, label, cue, script, order, interrupt library item or text where it is defined. With the installed game as the game files, its files open read-only, straight from its catalogs, and are the game's scripts there too: hover, go to definition, references and the outline work in them.
- Find all references and rename, across scripts: variables, labels, cues and libraries (also as `md.Script.Cue` in other scripts and in the paths of patches), Mission Director script names, and interrupt library items. A rename edits the files of your workspace only; when the game or an extension outside the workspace uses the same name, it is refused, with the reason.
- Find all references for AI script names and order ids: where they are defined and every call that names them as is (`'move.generic'`, `'Attack'`). They are not renamed: the game and any extension may name them.
- The outline, the breadcrumbs and Go to Symbol in Editor: cues and libraries as they nest, with their parameters; the order with its name as the game shows it, interrupts, handlers, attention blocks with their labels and `on_abort` of AI scripts; each variable where it is first set; and each operation of a patch by its path.
- Go to Symbol in Workspace (`Ctrl+T`): the scripts, cues, libraries and interrupt library items of the game, its DLCs, the extensions and your workspace, with the script they are in and where it comes from. With a dot, the query matches the name as other scripts write it: `md.Setup.Start`. Among equally good matches your workspace's come first. Labels are left to the outline of their script.

### Semantic highlighting

VS Code colours XML attribute values as strings, so a whole expression is one colour. X4CodeSense colours what an expression holds, as the analysis understands it:

- variables (`$ship`), the game's keywords (`this`, `player`, `event`, `faction`, `md`), and properties (`$ship.owner`);
- the values of lookups (`faction.argon`, `class.ship`, `isclass.ship`) and the ids an attribute takes as they are, such as a macro or a sound;
- cues and libraries, also in `md.Script.Cue`, labels and interrupt library items, where they are defined and where they are used;
- numbers with their units (`5km`, `10s`), strings, `if`, `then`, `else`, and the operators and punctuation.

In a patch, what an `add` or `replace` brings in is coloured as where it lands. The colours come from your theme, as for other languages. Plain values such as `operation="add"` keep the colour of XML strings.

### Quick fixes

The light bulb (`Ctrl+.`) offers a fix where the fix is obvious:

- Tags: an unquoted value is put in quotes, a value left open is closed, a start tag cut off is closed with `/>`, a missing end tag is added after the element's content, and an end tag that matches nothing is changed to the element left open when their names are close (`</set_valeu>`), or removed.
- Attributes and children: an attribute without a value gets an empty one, a repeated attribute is removed, the required attributes an element lacks are added, a required child is added when only a few may stand there, and a child where the schema does not allow it is moved before the sibling it must precede, such as `<conditions>` after `<actions>`.
- Names: a misspelled element, attribute, value, keyword, property, cue, script, label, interrupt library item, variable, parameter of a call, AI script name or order id is changed to the known names closest in spelling, and so is a name or value in a patch's `sel` where that step selects nothing.

When nothing defines a name and no known name is clearly the one meant, the light bulb also offers to create it:

- **Create cue** or **Create library**, after the cue that names it, or last in the other script `md.Script.Cue` names. A cue that `signal_cue` or `signal_cue_instantly` names waits for the signal (`event_cue_signalled`); what `include_actions`, `run_actions` or `<cue ref>` names is a library with actions and the parameters the call passes.
- **Create label**, first in the actions of the attention block that resumes at it.
- **Add the parameter** a call passes to the script, order or library it calls, after its other parameters, or in a new `<params>` where the schema allows one. An order's parameter gets the `type` it requires, empty, to be filled in.

These open the other file when what is created belongs there; the game's own scripts are never changed.

**Apply all preferred fixes in this file** applies at once the fix that is clearly the best for each problem of the file: in the light bulb when there are two or more, and as the source action `source.fixAll`, for example on save with `"[xml]": { "editor.codeActionsOnSave": { "source.fixAll": "explicit" } }`. Fixes that only add an empty value, a required attribute or the value of an attribute, are left out: the value is still to be written.

### Patches

- A patch is applied to the file it changes as the game applies it, after the patches loaded before it: a patch in your extension's `md` or `aiscripts` folder changes the game's file of the same name, one in `extensions/<folder>/md` that extension's file.
- A patch in your extension's `libraries` folder changes the game's library file of the same name, such as `libraries/wares.xml`. A file there whose root is that file's (`<wares>`) is a merge file: the game adds the children of its root to its file, and so do the patches loaded after it. A file whose root is neither `diff` nor the game file's is reported, since the game skips it.
- Reported: a `sel` that selects nothing or several nodes, at the step where it stops matching; a patch with nothing to patch; an operation the game refuses; `sel` or `if` that is no valid XPath. The operations and their attributes are checked against the game's `diff.xsd`.
- What an `add` or `replace` brings in is checked where it lands in a script, as the game will load it, and completion, hover, go to definition, references and rename work in it as they do there.
- In `sel` and `if`, hover tells what each step selects and where it is written, go to definition goes there, and completion offers the element and attribute names and the values, such as cue names, of the file as the operation finds it.
- **Show What This Patch Changes**, also a button in the editor's title bar, opens a diff of the file the patch changes, without and with the patch, and follows the patch as you type. What an operation brings in is shown at the column of the element it replaces or is added next to, or one step deeper than the element it is added into. **Open the File This Patch Changes** opens that file. Both work in a DLC's patch opened from the installed game as well, read only.
- **Edit This Patch Above What It Changes**, also a button in the title bar, puts the patch in the upper part of the window and that diff full width below it. While the window stays so, a file opened in the diff's group, from the Explorer for example, moves up to the patch's group, and the diff below follows the patch in front above. A patch's diffs close with it, unless their side has changes not yet written. The side with the patch can be edited, and the caret follows between the patch and that side:
  - Typing in what the patch brings in, its elements and the values it sets, goes into the patch as you type, undo included.
  - Other changes, such as a value of the game's own script, an element added next to the game's or one removed, are written into the patch when you save that side (or press **Write Changes into the Patch** in its title bar). They become new operations with a full path, in the order of the places they change: `replace` of a value, `add` with `type` for a new attribute, `add` next to a neighbour for new elements, `remove`, or `replace` of a whole element whose new value spans lines. Elements next to what the patch brings in join its `add`. The patch shows the changes unsaved, and Undo there takes them back.
  - A path names each element from the root: cues and libraries by `name`, other elements by `name`, `value`, `ref` or `id` when they have one, more attributes or a position only where siblings would share it.
  - Nothing is written unless the patch, applied again, gives exactly the side's elements and attributes and each operation selects what it did before. Otherwise the side stays unsaved and the reason is shown, for example a side that is not well-formed, or a change outside the root element.
- Both sides of that diff are the script they show: hover, go to definition, references, the outline and semantic highlighting work in them as in the script itself, and in the side with the patch completion and quick fixes too. That side shows the problems the file before the patch does not have: those in what the patch brings in, those of your edits in the side, and what they break elsewhere in the script, such as a read of a variable whose `set_value` the patch removes. The file's own problems are left to the file. Rename is refused in both sides; rename in the patch or in the script.

### Status bar

The status bar shows the type and name of the script, or the file a patch changes. While the game files are read and the scripts indexed, it shows a spinner and the progress, and a warning when the game files are not set or hold no schemas. Its tooltip tells what was read and where from, the extracted files or the installed game and its version, and which scripts show problems; a click opens a menu of the commands.

### Command line and CI

The same checks run outside VS Code with [x4-script-check](https://www.npmjs.com/package/x4-script-check), which prints each finding with its severity and quick fixes: as text, as JSON for tools, as annotations of the files in GitHub Actions, or as SARIF for GitHub code scanning. With `--fix` it first applies the preferred fixes, as **Apply all preferred fixes in this file** does in the editor.

```powershell
npx x4-script-check --unpacked C:\X4\extracted path\to\your\extension
npx x4-script-check --game "C:\Program Files (x86)\Steam\steamapps\common\X4 Foundations" path\to\your\extension
npx x4-script-check --fix --unpacked C:\X4\extracted path\to\your\extension
```

## 📚 Where its knowledge comes from

X4CodeSense has no list of its own of what the game holds: no elements, properties, wares, factions, ships or macros. It reads them from the game files, extracted or straight from the catalogs of the installed game, and from the extensions, so it follows the game version and the DLCs you have:

- The schemas in `libraries` (`md.xsd`, `aiscripts.xsd`, `common.xsd`, `diff.xsd`): every element, attribute and value with its documentation, where each may stand, and what an attribute holds: an expression, a cue, a label, a variable that receives a result.
- `libraries/scriptproperties.xml`: the keywords, datatypes and properties of expressions, and the lookups it imports from other game files.
- The texts in `t`; the scripts in `md` and `aiscripts` of the game, its DLCs, the extensions and your workspace; the files in `libraries` that the DLCs and extensions patch; each extension's `content.xml` for the order the game loads them in.
- Of an installed game, the catalogs `01.cat`, `02.cat` and so on, and those of the DLCs, the folders of its `extensions` whose names start with `ego_dlc_`: the files of `libraries`, `md`, `aiscripts` and `t` are read from them in place, nothing is extracted; the other folders of its `extensions` are your mods. `version.dat` gives the version the status bar shows.

A few things the game's files do not say are built in:

- The expression language itself: its operators, `if … then … else`, `typeof`, and the cue keywords `this`, `static`, `staticbase`, `parent` and `namespace`.
- Thirteen keywords the game evaluates but `scriptproperties.xml` does not list, written in the format of that file. Ten take their values from the game's own files (`common.xsd`, `factions.xsd`, `parameters.xsd`, `inputmap.xml`), such as `licencetype` and `moodtype`; `component`, `datatype.macroslot` and `chairtype` are written out, as the game's scripts use them.
- Which attribute of a call names what it calls (`run_script name`, `create_order id`, `run_actions ref`, `<cue ref>`, `start_script name`, `run_interrupt_script name`), and that the `ref` of `cue`, `include_actions` and `run_actions` names a cue or a library: the schemas say so only in their descriptions.
- The patch operations `add`, `replace` and `remove`, and the names of text files (`0001-l044.xml`), as the game reads them.
- What a quick fix creates: a cue that `signal_cue` names waits for the signal, as nine in ten such cues of the game do; a library that `include_actions` or `run_actions` names has actions.

## ⚠️ Known limitations

- Without the game files, extracted or installed, scripts are only checked for well-formedness: the schemas, the script properties, the texts and the game's scripts all come from them.
- Extensions are read from their files: an extension packed into catalogs of its own (`ext_01.cat`) is not read yet, the DLCs of an installed game aside.
- Lookup values such as `class`, `faction` or `ware` are completed but not checked, since their lists in the game files lag behind the game and its DLCs.
- XPath in patches beyond what the game evaluates is reported as not understood, never as wrong.
- In the side with the patch, text inside elements (which scripts do not have) and the order of attributes are not written into the patch. A changed comment of the game's script becomes its removal and a new comment. What a patch brings in and then changes again with another of its operations is changed where that operation does, not from the side.
- AI scripts, Mission Director scripts and their patches are checked. The patches of library files are applied and their paths checked, but what they bring in is not, since the game has no schemas for those files. Text files are read for the texts, and Lua files only for the texts of `ReadText`; other files of the game are not checked.
- Writing the changes of the side of a large library file, such as `wares.xml` after the DLCs' patches, into its patch takes up to about a second.
- In `ReadText`, a page or id from a field of a table (`config.page`), from another file or from an expression is not followed.
- Semantic highlighting needs the game files, which tell which attributes hold expressions, and a theme that uses semantic colours. Most do, the default themes included; `"editor.semanticHighlighting.enabled": true` turns it on for the others.

## 🚀 Getting started

### Install the extension

#### Via VS Code Marketplace

1. Open the Extensions view (`Ctrl+Shift+X`, or `Cmd+Shift+X` on macOS).
2. Search for "X4CodeSense" and click "Install".

Or open [X4CodeSense on the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=X4DevTools.x4codesense) and click "Install" there.

#### Via VSIX file

1. Download the `.vsix` file from the [X4CodeSense releases on GitHub](https://github.com/chemodun/X4CodeSense/releases).
2. In the Extensions view, open the `...` menu at its top right and select "Install from VSIX...".
3. Choose the downloaded file.

### The game files

X4CodeSense reads the game's own files: the schemas `md.xsd`, `aiscripts.xsd`, `common.xsd` and `diff.xsd` and `scriptproperties.xml` from `libraries`, the texts from `t`, and the game's scripts. It reads them from one of two places:

- **The installed game**, nothing to extract: the folder holding `X4.exe` and the catalogs `01.cat`, `02.cat` and so on, such as `C:\Program Files (x86)\Steam\steamapps\common\X4 Foundations`. The files of the game and of its DLCs are read from the catalogs in place, so they follow every update of the game.
- **The extracted game files**, when you keep them extracted anyway. They come first when both are set.

To extract them, use Egosoft's [X Catalog Tool](https://wiki.egosoft.com/X4%20Foundations%20Wiki/Modding%20Support/X%20Catalog%20Tool/), which Steam users get with the "X Tools":

- the game's catalogs (`01.cat`, `02.cat` and so on) into one folder, which then holds `aiscripts`, `md`, `libraries`, `t` and more;
- each DLC's catalogs (`ext_01.cat` and so on in `extensions/ego_dlc_*` of the game) into the folder of the same name under `extensions` of that folder, and copy each DLC's `content.xml` there from the game installation. The catalogs do not hold it, and without it the DLCs are read alphabetically instead of in the game's order, so patches of the same file by several DLCs are applied in the wrong order.

### Coming from X4CodeComplete

X4CodeSense replaces X4CodeComplete: uninstall X4CodeComplete, so the two do not check the same scripts. X4CodeComplete-Lua completes and describes the game's Lua functions, which X4CodeSense does not; both show the text of `ReadText` in Lua files. Their settings stay in your settings files after an uninstall. When X4CodeSense starts where it has no settings of its own yet, in the user settings or in the workspace settings, it offers the ones found there: the extracted game files, the extensions folder, the language settings, the structure validation and verbose logging. **Use** copies them, **Show Them** lists them in the X4CodeSense output first, **Not Now** asks again at the next start, and **Never** stops asking.

A folder that no longer exists is not taken, nor a relative extensions folder, which X4CodeSense reads from the workspace folder and X4CodeComplete did not. Where both X4CodeComplete and X4CodeComplete-Lua have a setting, X4CodeComplete's is taken.

### Set it up

1. Run **X4CodeSense: Select the Installed Game...** from the Command Palette (`Ctrl+Shift+P`), or click the X4CodeSense item in the status bar, and choose the folder the game is installed in. Or run **X4CodeSense: Select the Extracted Game Files...** and choose the folder you extracted the game to.
2. Open your extension's folder as the workspace, or a folder with several extensions.
3. If your extension uses the texts or scripts of other extensions that are not in the workspace, set `x4CodeSense.extensionsFolder` to where they are, for example `..` when your extensions sit side by side.
4. Open a script. The status bar shows the progress while the game files are read and the scripts are indexed, a few seconds, and its tooltip tells what was read.

## ⚙️ Extension settings

- `x4CodeSense.unpackedFileLocation` - the folder of the extracted game files (the folder holding `aiscripts`, `md`, `libraries` and `t`). When set, it is used rather than `x4CodeSense.gameFolder`.
  - _default_: empty
- `x4CodeSense.gameFolder` - the folder of the installed game (the folder holding `X4.exe` and `01.cat`, `02.cat` and so on), read from its catalogs in place when `x4CodeSense.unpackedFileLocation` is empty.
  - _default_: empty
- `x4CodeSense.extensionsFolder` - where the other extensions are, usually set per workspace. Relative to the workspace folder: empty or `.` is the workspace itself (a workspace of several extensions), `..` the folder above it (one workspace per extension, the extensions side by side); an absolute path is taken as is. The folder may be an extension or hold extensions, which are read in the order their `content.xml` dependencies give, so a dependency's texts and patches come before yours.
  - _default_: empty
- `x4CodeSense.languageNumber` - the preferred language for texts; the game's `libraries/languages.xml` lists the numbers.
  - _default_: `44` (English)
- `x4CodeSense.limitLanguageOutput` - show only the preferred language in hovers, and read only the text files of that language and English.
  - _default_: `false`
- `x4CodeSense.validateXmlStructure` - check the order and completeness of child elements against the schemas. Unknown elements and attributes and invalid values are always reported.
  - _default_: `true`
- `x4CodeSense.diagnosticMode` - which scripts the Problems panel lists problems of: `openFilesOnly`, the scripts open in the editor, or `workspace`, also every other script and patch in the workspace folders, as they are on disk. Checking them all takes a few seconds for a hundred scripts, once after the scripts are indexed and again in the background when something they refer to changes.
  - _default_: `openFilesOnly`
- `x4CodeSense.debug` - verbose logging in the X4CodeSense output channel.
  - _default_: `false`
- `x4CodeSense.trace.server` - trace the communication between VS Code and the language server: `off`, `messages` or `verbose`.
  - _default_: `off`

## ⌨️ Commands

All of them but **Write Changes into the Patch**, which belongs to the side with the patch, are also in the menu the status bar item opens.

- **X4CodeSense: Select the Installed Game...** - sets `x4CodeSense.gameFolder` with a folder picker: in the workspace settings when they set it, else in the user settings. When the extracted game files are set too, it offers to clear them, so that the installed game is used.
- **X4CodeSense: Select the Extracted Game Files...** - sets `x4CodeSense.unpackedFileLocation` with a folder picker, in the same way.
- **X4CodeSense: Choose Which Scripts Show Problems...** - sets `x4CodeSense.diagnosticMode` to the open scripts or every script in the workspace: in the workspace settings when they set it, else in the user settings.
- **X4CodeSense: Show What This Patch Changes** - in a patch: a diff of the file it changes, without and with the patch.
- **X4CodeSense: Edit This Patch Above What It Changes** - in a patch: the patch above that diff, the side with the patch editable.
- **X4CodeSense: Write Changes into the Patch** - in the side with the patch: saves it, which writes its changes into the patch.
- **X4CodeSense: Open the File This Patch Changes** - in a patch.
- **X4CodeSense: Show Output** - the language server's log, with the problems met reading the game files.
- **X4CodeSense: Open Settings**
- **X4CodeSense: Restart Language Server** - reads the game files and the scripts again, for example after the game was updated or an extension outside the workspace changed.

## 📄 License

This project is licensed under the Apache License 2.0 - see the [LICENSE](https://github.com/chemodun/X4CodeSense/blob/main/LICENSE) file for details.

## 📝 Credits

- [Egosoft](https://www.egosoft.com) for the game.
- Cgetty, who started X4CodeComplete, and archenovalis, who continued it: this extension builds on its ideas and on the valuable experience gained during its development.
- Members of the [x4_modding Discord channel](https://discord.com/channels/337098290917146624/502057640877228042) for answers, support and ideas.

## 🛠 Changelog

### [0.9.0] - unreleased

- Added
  - Patches of the game's library files, in an extension's `libraries` folder (`libraries/wares.xml` and the like): applied to the game's file after the patches and merge files of the DLCs and extensions loaded before them, with the problems of their paths, completion, hover and go to definition in them, the status bar, and the diff of the file without and with the patch.
  - Merge files in `libraries`, whose root is the game file's, merged as the game merges them before the patches loaded after them. A file there whose root is neither `diff` nor the game file's is reported (`library-root-mismatch`): the game skips it.
  - The files of `libraries` are in the workspace's problems and in the checks of x4-script-check.
- Changed
  - Patches are applied faster where a step of a path picks a node by an attribute's value, such as `cue[@name='Start']`: the node is found without looking at each of its siblings.
  - Hover over a step of a patch's path names an element without `name` by its `id`.
- Fixed
  - In the diff of a patch, the file's document type declaration is kept, and the end tag of an element that gets its first child ends its line with the file's line break.

### [0.8.0] - 2026-10-01

- Added
  - The installed game as the game files, nothing to extract: `x4CodeSense.gameFolder`, set with **Select the Installed Game...**, also from the status bar's menu. Its files and its DLCs' are read straight from their catalogs, and open read-only where go to definition, references and **Open the File This Patch Changes** lead.
  - The status bar's tooltip tells where the game files come from, and the installed game's version.
  - The command-line checker reads an installed game with `--game`: its files and its DLCs' straight from their catalogs, without extracting them.
- Fixed
  - An extension linked into a folder of extensions, as modders and mod managers do with a junction or a symbolic link, is found.

### [0.7.0] - 2026-10-01

- Added
  - The command-line checker applies the preferred fixes with `--fix`, and writes SARIF for GitHub code scanning with `--format sarif`.
  - Quick fixes that create what nothing defines: a cue or library, also in the script `md.Script.Cue` names, a label, and a parameter a call passes in the script, order or library it calls.
  - Quick fixes for tags and children: a value or start tag left open is closed, a missing end tag added, an end tag that matches nothing renamed or removed, a required child added, a child moved where the schema allows it; and for the step of a patch's `sel` that selects nothing, the names the file has there.
  - Completion of text references in any XML file, such as wares, macros and the text files, not only in scripts.
  - Signature help for the arguments of a format, `'%s of %s'.[…]` or `{page, id}.[…]`, with the placeholder of the argument at the caret highlighted.
  - A warning for a format given fewer arguments than it takes, and information for arguments it does not show.
  - The README tells where X4CodeSense takes its knowledge from, and what is built in.
- Fixed
  - A value whose text ends in `name=`, such as `comment="… instead of otherobject="` in `gs_pirate1.xml` of the Tides of Avarice DLC, is no longer taken for an unclosed value followed by another attribute.

### [0.6.0] - 2026-10-01

- Added
  - The problems of every script and patch in the workspace, not only of the open ones, when `x4CodeSense.diagnosticMode` is `workspace`; **Choose Which Scripts Show Problems** sets it, also from the status bar's menu.
  - Apply all preferred fixes in this file: in the light bulb, and as `source.fixAll` for `editor.codeActionsOnSave`.
  - A warning for an AI script name or order id that a call writes as is and no script defines, with a quick fix to the known name it is close to.
  - The outline shows an order's name as the game shows it.
- Fixed
  - After a start of VS Code, the scripts in the restored tabs show their problems, not only the one in front.
  - X4CodeSense starts with a workspace that holds scripts, before a script is opened.

### [0.5.0] - 2026-10-01

- Added
  - Go to Symbol in Workspace: the scripts, cues, libraries and interrupt library items of the game, its DLCs, the extensions and the workspace, also as `md.Script.Cue`.
  - The parameters of calls (`run_script`, `create_order`, `run_actions`, `<cue ref>`, …): signature help, completion of the parameter names, hover with their description and default, and go to their declaration.
  - A warning for a parameter a call passes that its target does not declare, with a quick fix to the declared name it is close to. The game's own scripts have four, left behind when a library changed.
  - AI script names and order ids in calls (`run_script name="'move.generic'"`, `create_order id="'Attack'"`): completion, hover with an order's name and description, go to definition, and find all references, also from `<aiscript name>` and `<order id>`.

### [0.4.1] - 2026-10-01

- Fixed
  - A patch opened in the group of the diff, such as from the Explorer while the diff has the focus, moves to the patches as before, and now its diff opens below it.
- Changed
  - Typing in large scripts is faster: semantic highlighting takes up to half the time it took, the checks up to a tenth less.

### [0.4.0] - 2026-10-01

- Added
  - Both sides of the diff of a patch have the script's hover, go to definition, references, outline and semantic highlighting, and the side with the patch its completion and quick fixes. That side shows the problems the file before the patch does not have, also what the patch breaks elsewhere in the script.
- Fixed
  - A folder added to the workspace while the game files are still read is no longer left out of the index until a restart.

### [0.3.0] - 2026-10-01

- Added
  - **Edit This Patch Above What It Changes**: the patch above the diff of the file it changes, and the caret follows between them. The side with the patch can be edited: typing in what the patch brings in goes into the patch at once; saving the side writes its other changes into the patch as new operations, with full paths, in the order of the places they change.
  - While the window is arranged so, a file opened in the diff's group moves up to the patch's, and the diff follows the patch in front above.
- Changed
  - In the diff of a patch, what an operation brings in is shown at the column of the element it replaces or is added next to, or one step deeper than the element it is added into, instead of its column in the patch.
  - A patch's diffs close with the patch.
- Fixed
  - A diff of a patch restored from the last session gets its text once the game files are read.

### [0.2.2] - 2026-09-30

- Fixed
  - Hover over a property whose name goes on after it, such as `mayattack` in `$ship.mayattack.{$faction}`, shows that property and every variant that fits as well. When the type of `$ship` was not known, it showed unrelated `{$numeric}` properties.
  - Completion after such a name offers its `{…}` variants first, also when the type before it is not known: `$ship.mayattack.` offers `{$component}` and `{$faction}`.
  - A bare value such as `argon` is taken only where `scriptproperties.xml` declares a shortcut for it (`isclass.<classname>`, `skill.<skillname>`), and completion offers bare values only there.

### [0.2.1] - 2026-09-30

- Changed
  - No longer marked as a preview on the Marketplace.

### [0.2.0] - 2026-09-30

- Added
  - Semantic highlighting of the expressions in AI scripts, Mission Director scripts and what patches bring in: variables, keywords, properties, lookup values, cues, labels, interrupt library items, numbers, strings and operators.
  - The settings of X4CodeComplete and X4CodeComplete-Lua are offered where X4CodeSense has none of its own yet.
  - In Lua files, the hover between the parentheses of `ReadText(page, id)` shows the text; page and id may be names the file sets to a number.

### [0.1.0] - 2026-09-29

- Added
  - First version, released on GitHub: diagnostics, completion, hover, go to definition, references, rename, the outline and quick fixes for AI scripts, Mission Director scripts and their patches, with the script index of the game, its DLCs and your extensions.
  - Patch comparison, the status bar and the commands.
  - The command-line checker [x4-script-check](https://www.npmjs.com/package/x4-script-check) and the language server [x4-script-language-server](https://www.npmjs.com/package/x4-script-language-server) on npm.
