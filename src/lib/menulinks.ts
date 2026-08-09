/* DB CRUD for admin-managed external-link menu bookmarks (sidebar "メニュー").
 * The built-in nav (feed/episodes/etc.) stays hardcoded; only external-link
 * bookmarks are stored in `menu_links` so admins can add/edit/delete them. */
import { pool } from "./db";

export interface MenuLink {
  id: number;
  label: string;
  icon: string;
  href: string;
  sortOrder: number;
}

const COLS = `id, label, icon, href, sort_order AS "sortOrder"`;

export async function listMenuLinks(): Promise<MenuLink[]> {
  const res = await pool.query(
    `SELECT ${COLS} FROM menu_links ORDER BY sort_order ASC, id ASC`
  );
  return res.rows;
}

export interface MenuLinkInput {
  label: string;
  icon: string;
  href: string;
}

function sanitize(input: MenuLinkInput): MenuLinkInput {
  return {
    label: String(input.label ?? "").trim().slice(0, 60),
    icon: String(input.icon ?? "🔗").trim().slice(0, 8) || "🔗",
    href: String(input.href ?? "").trim().slice(0, 500),
  };
}

export async function createMenuLink(
  raw: MenuLinkInput
): Promise<MenuLink | null> {
  const d = sanitize(raw);
  if (!d.label || !d.href) return null;
  const max = await pool.query(
    `SELECT COALESCE(MAX(sort_order), 0) AS m FROM menu_links`
  );
  const sort = Number(max.rows[0].m) + 1;
  const res = await pool.query(
    `INSERT INTO menu_links (label, icon, href, sort_order)
     VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
    [d.label, d.icon, d.href, sort]
  );
  return res.rows[0] ?? null;
}

export async function updateMenuLink(
  id: number,
  raw: MenuLinkInput
): Promise<MenuLink | null> {
  const d = sanitize(raw);
  if (!d.label || !d.href) return null;
  const res = await pool.query(
    `UPDATE menu_links SET label=$1, icon=$2, href=$3, updated_at=now()
     WHERE id=$4 RETURNING ${COLS}`,
    [d.label, d.icon, d.href, id]
  );
  return res.rows[0] ?? null;
}

export async function deleteMenuLink(id: number): Promise<boolean> {
  const res = await pool.query(`DELETE FROM menu_links WHERE id=$1`, [id]);
  return (res.rowCount ?? 0) > 0;
}
