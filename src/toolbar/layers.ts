/**
 * The editor's stacking order, in one place.
 *
 * These sit at the top of the z-index range so they clear application UI; what
 * matters is their order relative to each other. Chat windows own a band so the
 * focused window can rise above its siblings while every window still stays
 * above the selection overlays that point at the page. The share preview sheet
 * is modal, so it takes the top slot outright — it covers the action bar too.
 */
export const EDITOR_LAYERS = {
  sheet: 2147483647,
  actionBar: 2147483646,
  chatWindowTop: 2147483645,
  chatWindowBase: 2147483639,
  insertionControl: 2147483637,
  marquee: 2147483637,
  selectionOutline: 2147483636,
  hoverOutline: 2147483635,
  selectionConnector: 2147483634,
} as const;

/** How many chat windows can be stacked with a distinct z-index. */
export const MAX_STACKED_CHAT_WINDOWS =
  EDITOR_LAYERS.chatWindowTop - EDITOR_LAYERS.chatWindowBase + 1;

/**
 * Places a chat window in its band. The focused window always takes the top
 * slot; the rest keep their relative order below it.
 */
export function chatWindowLayer(focused: boolean, rank: number): number {
  if (focused) return EDITOR_LAYERS.chatWindowTop;
  const offset = Math.min(Math.max(rank, 0), MAX_STACKED_CHAT_WINDOWS - 2);
  return EDITOR_LAYERS.chatWindowBase + offset;
}
