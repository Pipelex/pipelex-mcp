import type { ReactNode } from "react";

/**
 * Shared chrome for the small overlay buttons the views float over their
 * content (fullscreen toggle, summarize handoff): one light/dark palette so a
 * tweak lands in every view at once. Positioning stays at the call site.
 */
export function ToolbarButton({
  dark,
  onClick,
  disabled = false,
  className,
  children,
}: {
  dark: boolean;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "cursor-pointer rounded-md px-2 py-1 text-xs disabled:cursor-default disabled:opacity-60",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        background: dark ? "rgba(31,41,55,0.85)" : "rgba(243,244,246,0.9)",
        color: dark ? "#e5e7eb" : "#111827",
        border: `1px solid ${dark ? "#374151" : "#d1d5db"}`,
      }}
    >
      {children}
    </button>
  );
}
