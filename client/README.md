# X4CodeSense

Language support for **X4: Foundations** scripts in Visual Studio Code: AI scripts (`aiscripts/*.xml`) and Mission Director scripts (`md/*.xml`).

X4CodeSense is the successor of X4CodeComplete. It is rebuilt around a language server, so the same analysis also runs from the command line and in CI.

## Status

Preview. The current build recognises script and patch documents, shows the script type and name in the status bar, and reports XML well-formedness problems (unclosed tags, missing quotes, missing end tags) as you type. Completion, hover, navigation and diagnostics are being ported and rebuilt in this order:

- XML structure and attribute validation from the game's XSD schemas
- Property completion, hover and go to definition from `scriptproperties.xml`
- A real parser for the expression language with syntax diagnostics
- Variables with scopes and inferred types
- Labels, actions, handlers, cues, libraries and script names across files
- Text file (`t/*.xml`) lookups: hover and completion for `{page, id}` references, also in other game XML such as macros, wares and libraries
- Patch documents (`<diff>`) checked in the context of the file they patch

## Requirements

- The extracted vanilla game files (`aiscripts`, `md`, `libraries`, `t`), set in `x4CodeSense.unpackedFileLocation`.
- Optionally a folder with other extensions whose scripts should be visible, set in `x4CodeSense.extensionsFolder`.

## Settings

- `x4CodeSense.unpackedFileLocation` - path to the extracted vanilla game files.
- `x4CodeSense.extensionsFolder` - path to a folder with other extensions.
- `x4CodeSense.languageNumber` - preferred language number for text lookups, `44` by default.
- `x4CodeSense.limitLanguageOutput` - show only the preferred language in hovers.
- `x4CodeSense.validateXmlStructure` - report elements that are not allowed at their position.
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

- XML well-formedness diagnostics for scripts and patches: unclosed start and end tags, missing or unquoted attribute values, missing closing quotes, duplicate attributes, missing end tags, unclosed comments.
- Initial scaffold: language server, client and command-line checker with script detection.
