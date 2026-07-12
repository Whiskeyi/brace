import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function IconBase({ size = 20, children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      {children}
    </svg>
  );
}

export function SparkIcon(props: IconProps) {
  return <IconBase {...props}><path d="M12 2.8c.55 4.92 2.42 7.02 7.2 7.7-4.78.68-6.65 2.78-7.2 7.7-.55-4.92-2.42-7.02-7.2-7.7 4.78-.68 6.65-2.78 7.2-7.7Z" fill="currentColor"/><path d="M19 15.5c.2 1.8.9 2.57 2.65 2.82-1.75.25-2.44 1.02-2.65 2.83-.2-1.81-.9-2.58-2.65-2.83 1.75-.25 2.44-1.02 2.65-2.82Z" fill="currentColor"/></IconBase>;
}

export function PlusIcon(props: IconProps) { return <IconBase {...props}><path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8"/></IconBase>; }
export function SearchIcon(props: IconProps) { return <IconBase {...props}><circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.7"/><path d="m16 16 4 4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7"/></IconBase>; }
export function MenuIcon(props: IconProps) { return <IconBase {...props}><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8"/></IconBase>; }
export function CloseIcon(props: IconProps) { return <IconBase {...props}><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8"/></IconBase>; }
export function SendIcon(props: IconProps) { return <IconBase {...props}><path d="m5 12 14-7-4.7 14-2.8-5.5L5 12Z" fill="currentColor"/><path d="m11.5 13.5 3.4-3.4" stroke="white" strokeLinecap="round" strokeWidth="1.3"/></IconBase>; }
export function StopIcon(props: IconProps) { return <IconBase {...props}><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/></IconBase>; }
export function LogoutIcon(props: IconProps) { return <IconBase {...props}><path d="M10 5H6.8A1.8 1.8 0 0 0 5 6.8v10.4A1.8 1.8 0 0 0 6.8 19H10M14 8l4 4-4 4M9 12h9" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7"/></IconBase>; }
export function TrashIcon(props: IconProps) { return <IconBase {...props}><path d="M8 7v-.8A2.2 2.2 0 0 1 10.2 4h3.6A2.2 2.2 0 0 1 16 6.2V7m-10 0h12m-1 0-.7 12H7.7L7 7m3 3v6m4-6v6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.55"/></IconBase>; }
export function ChevronIcon(props: IconProps) { return <IconBase {...props}><path d="m9 7 5 5-5 5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"/></IconBase>; }
export function CheckIcon(props: IconProps) { return <IconBase {...props}><path d="m5 12.5 4.2 4.2L19 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8"/></IconBase>; }
export function ToolIcon(props: IconProps) { return <IconBase {...props}><path d="M14.8 6.7a4 4 0 0 0-5.5 5.5l-5 5a1.4 1.4 0 0 0 2 2l5-5a4 4 0 0 0 5.5-5.5l-2.4 2.4-1.8-1.8 2.2-2.6Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.55"/></IconBase>; }
export function BrainIcon(props: IconProps) { return <IconBase {...props}><path d="M9 6.5A3 3 0 0 0 5.8 9.4 3.1 3.1 0 0 0 6 15.2 3 3 0 0 0 9.2 19c1 0 1.8-.35 2.8-1.2 1 .85 1.8 1.2 2.8 1.2a3 3 0 0 0 3.2-3.8 3.1 3.1 0 0 0 .2-5.8A3 3 0 0 0 15 6.5 3.1 3.1 0 0 0 12 4a3.1 3.1 0 0 0-3 2.5Zm3-2.3v13.5M8 9.5c1.3 0 2 .7 2 1.8m6-1.8c-1.3 0-2 .7-2 1.8M8.3 15c.9-.8 1.8-.9 2.7-.2m4.7.2c-.9-.8-1.8-.9-2.7-.2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.45"/></IconBase>; }
export function CodeIcon(props: IconProps) { return <IconBase {...props}><path d="m9 7-5 5 5 5m6-10 5 5-5 5m-2-12-2 14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6"/></IconBase>; }
export function GlobeIcon(props: IconProps) { return <IconBase {...props}><circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5"/><path d="M3.8 12h16.4M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5s-1.1 6.2-3.3 8.5C9.8 18.2 8.7 15.4 8.7 12S9.8 5.8 12 3.5Z" stroke="currentColor" strokeWidth="1.35"/></IconBase>; }
export function RetryIcon(props: IconProps) { return <IconBase {...props}><path d="M19 8V4m0 0h-4m4 0-3 3a7 7 0 1 0 1.5 7.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7"/></IconBase>; }
