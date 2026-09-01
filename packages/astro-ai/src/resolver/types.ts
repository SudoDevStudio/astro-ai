import type {
  DataProvenance,
  EditableProp,
  RepeatContext,
  SourceKind,
  SourceLocation,
} from '../shared/selection-context.js';

export type SourceRange = {
  start: number;
  end: number;
};

export type SourceProp = EditableProp & {
  range: SourceRange;
  syntax: 'quoted' | 'expression' | 'shorthand';
};

export type SourceNodeRecord = {
  nodeId: string;
  filePath: string;
  sourceLanguage: 'astro' | 'jsx' | 'tsx';
  sourceHash: string;
  source: SourceLocation;
  range: SourceRange;
  openingRange: SourceRange;
  textRange?: SourceRange;
  textValue?: string;
  tagName?: string;
  componentName?: string;
  parentNodeId?: string;
  siblingGroupId?: string;
  previousSiblingId?: string;
  nextSiblingId?: string;
  parentComponents: Array<{
    name: string;
    source?: SourceLocation;
  }>;
  literalProps: SourceProp[];
  sourceKind: SourceKind;
  dataProvenance: DataProvenance;
  repeatContext?: RepeatContext;
  hydratedIsland: boolean;
  instrumentable: boolean;
};
