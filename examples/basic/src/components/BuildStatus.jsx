import { useEffect, useState } from 'react';

/**
 * A second island on the same page, hydrated with `client:visible` rather than
 * `client:load`. Two islands with different directives is the case worth having
 * a fixture for: the editor instruments each island's source independently of
 * when React gets around to hydrating it.
 */
export default function BuildStatus({ label }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <aside className="status">
      <span className="dot" aria-hidden="true" />
      <strong>{label}</strong>
      <span className="elapsed">hydrated {seconds}s ago</span>
    </aside>
  );
}
