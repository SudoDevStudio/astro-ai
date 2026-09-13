import { useState } from 'react';

const features = ['Select', 'Edit', 'Reorder'];

export default function Card() {
  const [count, setCount] = useState(0);

  return (
    <section className="card">
      <h2>This heading is React JSX</h2>
      <p>Literal text and props here are editable from the toolbar.</p>
      <ul>
        {features.map((feature) => (
          <li key={feature}>{feature}</li>
        ))}
      </ul>
      <button type="button" onClick={() => setCount(count + 1)}>
        Clicked {count} times
      </button>
    </section>
  );
}
