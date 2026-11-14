/* 📝 /neta — 今週のネタのランキング。 */
import type { Metadata } from "next";
import { connection } from "next/server";
import { netaSort } from "@/lib/neta-board";
import WeekBoard from "./WeekBoard";

export const metadata: Metadata = { title: { absolute: "backspace.fm のネタ帳" } };

export default async function NetaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const sp = await searchParams;
  return <WeekBoard weekId={null} sort={netaSort(sp.sort)} />;
}
