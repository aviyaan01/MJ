import type { SVGProps } from 'react';

export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <circle
        cx="12"
        cy="12"
        r="9.25"
        stroke="rgba(199, 227, 245, 0.36)"
        strokeWidth="1.2"
      />
      <path
        d="M5.5 14.5 9.2 7.5 12 16l2.8-6.5 3.7 5"
        stroke="#C7E3F5"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
