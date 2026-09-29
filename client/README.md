# X4CodeSense

Language support for **X4: Foundations** scripts in Visual Studio Code: AI scripts (`aiscripts/*.xml`), Mission Director scripts (`md/*.xml`) and the patches (`<diff>`) that change them. X4CodeSense reads the game's schemas, script properties and texts, and the scripts of the game, its DLCs and your extensions, and checks your scripts as you type.

X4CodeSense is the successor of X4CodeComplete, written anew around a language server, so the same analysis also runs from the command line and in CI.

> **Preview:** while the version is 0.x, features and settings may still change from one version to the next.

## ✨ Features

### Checks as you type

- XML well-formedness: unclosed tags, missing or unquoted attribute values, missing end tags, repeated attributes.
- Validation against the game's XSD schemas: unknown elements and attributes, elements in the wrong place or missing, missing required attributes, invalid attribute values.
- Expressions, parsed as the game parses them: syntax errors, `@` combined with `?`, text references that are not `{page, id}` literals, `%d` in format strings.
- Property chains, checked against `scriptproperties.xml`: a property the type at hand does not have (`player.ship.frobnicate`) and, in AI scripts, a chain head that is no keyword.
- Names, checked across the game, its DLCs and your extensions: labels, cues and libraries, interrupt library items, `md.Script.Cue`, and text references that no file defines; names defined twice.
- Variables that are read but never set, following the cue namespace rules of the Mission Director.

All of it keeps working while a tag, an attribute or a quote is still being typed. Open files count with their unsaved changes, and files changed on disk in the workspace are read again.

### Completion and hover

- Child elements allowed at the caret, attribute names, and attribute values from the schemas.
- Property chains in expressions (`player.ship.cargo.{$ware}.count`), keywords, and the values of lookups such as `class` or `ware`.
- Variables visible at the caret, also after `this.`, `parent.` or a cue name, and the variables other scripts set for this one: interrupt library items, libraries spliced in with `include_actions`, `md.Script.Cue.$x`.
- Labels, cues, libraries and interrupt library items; script names after `md.` and cue names after `md.Script.`, cues that an extension's patch adds included.
- Texts: pages after `{` and text ids after `{page,`. Hover over `{page, id}` or `page="…" line="…"`, in any XML file, shows the text as the game shows it.
- Hover documentation for elements, attributes, enumeration values, keywords and properties; for a variable, where it is set, its type when it can be told, and how often it is read.

### Navigation and rename

- Go to definition: an element or attribute in the schema, a keyword or property in `scriptproperties.xml`, a lookup value in the game file it comes from, and a variable, label, cue, script, interrupt library item or text where it is defined.
- Find all references and rename, across scripts: variables, labels, cues and libraries (also as `md.Script.Cue` in other scripts and in the paths of patches), Mission Director script names, and interrupt library items. A rename edits the files of your workspace only; when the game or an extension outside the workspace uses the same name, it is refused, with the reason.
- The outline, the breadcrumbs and Go to Symbol in Editor: cues and libraries as they nest, with their parameters; the order, interrupts, handlers, attention blocks with their labels and `on_abort` of AI scripts; each variable where it is first set; and each operation of a patch by its path.

### Semantic highlighting

VS Code colours XML attribute values as strings, so a whole expression is one colour. X4CodeSense colours what an expression holds, as the analysis understands it:

- variables (`$ship`), the game's keywords (`this`, `player`, `event`, `faction`, `md`), and properties (`$ship.owner`);
- the values of lookups (`faction.argon`, `class.ship`, `isclass.ship`) and the ids an attribute takes as they are, such as a macro or a sound;
- cues and libraries, also in `md.Script.Cue`, labels and interrupt library items, where they are defined and where they are used;
- numbers with their units (`5km`, `10s`), strings, `if`, `then`, `else`, and the operators and punctuation.

In a patch, what an `add` or `replace` brings in is coloured as where it lands. The colours come from your theme, as for other languages. Plain values such as `operation="add"` keep the colour of XML strings.

### Quick fixes

The light bulb (`Ctrl+.`) offers a fix where the fix is obvious: an unquoted value is put in quotes, an attribute without a value gets an empty one, a repeated attribute is removed, and the required attributes an element lacks are added. A misspelled element, attribute, value, keyword, property, cue, script, label, interrupt library item or variable is changed to the known names closest in spelling.

### Patches

- A patch is applied to the file it changes as the game applies it, after the patches loaded before it: a patch in your extension's `md` or `aiscripts` folder changes the game's file of the same name, one in `extensions/<folder>/md` that extension's file.
- Reported: a `sel` that selects nothing or several nodes, at the step where it stops matching; a patch with nothing to patch; an operation the game refuses; `sel` or `if` that is no valid XPath. The operations and their attributes are checked against the game's `diff.xsd`.
- What an `add` or `replace` brings in is checked where it lands, as the game will load it, and completion, hover, go to definition, references and rename work in it as they do there.
- In `sel` and `if`, hover tells what each step selects and where it is written, go to definition goes there, and completion offers the element and attribute names and the values, such as cue names, of the file as the operation finds it.
- **Show What This Patch Changes**, also a button in the editor's title bar, opens a diff of the file the patch changes, without and with the patch, and follows the patch as you type. **Open the File This Patch Changes** opens that file.

### Status bar

The status bar shows the type and name of the script, or the file a patch changes. While the game files are read and the scripts indexed, it shows a spinner and the progress, and a warning when the game files are not set or hold no schemas. Its tooltip tells what was read, and a click opens a menu of the commands.

### Command line and CI

