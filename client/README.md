# X4CodeSense

Language support for **X4: Foundations** scripts in Visual Studio Code: AI scripts (`aiscripts/*.xml`) and Mission Director scripts (`md/*.xml`).

X4CodeSense is the successor of X4CodeComplete. It is rebuilt around a language server, so the same analysis also runs from the command line and in CI.

## Status

Preview. The current build:

- recognises script and patch documents and shows the script type and name in the status bar;
- reports XML well-formedness problems (unclosed tags, missing quotes, missing end tags) as you type;
- validates scripts against the game's XSD schemas: unknown elements and attributes, elements in the wrong place or missing, missing required attributes and invalid attribute values;
- parses every expression and reports syntax errors the way the game would reject them, plus `@` combined with `?`, text references that are not `{page, id}` literals, and `%d` in format strings;
- checks property chains against `scriptproperties.xml`: a property that does not exist on the type at hand (`player.ship.frobnicate`) and, in AI scripts, a chain head that is no keyword are reported as warnings;
- completes child elements allowed at the caret, attribute names, attribute values from the schema enumerations, and property chains in expressions from `scriptproperties.xml` (`player.ship.cargo.{$ware}.count`), with keywords and the values of lookups such as `class` or `ware`;
- shows hover documentation for elements, attributes, enumeration values, keywords and properties;
- goes to the definition of an element or attribute in the schema, of a keyword or property in `scriptproperties.xml`, and of a lookup value in the game file it comes from.

Being ported and rebuilt next, in this order:

- Variables with scopes and inferred types, following the cue namespace rules of the Mission Director guide
- Labels, actions, handlers, cues, libraries and script names across files
- Text file (`t/*.xml`) lookups: hover and completion for `{page, id}` references, also in other game XML such as macros, wares and libraries
- Patch documents (`<diff>`) checked in the context of the file they patch

## Requirements

- The extracted vanilla game files (`aiscripts`, `md`, `libraries`, `t`), set in `x4CodeSense.unpackedFileLocation`. The schemas `md.xsd`, `aiscripts.xsd` and `common.xsd` and `scriptproperties.xml` with the files it imports are read from its `libraries` folder; without it scripts are only checked for well-formedness.
- Optionally a folder with other extensions whose scripts should be visible, set in `x4CodeSense.extensionsFolder`.

## Settings

- `x4CodeSense.unpackedFileLocation` - path to the extracted vanilla game files.
- `x4CodeSense.extensionsFolder` - path to a folder with other extensions.
- `x4CodeSense.languageNumber` - preferred language number for text lookups, `44` by default.
- `x4CodeSense.limitLanguageOutput` - show only the preferred language in hovers.
- `x4CodeSense.validateXmlStructure` - check the order and completeness of child elements against the schemas, on by default. Unknown elements and attributes and invalid values are always reported.
- `x4CodeSense.debug` - verbose server logging in the X4CodeSense output channel.
- `x4CodeSense.trace.server` - LSP message tracing.

## Commands

- `X4CodeSense: Restart Language Server`

## Credits

- [Egosoft](https://www.egosoft.com) for the game.
- Cgetty and archenovalis for X4CodeComplete, the starting point of this extension.
- Members of the [x4_modding Discord channel](https://discord.com/channels/337098290917146624/502057640877228042) for answers, support and ideas.

## Changelog

### Unreleased

- Property chains are checked against `scriptproperties.xml`: unknown properties on a known type and, in AI scripts, unknown chain heads are reported as warnings. Lookup values (`class`, `faction`, `ware`, ...) are not checked because their lists lag behind the game and its DLCs. All placeholder forms of the game data are understood now: `<cuename>`, `<tagname>`, `$<variable>`, `[$x, $y, $z]`, bare values and list literals for `{$type}`, and a chain that stops inside a pattern. Keywords the game has but the file lacks (`component`, `chairtype`, `datatype.macroslot`) are added.
- Expression diagnostics: every attribute that takes an expression is parsed with the game's operator precedence; syntax errors, `@` combined with `?`, text references without numeric literals and `%d` in a format string are reported at their position. All 247,000 expressions of the vanilla scripts parse cleanly in about a second.
- Completion, hover and go to definition from the schemas and `scriptproperties.xml`: child elements allowed at the caret, attribute names, enumeration values, keywords, property chains with placeholders and lookup values. Lookups the game evaluates but `scriptproperties.xml` does not list (relation ranges, licence types, component states, input functions and more) come from the game's own data files. Everything keeps working while a tag, an attribute or a quote is still being typed.
- Schema validation of scripts against the game's XSD files, on by default: unknown elements and attributes, misplaced and missing child elements, missing required attributes, invalid attribute values with the expected values in the message. The schemas load in well under a second and the largest vanilla script validates in tens of milliseconds.
- XML well-formedness diagnostics for scripts and patches: unclosed start and end tags, missing or unquoted attribute values, missing closing quotes, duplicate attributes, missing end tags, unclosed comments.
- Initial scaffold: language server, client and command-line checker with script detection.
