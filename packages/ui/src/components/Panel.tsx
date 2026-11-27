import type { HTMLAttributes, ReactNode } from 'react';

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  elevated?: boolean;
}

export function Panel({
  children,
  elevated = false,
  className = '',
  style,
  ...rest
}: PanelProps) {
  return (
    <section
      className={className}
      style={{
        background: elevated
          ? 'linear-gradient(145deg, rgba(18, 23, 34, 0.94), rgba(11, 15, 22, 0.95))'
          : 'linear-gradient(145deg, rgba(15, 20, 29, 0.92), rgba(9, 12, 18, 0.94))',
        border: '1px solid var(--mj-border-subtle)',
        borderRadius: '18px',
        boxShadow: 'var(--mj-shadow-panel)',
        backdropFilter: 'blur(20px)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </section>
  );
}