The same checks run outside VS Code with [x4-script-check](https://www.npmjs.com/package/x4-script-check), which prints each finding with its severity and quick fixes: as text, as JSON for tools, or as annotations of the files in GitHub Actions.

```powershell
npx x4-script-check --unpacked C:\X4\extracted path\to\your\extension
```

## ⚠️ Known limitations

- Without the extracted game files, scripts are only checked for well-formedness: the schemas, the script properties, the texts and the game's scripts all come from them.
- Lookup values such as `class`, `faction` or `ware` are completed but not checked, since their lists in the game files lag behind the game and its DLCs.
- XPath in patches beyond what the game evaluates is reported as not understood, never as wrong.
- AI scripts, Mission Director scripts and their patches are checked. Text files are read for the texts; other files of the game, such as Lua scripts or the `libraries`, are not checked.
- Semantic highlighting needs the extracted game files, which tell which attributes hold expressions, and a theme that uses semantic colours. Most do, the default themes included; `"editor.semanticHighlighting.enabled": true` turns it on for the others.

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

### Extract the game files

X4CodeSense reads the game's own files: the schemas `md.xsd`, `aiscripts.xsd`, `common.xsd` and `diff.xsd` and `scriptproperties.xml` from `libraries`, the texts from `t`, and the game's scripts. Extract them with Egosoft's [X Catalog Tool](https://wiki.egosoft.com/X4%20Foundations%20Wiki/Modding%20Support/X%20Catalog%20Tool/), which Steam users get with the "X Tools":

- the game's catalogs (`01.cat`, `02.cat` and so on) into one folder, which then holds `aiscripts`, `md`, `libraries`, `t` and more;
- each DLC's catalogs (`ext_01.cat` and so on in `extensions/ego_dlc_*` of the game) into the folder of the same name under `extensions` of that folder, and copy each DLC's `content.xml` there from the game installation. The catalogs do not hold it, and without it the DLCs are read alphabetically instead of in the game's order, so patches of the same file by several DLCs are applied in the wrong order.

### Set it up

1. Run **X4CodeSense: Select the Extracted Game Files...** from the Command Palette (`Ctrl+Shift+P`), or click the X4CodeSense item in the status bar, and choose the folder you extracted the game to.
2. Open your extension's folder as the workspace, or a folder with several extensions.
3. If your extension uses the texts or scripts of other extensions that are not in the workspace, set `x4CodeSense.extensionsFolder` to where they are, for example `..` when your extensions sit side by side.
4. Open a script. The status bar shows the progress while the game files are read and the scripts are indexed, a few seconds, and its tooltip tells what was read.

## ⚙️ Extension settings

- `x4CodeSense.unpackedFileLocation` - the folder of the extracted game files (the folder holding `aiscripts`, `md`, `libraries` and `t`).
  - _default_: empty
- `x4CodeSense.extensionsFolder` - where the other extensions are, usually set per workspace. Relative to the workspace folder: empty or `.` is the workspace itself (a workspace of several extensions), `..` the folder above it (one workspace per extension, the extensions side by side); an absolute path is taken as is. The folder may be an extension or hold extensions, which are read in the order their `content.xml` dependencies give, so a dependency's texts and patches come before yours.
  - _default_: empty
- `x4CodeSense.languageNumber` - the preferred language for texts; the game's `libraries/languages.xml` lists the numbers.
  - _default_: `44` (English)
- `x4CodeSense.limitLanguageOutput` - show only the preferred language in hovers, and read only the text files of that language and English.
  - _default_: `false`
- `x4CodeSense.validateXmlStructure` - check the order and completeness of child elements against the schemas. Unknown elements and attributes and invalid values are always reported.
  - _default_: `true`
- `x4CodeSense.debug` - verbose logging in the X4CodeSense output channel.
  - _default_: `false`
- `x4CodeSense.trace.server` - trace the communication between VS Code and the language server: `off`, `messages` or `verbose`.
  - _default_: `off`

## ⌨️ Commands

All of them are also in the menu the status bar item opens.

- **X4CodeSense: Select the Extracted Game Files...** - sets `x4CodeSense.unpackedFileLocation` with a folder picker: in the workspace settings when they set it, else in the user settings.
- **X4CodeSense: Show What This Patch Changes** - in a patch: a diff of the file it changes, without and with the patch.
- **X4CodeSense: Open the File This Patch Changes** - in a patch.
- **X4CodeSense: Show Output** - the language server's log, with the problems met reading the game files.
- **X4CodeSense: Open Settings**
- **X4CodeSense: Restart Language Server** - reads the game files and the scripts again, for example after the extracted files or an extension outside the workspace changed.

## 📄 License

This project is licensed under the Apache License 2.0 - see the [LICENSE](https://github.com/chemodun/X4CodeSense/blob/main/LICENSE) file for details.

## 📝 Credits

- [Egosoft](https://www.egosoft.com) for the game.
- Cgetty, who started X4CodeComplete, and archenovalis, who continued it: this extension builds on its ideas and on the valuable experience gained during its development.
- Members of the [x4_modding Discord channel](https://discord.com/channels/337098290917146624/502057640877228042) for answers, support and ideas.

## 🛠 Changelog

### [0.2.0] - unreleased

- Added
  - Semantic highlighting of the expressions in AI scripts, Mission Director scripts and what patches bring in: variables, keywords, properties, lookup values, cues, labels, interrupt library items, numbers, strings and operators.

### [0.1.0] - 2026-09-29

- Added
  - First version, released on GitHub: diagnostics, completion, hover, go to definition, references, rename, the outline and quick fixes for AI scripts, Mission Director scripts and their patches, with the script index of the game, its DLCs and your extensions.
  - Patch comparison, the status bar and the commands.
  - The command-line checker [x4-script-check](https://www.npmjs.com/package/x4-script-check) and the language server [x4-script-language-server](https://www.npmjs.com/package/x4-script-language-server) on npm.
