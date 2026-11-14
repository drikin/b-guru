import { NextResponse } from "next/server";
import { exportAll, netaAdminEmail } from "@/lib/neta-admin";
import { fail, NOT_ADMIN } from "../../_lib";

export const dynamic = "force-dynamic";

/** ネタ帳の全部を JSON で（参加した人のメールアドレスは入れない）。 */
export async function GET() {
  if (!(await netaAdminEmail())) return NOT_ADMIN();
  try {
    const data = await exportAll();
    const day = new Date().toISOString().slice(0, 10);
    return new NextResponse(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="neta-export-${day}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return fail(e, "admin-export");
  }
}
