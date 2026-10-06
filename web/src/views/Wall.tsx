import { X } from 'lucide-react';
import { useEffect } from 'react';
import { useLocation } from 'wouter';
import { Button } from '../design/components/Button';
import { Skeleton } from '../design/components/Skeleton';
import { useCluster } from '../store/cluster';
import './views.css';

/** Full-screen wall display: no chrome, large type. Escape returns to the overview. */
export default function Wall() {
  const [, navigate] = useLocation();
  const nodes = useCluster((s) => s.order);
  const tiles = nodes.length ? nodes : ['a', 'b'];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) navigate('/');
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [navigate]);

  return (
    <main className="wall" id="main" aria-busy="true">
      <h1 className="visually-hidden">Wall mode</h1>
      <Button className="wall__exit" variant="ghost" size="sm" icon={<X />} onClick={() => { navigate('/'); }}>
        Exit wall mode
      </Button>
      <div className="wall__grid">
        {tiles.map((id) => (
          <section key={id} className="wall__tile material-regular" aria-label={`Node ${id}`}>
            <Skeleton width={180} height={34} radius={10} />
            <Skeleton width={120} height={28} radius={14} />
            <div className="wall__stats">
              <Skeleton width={160} height={72} radius={14} />
              <Skeleton width={160} height={72} radius={14} />
              <Skeleton width={160} height={72} radius={14} />
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
