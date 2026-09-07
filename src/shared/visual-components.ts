export type VisualPropDefinition = {
  control: 'text' | 'number' | 'boolean' | 'enum' | 'design-token';
  values?: Array<string | number | boolean>;
};

export type VisualSlotDefinition = {
  name: string;
  accepts?: string[];
};

export type VisualComponentDefinition = {
  name: string;
  props?: Record<string, VisualPropDefinition>;
  slots?: VisualSlotDefinition[];
  layout?: 'flow' | 'flex' | 'grid' | 'freeform';
};
