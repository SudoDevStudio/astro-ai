import { useState } from 'preact/hooks';

const features = ['Select', 'Edit', 'Reorder'];

export default function Card() {
  const [count, setCount] = useState(0);

  return (
    <section class="card">
      <h2>This heading is Preact JSX</h2>
      <p>Preact uses class where React uses className; both are indexed.</p>
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
