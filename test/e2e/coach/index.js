// Stand-in for the business coach worker: same two routes Purple-Bot uses, records what it receives.
const sent = [];
const chats = [];
export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/send-email" && req.method === "POST") {
      const b = await req.json();
      sent.push(b);
      return Response.json({ success: true, to: b.to, subject: b.subject });
    }
    if (url.pathname === "/chat" && req.method === "POST") {
      const b = await req.json();
      if (!b.userId) return Response.json({ error: "Please sign in to chat with Coach P" }, { status: 401 });
      chats.push(b);
      // report which data sections the end-of-day prompt contained, so the test can check the right data was sent
      if (/end-of-day analyst/.test(b.message)) {
        const keys = ["blockedBy", "stopLossTakeProfitHindsight", "reliability", "byEntryHour"].filter((k) => b.message.includes(k));
        return Response.json({ reply: "MOCK AI ANSWER [has:" + keys.join(",") + "]", tip: null, threadId: "t", model: "gemini-3.5-flash" });
      }
      // same shape as the real business coach (handleChat returns `reply`, not `response`)
      if (/FAIL_AI/.test(b.message)) return Response.json({ reply: "I'm having trouble connecting right now. Please try again in a moment.", tip: null, threadId: "t", model: "gemini-3.5-flash" });
      return Response.json({ reply: "MOCK AI ANSWER", tip: null, threadId: "t", model: "gemini-3.5-flash" });
    }
    if (url.pathname === "/_seen") return Response.json({ sent, chats });
    return new Response("nope", { status: 404 });
  },
};
