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
/** The business coach's own failure replies (src/index.ts handleChat), returned as normal 200 answers. */
const AI_APOLOGY = /having trouble connecting right now|unable to generate a response|currently unable to respond/i;

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

/**
 * Our screens show plain text, so markdown shows up as raw symbols. Remove it (and the [MEASURED]-style tags and
 * "I'm an advisory system" reminders) in case the AI adds them anyway.
 */
export function cleanAiText(s: string): string {
  return s
    .replace(/\*{0,2}\[(?:MEASURED|HYPOTHESIS|ESTIMATE)[^\]]*\]\*{0,2}[ \t]*/g, "") // [MEASURED] tags, with any bold marks around them
    .replace(/\b(?:MEASURED|HYPOTHESIS)\b\s*[:\-–]\s*/g, "") // "MEASURED:" prefixes
    .replace(/^\s*#{1,6}\s*/gm, "") // headings
    .replace(/\*\*(.+?)\*\*/g, "$1") // bold
    .replace(/\*{2,}/g, "") // any leftover runs of asterisks
    .replace(/__(.+?)__/g, "$1")
    .replace(/^\s*[*•]\s+/gm, "- ") // bullets
    .replace(/(^|[\s(])\*([^*\n]+?)\*(?=$|[\s).,;:!?])/g, "$1$2") // italics
    .replace(/`([^`\n]+)`/g, "$1") // inline code
    .replace(/^\s*-?\s*\*?Reminder:[^\n]*advisory[^\n]*$/gim, "") // "Reminder: I am an advisory system..."
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    // business-coach's handleChat answers with { reply, tip, threadId, model, ... } (src/index.ts, "return jsonResponse({ reply, ...").
    const data = (await res.json()) as Record<string, unknown>;
    const text = data.reply ?? data.response ?? data.text ?? data.message ?? data.content;
    if (typeof text !== "string" || !text.trim()) {
      await log(env, "error", "error", `AI call returned no text (fields: ${Object.keys(data).join(", ")})`);
      return null;
    }
    // When both AI providers fail, the business coach still answers 200 with an apology instead of an error.
    // Never treat that apology as a real analysis.
    if (AI_APOLOGY.test(text)) {
      await log(env, "error", "error", `The business coach could not reach its AI providers: "${text.slice(0, 120)}"`);
      return null;
    }
    return cleanAiText(text);
  } catch (e) {
    await log(env, "error", "error", `AI call error: ${(e as Error).message}`);
    return null;
  }
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function emailShell(title: string, bodyHtml: string): string {
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto"><h2 style="color:#4c1d95">${esc(title)}</h2>${bodyHtml}<p style="color:#888;font-size:12px">Purple Bot</p></div>`;
}
