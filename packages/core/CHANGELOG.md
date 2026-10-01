# Changelog

## [0.8.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-core@v0.7.0...x4-script-core@v0.8.0) (2026-10-01)


### Features

* an installed game read in place, and the checker's --game ([cdb2868](https://github.com/chemodun/X4CodeSense/commit/cdb286845bcbb176007444708106e3ca58437c69))
* the installed game in the extension, its files as read-only documents ([a02bc0b](https://github.com/chemodun/X4CodeSense/commit/a02bc0b99ccb8edae7e7b4b91d002e847b0329cd))

## [0.7.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-core@v0.6.0...x4-script-core@v0.7.0) (2026-10-01)


### Features

* --fix and SARIF output in the checker ([3e84bc2](https://github.com/chemodun/X4CodeSense/commit/3e84bc247f65aa36f111a8b564bc708817b14c7e))
* check the arguments of formats ([da8e8b1](https://github.com/chemodun/X4CodeSense/commit/da8e8b1ba50b902142ca205908bc87cf44eaa99e))
* quick fixes for tags and children ([89eeeda](https://github.com/chemodun/X4CodeSense/commit/89eeedab41e917f7538d5e6b1e6be72229a9c6b9))
* quick fixes that create what nothing defines ([ae8a7d1](https://github.com/chemodun/X4CodeSense/commit/ae8a7d1c7647764cc88687cbff360b29cb0b8387))
* signature help for the arguments of a format ([f2bb4fb](https://github.com/chemodun/X4CodeSense/commit/f2bb4fb8ca76a08a1683682e23ab16919f7688ac))
* text references completed in any XML file ([81cd880](https://github.com/chemodun/X4CodeSense/commit/81cd880760b8b65d6f03c2f4a92aac2686651e7a))


### Bug Fixes

* a value whose text ends in name= is no longer taken for unclosed ([046a679](https://github.com/chemodun/X4CodeSense/commit/046a679815179e39d88f4c7f328f3373a6f592cd))

## [0.6.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-core@v0.5.0...x4-script-core@v0.6.0) (2026-10-01)


### Features

* the workspace's problems, fix all, and unknown script names ([d61d1f4](https://github.com/chemodun/X4CodeSense/commit/d61d1f494e7f5ca6626991d35d6bdc91bb74148a))

## [0.5.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-core@v0.4.1...x4-script-core@v0.5.0) (2026-10-01)


### Features

* AI script names and order ids in calls ([14f3af5](https://github.com/chemodun/X4CodeSense/commit/14f3af585fe529c584e7d3202581b81bbd0caf14))
* Go to Symbol in Workspace ([8b66c33](https://github.com/chemodun/X4CodeSense/commit/8b66c33e14a89ecbe049c7738b5db61b0f3db1b1))
* the parameters of calls, and param-unknown ([190388a](https://github.com/chemodun/X4CodeSense/commit/190388a9486fce2681443ae93db40e4a9aaeeb34))

## [0.4.1](https://github.com/chemodun/X4CodeSense/compare/x4-script-core@v0.4.0...x4-script-core@v0.4.1) (2026-10-01)


### Performance Improvements

* resolve each chain once, and allocate less per expression ([cc78372](https://github.com/chemodun/X4CodeSense/commit/cc783720f5726147ed47c8c1fc43f86ffd970fb7))

## [0.4.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-core@v0.3.0...x4-script-core@v0.4.0) (2026-10-01)


### Features

* the script's features in both sides of a patch's diff ([cf89d4b](https://github.com/chemodun/X4CodeSense/commit/cf89d4bd8a16afdc63291ef348db369887970361))

## [0.3.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-core@v0.2.1...x4-script-core@v0.3.0) (2026-09-30)


### Features

* edit a patch above the file it changes, both ways ([5d5d260](https://github.com/chemodun/X4CodeSense/commit/5d5d260c917c03b3fe771e94890249609e348ba8))

## [0.2.1](https://github.com/chemodun/X4CodeSense/compare/x4-script-core@v0.2.0...x4-script-core@v0.2.1) (2026-09-30)


### Bug Fixes

* hover and completion of properties whose name goes on ([3a9c0bd](https://github.com/chemodun/X4CodeSense/commit/3a9c0bddea8771df9112d2f538955161869b5adf))

## [0.2.0](https://github.com/chemodun/X4CodeSense/compare/x4-script-core@v0.1.1...x4-script-core@v0.2.0) (2026-09-30)


### Features

* semantic highlighting of script expressions ([9869769](https://github.com/chemodun/X4CodeSense/commit/986976988bcbcfaf10298719a0e7674fc217555f))
* show the text of ReadText calls in Lua files ([8f1baf1](https://github.com/chemodun/X4CodeSense/commit/8f1baf14918ca947bdb3c917f6a02e1bec1693d2))

## [0.1.1](https://github.com/chemodun/X4CodeSense/compare/x4-script-core@v0.1.0...x4-script-core@v0.1.1) (2026-09-29)


### Documentation

* **readme:** drop the first-publication instructions ([3cd1368](https://github.com/chemodun/X4CodeSense/commit/3cd1368860974ecf5f25cf5725fbebd1c237de95))

## 0.1.0 (2026-09-29)


### Features

* apply patch documents to the files they change ([d79442e](https://github.com/chemodun/X4CodeSense/commit/d79442eed4861d93e0f543df6acaf25a07343582))
* check what a patch brings in where it lands ([9ced0ec](https://github.com/chemodun/X4CodeSense/commit/9ced0ece4f7801ab337666fcf924378a888c8d23))
* **core:** check property chains against scriptproperties.xml ([2afe69e](https://github.com/chemodun/X4CodeSense/commit/2afe69eebf7031be2155ba63c700d2f34e3ae493))
* **core:** completion, hover and definition from schemas and scriptproperties.xml ([b889e0e](https://github.com/chemodun/X4CodeSense/commit/b889e0eda0bb82eb21a09c20088c2233c01e3e21))
* **core:** expression parser with syntax diagnostics ([b5e0353](https://github.com/chemodun/X4CodeSense/commit/b5e0353f7a8fe054a76a4eba7ebb78834846ae44))
* **core:** labels, cues and interrupt library items in one script ([e1722d2](https://github.com/chemodun/X4CodeSense/commit/e1722d213d9d1949b83621b417eca74a691ced80))
* **core:** tolerant XML structure scanner with well-formedness diagnostics ([d889b68](https://github.com/chemodun/X4CodeSense/commit/d889b68122a598c80b08fe6f9426a45e69047987))
* **core:** validate scripts against the game XSD schemas with an own schema engine ([5926e00](https://github.com/chemodun/X4CodeSense/commit/5926e006a0ab4b822110d60dac2620c1089ca916))
* **core:** variables with cue namespaces, references and rename ([d1da9c9](https://github.com/chemodun/X4CodeSense/commit/d1da9c9ce9c389b970e143d6a48e3eb8fbbca9b6))
* editor features in patch documents ([87a62a9](https://github.com/chemodun/X4CodeSense/commit/87a62a96e9063bbf2021d2ce15d6c7a0c22da433))
* extension load order, text patches and a workspace-relative extensions folder ([e4e2556](https://github.com/chemodun/X4CodeSense/commit/e4e25561e89943fcc4439f637f4a09849cafd608))
* find references and rename across scripts ([79ae3e5](https://github.com/chemodun/X4CodeSense/commit/79ae3e57f47a8983469ef1aabb65794c09fd9036))
* outline of scripts and patches ([e35306c](https://github.com/chemodun/X4CodeSense/commit/e35306c3110d49bdedc6dbdfbb15b32c86c0d2df))
* quick fixes for the diagnostics with an obvious fix ([4826432](https://github.com/chemodun/X4CodeSense/commit/48264322b4ae3d4188e86711317e4f7e9ccd21bd))
* report variables that are read but never set ([4103f04](https://github.com/chemodun/X4CodeSense/commit/4103f04dee32e7f3e2fc831f9355d97b762003b3))
* scaffold X4CodeSense workspace ([cd53c28](https://github.com/chemodun/X4CodeSense/commit/cd53c284d3690db00b33aa4ce7e5299348723f03))
* script index across the game, its DLCs and the extensions ([6c959d8](https://github.com/chemodun/X4CodeSense/commit/6c959d8f0784303736a5a45791e31042f294bf48))
* status bar, commands and patch comparison in the client ([ce349c3](https://github.com/chemodun/X4CodeSense/commit/ce349c3490b10680aee53203a6f4f069b2bf8dc7))
* text lookups for {page, id} references ([8463b72](https://github.com/chemodun/X4CodeSense/commit/8463b72643ac789ef170494665d4ca1eda3d17b3))
* variables across scripts ([415e62f](https://github.com/chemodun/X4CodeSense/commit/415e62fe22b4c29d9191e228658b74a965268927))
