import { useEffect, useState } from 'react';
import { loadDatasets, type Datasets } from './cloud.ts';

export function useDatasets(enabled = true): Datasets | null {
  const [ds, setDs] = useState<Datasets | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadDatasets().then((d) => live && setDs(d));
    return () => {
      live = false;
    };
  }, [enabled]);
  return ds;
}
