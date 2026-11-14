/* 📝 /neta/w/<週の id> — その週のネタのランキング。 */
import type { Metadata } from "next";
import { connection } from "next/server";
import { getWeek, netaSort } from "@/lib/neta-board";
import WeekBoard from "../../WeekBoard";

function weekId(raw: string): number {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : -1;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  await connection();
  const week = await getWeek(weekId((await params).id));
  return week ? { title: week.title || `${week.startDate} の週` } : {};
}

export default async function NetaWeekPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  return <WeekBoard weekId={weekId(id)} sort={netaSort(sp.sort)} />;
}
