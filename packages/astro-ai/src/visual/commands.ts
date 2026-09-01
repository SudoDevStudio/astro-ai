export type EditLiteralTextCommand = {
  kind: 'edit-literal-text';
  nodeId: string;
  text: string;
};

export type ReorderSiblingCommand = {
  kind: 'reorder-sibling';
  nodeId: string;
  direction: 'previous' | 'next';
};

export type SetLiteralPropCommand = {
  kind: 'set-literal-prop';
  nodeId: string;
  prop: string;
  value: string | number | boolean;
};

export type DeterministicVisualCommand =
  | EditLiteralTextCommand
  | ReorderSiblingCommand
  | SetLiteralPropCommand;
