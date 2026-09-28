/**
 * Keywords the game evaluates but `scriptproperties.xml` does not list. Every value comes from the game's
 * own data files through the same `import` mechanism as the main file, so nothing here is hand written
 * except the keyword names and the datatypes that group their values.
 *
 * Ported from X4CodeComplete, where these lookups were injected into scriptproperties.xml before parsing.
 */
export const scriptPropertiesAdditions = `<?xml version="1.0" encoding="utf-8"?>
<scriptproperties>
  <!-- Relation range lookup -->
  <datatype name="relationrange" type="enum" />
  <keyword name="relationrange" description="Relation range lookup">
    <import source="factions.xsd" select="/xs:schema/xs:simpleType[@name='relationrangelookup']//xs:enumeration">
      <property name="@value" result="xs:annotation/xs:documentation/text()" type="relationrange" />
    </import>
  </keyword>

  <!-- Licence type lookup -->
  <datatype name="licencetype" type="enum" />
  <keyword name="licencetype" description="Licence type lookup">
    <import source="common.xsd" select="/xs:schema/xs:simpleType[@name='licencelookup']//xs:enumeration">
      <property name="@value" result="xs:annotation/xs:documentation/text()" type="licencetype" />
    </import>
  </keyword>

  <!-- Component state lookup -->
  <keyword name="state" description="Component state lookup">
    <property name="all" result="all possible component states" type="componentstate" />
    <import source="common.xsd" select="/xs:schema/xs:simpleType[@name='componentstatelookup']//xs:enumeration">
      <property name="@value" result="xs:annotation/xs:documentation/text()" type="componentstate" />
    </import>
  </keyword>

  <!-- Defensible alert level lookup -->
  <datatype name="defensiblealertlevel" type="enum" />
  <keyword name="defensiblealertlevel" description="Defensible alert level lookup">
    <import source="common.xsd" select="/xs:schema/xs:simpleType[@name='alertlevellookup']//xs:enumeration">
      <property name="@value" result="xs:annotation/xs:documentation/text()" type="defensiblealertlevel" />
    </import>
  </keyword>

  <!-- Traffic levels -->
  <datatype name="trafficlevel" type="enum" />
  <keyword name="trafficlevel" description="Traffic level lookup">
    <import source="parameters.xsd" select="/xs:schema//xs:element[@name='landing']//xs:attribute[@name='traffic']//xs:enumeration">
      <property name="@value" result="xs:annotation/xs:documentation/text()" type="trafficlevel" />
    </import>
  </keyword>

  <!-- Mood type lookup -->
  <datatype name="moodtype" type="enum" />
  <keyword name="moodtype" description="Mood type lookup">
    <import source="common.xsd" select="/xs:schema/xs:simpleType[@name='moodtypelookup']//xs:enumeration">
      <property name="@value" result="xs:annotation/xs:documentation/text()" type="moodtype" />
    </import>
  </keyword>

  <!-- Info library type lookup -->
  <datatype name="infolibrarytype" type="enum" />
  <keyword name="infolibrarytype" description="Info library type lookup">
    <import source="common.xsd" select="/xs:schema/xs:simpleType[@name='infolibrarytypelookup']//xs:enumeration">
      <property name="@value" result="xs:annotation/xs:documentation/text()" type="infolibrarytype" />
    </import>
  </keyword>

  <!-- Production method lookup -->
  <datatype name="productionmethod" type="enum" />
  <keyword name="productionmethod" description="Production method lookup">
    <import source="common.xsd" select="/xs:schema/xs:simpleType[@name='buildmethodlookup']//xs:enumeration">
      <property name="@value" result="xs:annotation/xs:documentation/text()" type="productionmethod" />
    </import>
  </keyword>

  <!-- Debug filter -->
  <datatype name="debugfilter" type="enum" />
  <keyword name="debugfilter" description="Debug filter lookup">
    <import source="common.xsd" select="/xs:schema/xs:group[@name='commonactions']//xs:element[@name='debug_text']//xs:attribute[@name='filter']//xs:enumeration">
      <property name="@value" result="xs:annotation/xs:documentation/text()" type="debugfilter" />
    </import>
  </keyword>

  <!-- Input function lookup -->
  <datatype name="inputfunction" type="enum" />
  <keyword name="inputfunction" description="Input function lookup">
    <import source="inputmap.xml" select="/inputmap/action[not(@removed)]">
      <property name="@id" type="inputfunction" />
    </import>
  </keyword>

  <!-- Keywords and values the game evaluates but scriptproperties.xml does not list (used by vanilla scripts) -->
  <keyword name="component" description="Component lookup by ID">
    <property name="{$id}" result="The component with the given ID" type="component" />
  </keyword>
  <keyword name="datatype" description="Datatype lookup">
    <property name="macroslot" result="Macro slot" type="datatype" />
  </keyword>
  <datatype name="chairtype" type="enum" />
  <keyword name="chairtype" description="Chair type lookup">
    <property name="&lt;chairtypename&gt;" result="The chair type with the given name (navigation, comms, pilot, manager, ...)" type="chairtype" />
  </keyword>
</scriptproperties>
`;
