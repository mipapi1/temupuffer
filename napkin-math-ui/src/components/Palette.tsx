import { useEffect, useMemo, useRef, useState } from 'react';

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  meta?: string;
  keywords?: string;
}

/** Raycast-style picker: type to filter, ↑/↓ to move, Enter to pick, Esc to close. */
export function Palette({ items, onPick, onClose, placeholder }: { items: PaletteItem[]; onPick: (id: string) => void; onClose: () => void; placeholder: string }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return items;
    return items.filter((i) => {
      const hay = `${i.label} ${i.group} ${i.keywords ?? ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [q, items]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  let lastGroup = '';
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label={placeholder}>
        <input
          autoFocus
          placeholder={placeholder}
          value={q}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(filtered.length - 1, s + 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            }
            if (e.key === 'Enter' && filtered[sel]) onPick(filtered[sel].id);
          }}
        />
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {filtered.length === 0 && <div className="palette-group">Nothing matches “{q}”. Try “ssd”, “network” or “compress”.</div>}
          {filtered.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="palette-group">{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {head}
                <button className="palette-item" data-i={i} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => onPick(it.id)}>
                  <span>{it.label}</span>
                  {it.meta && <span className="meta">{it.meta}</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span><span className="kbd">↑↓</span> move</span>
          <span><span className="kbd">↵</span> add</span>
          <span><span className="kbd">esc</span> close</span>
        </div>
      </div>
    </div>
  );
}
