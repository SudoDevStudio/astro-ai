import type { VisualCapabilities } from '../shared/selection-context.js';
import type { VisualComponentDefinition } from '../shared/visual-components.js';
import type { SourceNodeRecord } from '../resolver/types.js';

export class VisualCapabilityResolver {
  readonly #components: Map<string, VisualComponentDefinition>;

  constructor(components: VisualComponentDefinition[] = []) {
    this.#components = new Map(components.map((component) => [component.name, component]));
  }

  resolve(node: SourceNodeRecord): VisualCapabilities {
    const previous = node.previousSiblingId;
    const next = node.nextSiblingId;
    const reorderable = previous !== undefined || next !== undefined;

    return {
      editableText:
        node.textRange !== undefined &&
        (node.sourceKind === 'literal-source' || node.sourceKind === 'repeated-template') &&
        !node.hydratedIsland,
      movable: reorderable && !node.hydratedIsland,
      reorderable: reorderable && !node.hydratedIsland,
      // Removal is intentionally withheld until slot/required-child rules exist.
      removable: false,
      editableProps: node.hydratedIsland ? [] : this.#editableProps(node),
      allowedParentSlots: [],
      sourceKind: node.sourceKind,
      dataProvenance: node.dataProvenance,
      ...(node.repeatContext === undefined
        ? {}
        : { repeatContext: node.repeatContext }),
      reorderTargets: {
        ...(previous === undefined ? {} : { previous }),
        ...(next === undefined ? {} : { next }),
      },
    };
  }

  #editableProps(node: SourceNodeRecord) {
    const definition = node.componentName === undefined
      ? undefined
      : this.#components.get(node.componentName);
    return node.literalProps.flatMap((prop) => {
      const propDefinition = definition?.props?.[prop.name];
      if (definition !== undefined && propDefinition === undefined) return [];
      return [
        {
          ...toEditableProp(prop),
          ...(propDefinition?.values === undefined
            ? {}
            : { allowedValues: propDefinition.values }),
        },
      ];
    });
  }
}

function toEditableProp({ name, type, value, allowedValues }: SourceNodeRecord['literalProps'][number]) {
  return {
    name,
    type,
    value,
    ...(allowedValues === undefined ? {} : { allowedValues }),
  };
}
