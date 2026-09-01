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

export type RemoveSourceNodeCommand = { kind: 'remove-source-node'; nodeId: string };
export type MoveToSlotCommand = { kind: 'move-to-slot'; nodeId: string; targetNodeId: string; slot: string };
export type InsertLiteralElementCommand = {
  kind: 'insert-literal-element';
  file: string;
  parentNodeId?: string;
  slot?: string;
  tag: string;
  text: string;
};

export type DeterministicVisualCommand =
  | EditLiteralTextCommand
  | ReorderSiblingCommand
  | SetLiteralPropCommand
  | RemoveSourceNodeCommand
  | MoveToSlotCommand
  | InsertLiteralElementCommand;
