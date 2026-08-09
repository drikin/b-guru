/* OTP generation, storage, and verification (DB-backed) */
import crypto from "crypto";
import { pool } from "./db";

const OTP_TTL_SEC = 10 * 60; // 10 min
const OTP_LEN = 6;

export function generateOtp(): string {
  // 6-digit code, cryptographically random
  const buf = crypto.randomBytes(4);
  const num = buf.readUInt32BE(0) % 1000000;
  return num.toString().padStart(OTP_LEN, "0");
}

/** Store a fresh OTP for an email (invalidates previous unused ones). */
export async function createOtp(email: string): Promise<string> {
  const code = generateOtp();
  await pool.query(
    `UPDATE otp_codes SET used = TRUE WHERE email = $1 AND used = FALSE`,
    [email.toLowerCase()]
  );
  await pool.query(
    `INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [email.toLowerCase(), code, OTP_TTL_SEC]
  );
  return code;
}

/** Verify an OTP. On success marks all that email's codes used and returns true. */
export async function verifyOtp(
  email: string,
  code: string
): Promise<boolean> {
  const emailLower = email.toLowerCase();
  const res = await pool.query(
    `SELECT id, expires_at FROM otp_codes
     WHERE email = $1 AND code = $2 AND used = FALSE
     ORDER BY created_at DESC LIMIT 1`,
    [emailLower, code]
  );
  if (res.rows.length === 0) return false;
  const row = res.rows[0];
  if (new Date(row.expires_at) < new Date()) return false;
  // consume all codes for this email
  await pool.query(`UPDATE otp_codes SET used = TRUE WHERE email = $1`, [
    emailLower,
  ]);
  return true;
}
