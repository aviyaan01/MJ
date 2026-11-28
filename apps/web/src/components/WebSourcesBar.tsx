import { ExternalLink, Globe } from 'lucide-react';
import type { WebSearchSourceDTO } from '@mj/shared';

interface WebSourcesBarProps {
  sources: WebSearchSourceDTO[];
}

/**
 * Renders verified web-search citation links returned by `web_search`.
 */
export function WebSourcesBar({ sources }: WebSourcesBarProps) {
  if (!sources || sources.length === 0) return null;

  return (
    <div
      className="mt-2 rounded-xl px-3.5 py-2.5 text-xs"
      style={{
        backgroundColor: 'rgba(13, 18, 28, 0.78)',
        border: '1px solid var(--mj-border-subtle)',
      }}
    >
      <div
        className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium tracking-[0.12em] uppercase"
        style={{ color: 'var(--mj-text-subtle)' }}
      >
        <Globe className="h-3 w-3 text-[#9AC6E6]" />
        <span>Web Sources</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {sources.map((src) => (
          <a
            key={src.url}
            href={src.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] transition hover:bg-white/10"
            style={{
              backgroundColor: 'rgba(154, 198, 230, 0.08)',
              border: '1px solid rgba(154, 198, 230, 0.22)',
              color: '#C7E3F5',
            }}
          >
            <span className="truncate max-w-[220px]">{src.title}</span>
            <ExternalLink className="h-3 w-3 shrink-0 opacity-80" />
          </a>
        ))}
      </div>
    </div>
  );
}
