import type { ContentOrigin } from './content-sources.js';

export type SourcePosition = {
  line: number;
  column: number;
  offset: number;
};

export type SourceLocation = {
  file: string;
  start: SourcePosition;
  end: SourcePosition;
};

export type SourceKind =
  | 'literal-source'
  | 'local-variable'
  | 'prop'
  | 'external'
  | 'repeated-template'
  | 'generated-unknown'
  | 'component'
  | 'hydrated-island';

export type DataProvenance = {
  kind: 'literal' | 'local' | 'prop' | 'import' | 'external' | 'unknown';
  description: string;
  symbol?: string;
  declaredAt?: SourceLocation;
  readOnly: boolean;
  sourceType?: 'api' | 'action' | 'content-collection' | 'graphql' | 'import';
  sourceFile?: string;
};

export type RepeatContext = {
  kind: 'map';
  description: string;
  source: SourceLocation;
  affectsAllInstances: true;
};

export type EditableProp = {
  name: string;
  type: 'string' | 'number' | 'boolean';
  value: string | number | boolean;
  allowedValues?: Array<string | number | boolean>;
  control?: 'text' | 'number' | 'boolean' | 'enum' | 'design-token';
};

export type VisualCapabilities = {
  editableText: boolean;
  movable: boolean;
  reorderable: boolean;
  removable: boolean;
  editableProps: EditableProp[];
  allowedParentSlots: string[];
  sourceKind: SourceKind;
  dataProvenance: DataProvenance;
  repeatContext?: RepeatContext;
  reorderTargets: {
    previous?: string;
    next?: string;
  };
};

export type SelectedSourceNode = {
  nodeId: string;
  tagName?: string;
  componentName?: string;
  literalText?: string;
  source: SourceLocation;
};

export type SelectionContext = {
  route: string;
  selectedNode: SelectedSourceNode;
  parentComponents: Array<{
    name: string;
    source?: SourceLocation;
  }>;
  capabilities: VisualCapabilities;
  /**
   * CMS entries this element belongs to, resolved from configured content
   * source attributes on the element or its nearest ancestor. Empty when no
   * content source is configured or none of their attributes are present.
   */
  contentOrigins: ContentOrigin[];
  relevantFiles: string[];
  skillFiles: string[];
};

export type SourceInsertionZone = {
  id: string;
  file: string;
  offset: number;
  parentNodeId?: string;
  slot?: string;
  acceptedChildTypes: string[];
};
