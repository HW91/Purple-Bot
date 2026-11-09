/**
 * Email + AI go through the business coach worker over the COACH service binding — the same private
 * link the recruiting software uses. Nothing here talks to Gmail or an AI provider directly.
 *
 *  - Email: POST /api/send-email  { to, subject, htmlBody, fromName }  -> { success }
 *    (src/index.ts of business-coach, "/api/send-email")
 *  - AI:    POST /chat            { userId, message, threadId? }       -> { response }
 *    The business coach's chat route requires a userId and answers as "Coach P". Everything that calls
 *    AI goes through askAI() below so it can be pointed at a cleaner route later in one place.
 */
import type { Env } from "./types";
import { getSetting, log } from "./db";

const AI_USER_ID = "purple-bot-trading@internal";

export async function sendEmail(env: Env, subject: string, html: string, to?: string): Promise<boolean> {
  const recipient = to ?? (await getSetting(env, "notify_email"));
  if (!recipient) {
    await log(env, "warn", "notify", `Email not sent (no notification address set): ${subject}`);
    return false;
  }
  try {
    const res = await env.COACH.fetch("https://internal/api/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: recipient, subject, htmlBody: html, fromName: "Purple Bot" }),
    });
    const text = await res.text();
    let ok = false;
    try {
      ok = res.ok && JSON.parse(text).success === true;
    } catch {
      /* not JSON */
    }
    await log(env, ok ? "info" : "error", "notify", ok ? `Email sent: ${subject}` : `Email FAILED (${res.status}): ${subject} ${text.slice(0, 200)}`);
    return ok;
  } catch (e) {
    await log(env, "error", "notify", `Email error: ${(e as Error).message}`);
    return false;
  }
}

export async function askAI(env: Env, message: string, threadId?: string): Promise<string | null> {
  try {
    const res = await env.COACH.fetch("https://internal/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: AI_USER_ID, message, ...(threadId ? { threadId } : {}) }),
    });
    if (!res.ok) {
      await log(env, "error", "error", `AI call failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const data = (await res.json()) as Record<string, unknown>;
    const text = data.response ?? data.text ?? data.message ?? data.content;
    return typeof text === "string" && text.trim() ? text : null;
  } catch (e) {
    await log(env, "error", "error", `AI call error: ${(e as Error).message}`);
    return null;
  }
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function emailShell(title: string, bodyHtml: string): string {
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto"><h2 style="color:#4c1d95">${esc(title)}</h2>${bodyHtml}<p style="color:#888;font-size:12px">Purple Bot</p></div>`;
}
