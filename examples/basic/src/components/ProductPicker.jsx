import { useState } from 'react';

/**
 * The island that exercises everything at once: literal JSX text, props the
 * action bar can edit because they are registered in `astro.config.mjs`, a
 * `.map()` whose rows share one source node, content source attributes read
 * from the row you actually clicked, and real interactive state.
 *
 * Selecting inside here resolves to this file, not to the page that renders it.
 */

// Stands in for a catalog response. The ids are what `contentSources` reads.
const products = [
  { id: 'entry-a17c', sku: 'SKU-1001', name: 'Torque wrench', price: 189, note: 'Calibrated to 200 Nm.' },
  { id: 'entry-c23f', sku: 'SKU-1002', name: 'Cable spool', price: 340, note: 'Shielded, 100 m.' },
  { id: 'entry-d95b', sku: 'SKU-1003', name: 'Safety harness', price: 215, note: 'Full body, size L.' },
];

export default function ProductPicker({ heading, cta, tone = 'neutral' }) {
  const [picked, setPicked] = useState(() => new Set(['entry-a17c']));

  const toggle = (id) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const total = products
    .filter(({ id }) => picked.has(id))
    .reduce((sum, { price }) => sum + price, 0);

  return (
    <section className={`picker ${tone}`}>
      <h2>{heading}</h2>
      <p className="intro">
        This paragraph is literal text inside a React island. Editing it rewrites
        the JSX, not the Astro page.
      </p>

      <ul className="rows">
        {products.map((product) => (
          <li
            key={product.id}
            className={picked.has(product.id) ? 'row picked' : 'row'}
            data-entry-id={product.id}
            data-sku={product.sku}
          >
            <label>
              <input
                type="checkbox"
                checked={picked.has(product.id)}
                onChange={() => toggle(product.id)}
              />
              <span className="name">{product.name}</span>
            </label>
            <p className="note">{product.note}</p>
            <span className="price">${product.price}</span>
          </li>
        ))}
      </ul>

      <footer className="summary">
        <span className="total">Total ${total}</span>
        <button type="button" onClick={() => setPicked(new Set())}>
          {cta}
        </button>
      </footer>
    </section>
  );
}
