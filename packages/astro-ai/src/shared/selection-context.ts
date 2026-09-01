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
};
