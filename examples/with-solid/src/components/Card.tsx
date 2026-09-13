import { createSignal, For, Index } from 'solid-js';

const features = ['Select', 'Edit', 'Reorder'];

export default function Card() {
  const [count, setCount] = createSignal(0);

  return (
    <section class="card">
      <h2>This heading is Solid JSX</h2>
      <p>Solid renders lists with For and Index rather than .map().</p>
      <ul>
        <For each={features}>{(feature) => <li>{feature}</li>}</For>
      </ul>
      <ol>
        <Index each={features}>{(feature) => <li>{feature()}</li>}</Index>
      </ol>
      <button type="button" onClick={() => setCount(count() + 1)}>
        Clicked {count()} times
      </button>
    </section>
  );
}
