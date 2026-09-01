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
    const nodeType = node.componentName ?? node.tagName ?? '*';
    const allowedParentSlots = [...this.#components.values()].flatMap((component) =>
      (component.slots ?? []).flatMap((slot) =>
        slot.accepts === undefined || slot.accepts.includes('*') || slot.accepts.includes(nodeType)
          ? [`${component.name}:${slot.name}`]
          : []
      )
    );

    return {
      editableText:
        node.textRange !== undefined &&
        (node.sourceKind === 'literal-source' || node.sourceKind === 'repeated-template') &&
        !node.hydratedIsland,
      movable: (reorderable || allowedParentSlots.length > 0) && !node.hydratedIsland,
      reorderable: reorderable && !node.hydratedIsland,
      removable: node.instrumentable && !node.hydratedIsland,
      editableProps: node.hydratedIsland ? [] : this.#editableProps(node),
      allowedParentSlots,
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
          ...(propDefinition === undefined ? {} : { control: propDefinition.control }),
        },
      ];
    });
  }

  acceptsSlot(parentComponent: string, slotName: string, childType: string): boolean {
    const slot = this.#components.get(parentComponent)?.slots?.find(({ name }) => name === slotName);
    return slot !== undefined && (slot.accepts === undefined || slot.accepts.includes('*') || slot.accepts.includes(childType));
  }

  slotsFor(component: string): NonNullable<VisualComponentDefinition['slots']> {
    return this.#components.get(component)?.slots ?? [];
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
