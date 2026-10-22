import { cn } from "@/lib/utils";

/** Lalela lockup — the waveform-and-dot mark on ink, plus the wordmark.
 * Mirrors brand/lalela-app-icon.svg (see docs/BRAND.md). */
export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex select-none items-center gap-2.5", className)}>
      <svg
        viewBox="0 0 1024 1024"
        className="h-7 w-7 shrink-0"
        role="img"
        aria-label="Lalela"
      >
        <rect width="1024" height="1024" rx="232" fill="#0E0E10" />
        <g fill="#F5D34D">
          <rect x="216" y="392" width="92" height="240" rx="46" />
          <rect x="356" y="302" width="92" height="420" rx="46" />
          <rect x="496" y="212" width="92" height="520" rx="46" />
          <rect x="636" y="302" width="92" height="420" rx="46" />
          <rect x="776" y="452" width="92" height="120" rx="46" />
        </g>
        <circle cx="822" cy="700" r="46" fill="#FFFFFF" />
      </svg>
      <span className="text-lg font-bold tracking-tight text-foreground">Lalela</span>
    </div>
  );
}
