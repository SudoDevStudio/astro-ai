/**
 * Stands in for a commerce API.
 *
 * `_type` and `id` are what dom-stamp reads, so every record carries them.
 * The nested variants carry their own, which is the interesting case: an
 * element inside a variant must resolve to that variant, not to the product
 * that wraps it.
 */

export type Variant = {
  _type: 'variant';
  id: string;
  label: string;
  sku: string;
};

export type Product = {
  _type: 'product';
  id: string;
  sku: string;
  title: string;
  description: string;
  price: string;
  variants: Variant[];
};

export function catalogue(): Product[] {
  return [
    {
      _type: 'product',
      id: 'p0',
      sku: 'SKU-1000',
      title: 'Rugged Runner',
      description: 'A trail shoe that survives the winter commute.',
      price: '$148.00',
      variants: [
        { _type: 'variant', id: 'p0v0', label: 'Bone / 39', sku: 'SKU-1000-39' },
        { _type: 'variant', id: 'p0v1', label: 'Bone / 41', sku: 'SKU-1000-41' },
      ],
    },
    {
      _type: 'product',
      id: 'p1',
      sku: 'SKU-1001',
      title: 'Harbour Jacket',
      description: 'Waxed cotton, cut long, with pockets that hold a notebook.',
      price: '$320.00',
      variants: [
        { _type: 'variant', id: 'p1v0', label: 'Slate / M', sku: 'SKU-1001-M' },
        { _type: 'variant', id: 'p1v1', label: 'Slate / L', sku: 'SKU-1001-L' },
      ],
    },
  ];
}
