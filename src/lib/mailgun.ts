/* Mailgun email sending for OTP */
const BASE = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net/v3";
const DOMAIN = process.env.MAILGUN_DOMAIN || "backspace.fm";
const API_KEY = process.env.MAILGUN_API_KEY || "";

/** Send a simple text email via Mailgun. Throws on failure. */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<{ message: string }> {
  const auth = "Basic " + Buffer.from(`api:${API_KEY}`).toString("base64");
  const form = new URLSearchParams();
  form.set("from", `${process.env.MAIL_FROM_NAME || "BSM Portal"} <${process.env.MAIL_FROM_EMAIL || `noreply@${DOMAIN}`}>`);
  form.set("to", opts.to);
  form.set("subject", opts.subject);
  form.set("text", opts.text);
  if (opts.html) form.set("html", opts.html);

  const url = `${BASE}/${DOMAIN}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Mailgun error: ${res.status} ${body}`);
  }
  return res.json();
}
