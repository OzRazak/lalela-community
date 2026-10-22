import type { ResponseLength } from "@/lib/settings";

/** Standard/Detailed response-length picker (Wave A1) — sits beside the model
 * picker on the surfaces that generate text (meeting summary, chat). "Standard"
 * keeps answers concise; "Detailed" lifts the cap and asks the model to be
 * thorough. Sober Amp dial-2 styling matching the adjacent selects; pass
 * `className` to match a surface's sizing (defaults to the summary picker's). */
export function LengthSelect({
  value,
  onChange,
  className,
}: {
  value: ResponseLength;
  onChange: (v: ResponseLength) => void;
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ResponseLength)}
      className={
        className ?? "h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
      }
      title="Response length — Standard is concise, Detailed is thorough"
    >
      <option value="standard">Standard</option>
      <option value="detailed">Detailed</option>
    </select>
  );
}
