import type { ReactNode } from "react";

export function MetricCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <article className="rounded-xl border border-stone-200 bg-white px-4 py-3"><p className="text-xs font-bold uppercase tracking-wider text-stone-500">{label}</p><p className="mt-1 text-2xl font-black text-rose-800">{value}</p>{detail ? <p className="mt-1 text-sm text-stone-500">{detail}</p> : null}</article>;
}

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: "critical" | "warning" | "success" | "neutral" }) {
  const styles = { critical: "bg-red-100 text-red-800", warning: "bg-amber-100 text-amber-800", success: "bg-emerald-100 text-emerald-800", neutral: "bg-stone-200 text-stone-700" };
  return <span className={`rounded-full px-2 py-1 text-xs font-black ${styles[tone]}`}>{children}</span>;
}

export function SectionHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-black">{title}</h2>{description ? <p className="mt-1 text-sm text-stone-600">{description}</p> : null}</div>{action}</div>;
}
