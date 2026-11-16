import { DATABASE_NOT_READY_MESSAGE } from "@/agent";

export function DatabaseNotice() {
  return (
    <div className="mx-auto mt-16 max-w-lg rounded-xl border border-amber-200 bg-amber-50 p-6 text-amber-900">
      <h1 className="mb-2 font-semibold">Database not set up</h1>
      <p className="text-sm">{DATABASE_NOT_READY_MESSAGE}</p>
    </div>
  );
}
