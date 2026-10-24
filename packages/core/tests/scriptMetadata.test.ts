import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectDocument, getMetadata, librarySchemaFromLocation, schemaFromLocation } from '../src';

function fixture(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${relativePath}`, import.meta.url)), 'utf8');
}

describe('getMetadata', () => {
  it('detects an AI script with its name and schema location', () => {
    const metadata = getMetadata(fixture('aiscripts/order.sample.xml'));
    expect(metadata).toEqual({
      schema: 'aiscripts',
      rootElement: 'aiscript',
      name: 'order.sample',
      schemaLocation: 'aiscripts.xsd',
    });
  });

  it('detects a Mission Director script', () => {
    const metadata = getMetadata(fixture('md/Sample.xml'));
    expect(metadata).toEqual({
      schema: 'md',
      rootElement: 'mdscript',
      name: 'Sample',
      schemaLocation: 'md.xsd',
    });
  });

  it('returns undefined for XML that is not a script', () => {
    expect(getMetadata(fixture('other/patch.xml'))).toBeUndefined();
    expect(getMetadata('<language><page id="1"/></language>')).toBeUndefined();
    expect(getMetadata('')).toBeUndefined();
    expect(getMetadata('not xml at all')).toBeUndefined();
  });

  it('tolerates a BOM, comments and a processing instruction before the root', () => {
    const text = '\uFEFF<?xml version="1.0"?>\n<!-- comment with <mdscript> inside -->\n<?pi something?>\n<aiscript name="lib.x">';
    expect(getMetadata(text)?.schema).toBe('aiscripts');
    expect(getMetadata(text)?.name).toBe('lib.x');
  });

  it('lets the root element win over a mismatching schema location', () => {
    const metadata = getMetadata('<mdscript name="Odd" xsi:noNamespaceSchemaLocation="aiscripts.xsd">');
    expect(metadata?.schema).toBe('md');
    expect(metadata?.schemaLocation).toBe('aiscripts.xsd');
  });

  it('works on an unfinished start tag while the user is still typing', () => {
    expect(getMetadata('<mdscript name="Typing')).toBeUndefined();
    expect(getMetadata('<mdscript name="Typing"')).toBeUndefined();
    expect(getMetadata('<mdscript name="Typing">')?.name).toBe('Typing');
  });

  it('keeps a file what it is when its root start tag loses its > before the rest', () => {
    expect(getMetadata('<mdscript name="Lost"\n  <cues/>\n</mdscript>\n')).toEqual({ schema: 'md', rootElement: 'mdscript', name: 'Lost' });
    expect(getMetadata('<aiscript name="lost"\n  <attention min="unknown"/>\n</aiscript>')?.name).toBe('lost');
  });

  it('reports an empty name when the attribute is missing', () => {
    expect(getMetadata('<aiscript>')).toEqual({ schema: 'aiscripts', rootElement: 'aiscript', name: '' });
  });
});

describe('detectDocument', () => {
  it('classifies a patch document', () => {
    expect(detectDocument(fixture('other/patch.xml'))).toEqual({ rootElement: 'diff', isDiff: true });
  });

  it('classifies a script document', () => {
    const detection = detectDocument(fixture('md/Sample.xml'));
    expect(detection.isDiff).toBe(false);
    expect(detection.rootElement).toBe('mdscript');
    expect(detection.script?.name).toBe('Sample');
  });

  it('reports the root element of other XML and nothing for non-XML', () => {
    expect(detectDocument('<language><page id="1"/></language>')).toEqual({ rootElement: 'language', isDiff: false });
    expect(detectDocument('plain text')).toEqual({ isDiff: false });
  });

  it('classifies a library file by the schema its root names, not by its root or file name', () => {
    const jobs =
      '<?xml version="1.0"?>\n<!-- jobs -->\n<jobs xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="libraries.xsd">';
    expect(detectDocument(jobs)).toEqual({
      rootElement: 'jobs',
      isDiff: false,
      library: { schema: 'libraries', schemaLocation: 'libraries.xsd' },
    });
    expect(detectDocument('<effects xsi:noNamespaceSchemaLocation="..\\..\\..\\libraries\\Effects.XSD">').library?.schema).toBe('effects');
    expect(detectDocument('<cutscene xsi:noNamespaceSchemaLocation="cutscenes.xsd">').library?.schema).toBe('cutscenes');
    // No location on the root: none, whatever the root (`<characters>` of charactergroups.xml is not libraries.xsd's).
    expect(detectDocument('<characters>').library).toBeUndefined();
    expect(detectDocument('<!-- xsi:noNamespaceSchemaLocation="component.xsd" -->\n<components>').library).toBeUndefined();
  });

  it('leaves the scripts, the patches and the excluded schemas no library files', () => {
    expect(detectDocument('<mdscript name="S" xsi:noNamespaceSchemaLocation="libraries.xsd">').library).toBeUndefined();
    expect(detectDocument('<diff xsi:noNamespaceSchemaLocation="diff.xsd">').library).toBeUndefined();
    for (const name of ['md', 'aiscripts', 'common', 'diff', 'scriptproperties', 'SCRIPTPROPERTIES']) {
      expect(detectDocument(`<scriptproperties xsi:noNamespaceSchemaLocation="${name}.xsd">`).library).toBeUndefined();
    }
    expect(detectDocument('<x xsi:noNamespaceSchemaLocation="">').library).toBeUndefined();
    expect(detectDocument('<x xsi:noNamespaceSchemaLocation="libraries">').library).toBeUndefined();
  });
});

describe('librarySchemaFromLocation', () => {
  it('takes the file name without folders and extension, lowercased', () => {
    expect(librarySchemaFromLocation('libraries.xsd')).toBe('libraries');
    expect(librarySchemaFromLocation(' ../../../libraries/region_definitions.xsd ')).toBe('region_definitions');
    expect(librarySchemaFromLocation('C:\\X4\\libraries\\Material_Library.xsd')).toBe('material_library');
  });

  it('returns undefined for the scripts, the patches, the excluded and what is no schema file', () => {
    expect(librarySchemaFromLocation('md.xsd')).toBeUndefined();
    expect(librarySchemaFromLocation('../libraries/common.xsd')).toBeUndefined();
    expect(librarySchemaFromLocation('scriptproperties.xsd')).toBeUndefined();
    expect(librarySchemaFromLocation('jobs.xml')).toBeUndefined();
    expect(librarySchemaFromLocation('my schema.xsd')).toBeUndefined();
    expect(librarySchemaFromLocation('.xsd')).toBeUndefined();
  });
});

describe('schemaFromLocation', () => {
  it('extracts the schema from relative and absolute paths', () => {
    expect(schemaFromLocation('md.xsd')).toBe('md');
    expect(schemaFromLocation('../libraries/aiscripts.xsd')).toBe('aiscripts');
    expect(schemaFromLocation('C:\\X4\\libraries\\MD.XSD')).toBe('md');
  });

  it('returns undefined for unknown schemas', () => {
    expect(schemaFromLocation('common.xsd')).toBeUndefined();
    expect(schemaFromLocation('')).toBeUndefined();
  });
});
