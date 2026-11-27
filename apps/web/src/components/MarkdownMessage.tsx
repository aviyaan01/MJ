import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

interface CodeBlockProps {
  language?: string;
  code: string;
}

function CodeBlock({ language, code }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard blocked in restricted context
    }
  };

  return (
    <div
      className="my-3 overflow-hidden rounded-xl"
      style={{
        backgroundColor: '#07090E',
        border: '1px solid var(--mj-border-subtle)',
      }}
    >
      <div
        className="flex items-center justify-between px-3.5 py-2 text-[11px]"
        style={{
          backgroundColor: 'rgba(255, 255, 255, 0.025)',
          borderBottom: '1px solid var(--mj-border-subtle)',
          color: 'var(--mj-text-subtle)',
        }}
      >
        <span className="font-mono uppercase tracking-[0.08em]">{language || 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] transition hover:bg-white/5"
          style={{ color: copied ? 'var(--mj-status-good)' : 'var(--mj-text-secondary)' }}
          aria-label="Copy code snippet"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <div className="overflow-x-auto p-3.5">
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="mj-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre({ children }) {
            return <>{children}</>;
          },
          code(props) {
            const { className, children } = props;
            const match = /language-([\w-]+)/.exec(className ?? '');
            const text = extractText(children).replace(/\n$/, '');
            const isBlock = Boolean(match) || text.includes('\n');
            if (!isBlock) {
              return <code className={className}>{children}</code>;
            }
            return <CodeBlock language={match?.[1]} code={text} />;
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return extractText(props?.children);
  }
  return '';
}
