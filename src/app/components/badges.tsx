import type { LeadView, ScoreLabel } from "@/agent";
import { STATUS_LABELS } from "@/app/lib/format";

const STATUS_STYLES: Record<LeadView["status"], string> = {
  new: "bg-zinc-100 text-zinc-700",
  qualified: "bg-sky-100 text-sky-800",
  viewing_booked: "bg-emerald-100 text-emerald-800",
  handed_off: "bg-amber-100 text-amber-900",
};

const SCORE_STYLES: Record<ScoreLabel, string> = {
  hot: "bg-rose-100 text-rose-800",
  warm: "bg-orange-100 text-orange-800",
  cold: "bg-slate-100 text-slate-700",
};

export function StatusBadge({ status }: { status: LeadView["status"] }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

export function ScoreBadge({ score }: { score: LeadView["score"] }) {
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${SCORE_STYLES[score.label]}`}
      title="Lead score, computed from the saved fields (0–100)"
    >
      {score.value} · {score.label}
    </span>
  );
}
