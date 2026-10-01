import type { ExpressionDiagnosticCode, FormatDiagnosticCode } from '../expressions/validateExpressions';
import type { NameDiagnosticCode } from '../names/validateNames';
import type { PatchDiagnosticCode } from '../patches/validatePatch';
import type { CallParameterDiagnosticCode } from '../project/validateCallParameters';
import type { ScriptNameDiagnosticCode } from '../project/validateScriptNames';
import type { TextDiagnosticCode } from '../texts/validateTexts';
import type { VariableDiagnosticCode } from '../variables/validateVariables';
import type { XmlProblemCode } from '../xml/xmlStructure';
import type { StructureDiagnosticCode } from '../xsd/validateStructure';

/** Every code a diagnostic of `analyzeDocument` carries. */
export type DiagnosticCode =
  | XmlProblemCode
  | StructureDiagnosticCode
  | ExpressionDiagnosticCode
  | FormatDiagnosticCode
  | NameDiagnosticCode
  | VariableDiagnosticCode
  | TextDiagnosticCode
  | PatchDiagnosticCode
  | CallParameterDiagnosticCode
  | ScriptNameDiagnosticCode;

/** What each code reports, in a sentence, for tools that list the checks (the rules of SARIF). */
export const diagnosticDescriptions: Readonly<Record<DiagnosticCode, string>> = {
  'unclosed-start-tag': "A start tag has no closing '>'.",
  'unclosed-end-tag': "An end tag has no closing '>'.",
  'unclosed-attribute': 'An attribute value has no closing quote.',
  'missing-attribute-value': 'An attribute has no value.',
  'unquoted-attribute-value': 'An attribute value is not in quotes.',
  'duplicate-attribute': 'An attribute appears more than once in an element.',
  'unexpected-character': 'A character that does not belong in a start tag.',
  'missing-end-tag': 'An element has no end tag.',
  'unexpected-end-tag': 'An end tag has no matching start tag.',
  'unclosed-comment': "A comment is not closed with '-->'.",
  'unclosed-cdata': "A CDATA section is not closed with ']]>'.",
  'unclosed-processing-instruction': "A processing instruction is not closed with '?>'.",
  'unclosed-declaration': "A declaration is not closed with '>'.",
  'unknown-root-element': "The root element is not the one the game's schema expects, or a second root follows it.",
  'unknown-element': "An element the game's schema does not allow in its parent at all.",
  'invalid-child-element': "A child element the game's schema does not allow at that place in its parent.",
  'missing-child-element': "An element lacks a child element the game's schema requires.",
  'unknown-attribute': "An attribute the game's schema does not declare for its element.",
  'missing-required-attribute': "An element lacks an attribute the game's schema requires.",
  'invalid-attribute-value': "A value the game's schema does not allow for its attribute.",
  'expression-syntax': 'An expression that does not parse.',
  'expression-null-safe-exists': "An expression that combines '@' and '?'.",
  'expression-text-reference': 'A text reference that is not {page, id} with two numbers.',
  'expression-format-specifier': "A format specifier the game does not know, such as '%d'.",
  'expression-unknown-keyword': 'An expression that starts with a name that is no keyword the game knows.',
  'expression-unknown-property': "A property its owner does not have, by the game's script properties.",
  'format-arguments-missing': 'A format given fewer arguments than its placeholders take.',
  'format-arguments-unused': 'Arguments of a format that no placeholder takes, so they are not shown.',
  'label-undefined': 'A label the AI script does not define.',
  'name-duplicate': 'A cue, library, label or interrupt library item defined twice where its name must be unique.',
  'cue-undefined': 'A cue or library that no known script defines.',
  'library-undefined': 'Interrupt actions, conditions or a handler that no known AI script defines.',
  'variable-undefined': 'A variable that is read but never set where it is visible.',
  'text-undefined': 'A text reference {page, id} that the game texts and the extension texts do not define.',
  'patch-path-syntax': 'A patch path that does not parse.',
  'patch-path-unsupported': 'A patch path with XPath beyond what is evaluated, so it is not checked.',
  'patch-target-missing': 'A patch whose file is not among the game files or the extensions read.',
  'patch-no-match': 'A patch operation whose path selects nothing in the file it changes.',
  'patch-several-matches': 'A patch operation whose path selects more than one node.',
  'patch-invalid-operation': 'A patch operation the game skips.',
  'library-root-mismatch': "A file in an extension's libraries whose root is neither 'diff' nor the root of the game's file of its name, so the game skips it.",
  'param-unknown': 'A parameter a call passes that the script, library or cue it calls does not declare.',
  'aiscript-undefined': 'An AI script a call names that no known script defines.',
  'order-undefined': 'An order a call names that no known AI script defines.',
};
