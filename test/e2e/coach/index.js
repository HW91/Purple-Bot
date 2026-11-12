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
        const keys = ["blockedBy", "stopLossTakeProfitHindsight", "reliability", "byEntryHour", "earlyExits", "moneyFlow"].filter((k) => b.message.includes(k));
        if (b.message.includes("KALSHI CONTRACT RULES") && b.message.includes("Settlement Value")) keys.push("rules");
        if (/TRADING PROHIBITIONS|CONFIDENTIAL/.test(b.message)) keys.push("LEAK"); // the confidential appendix must never be sent
        return Response.json({ reply: "MOCK AI ANSWER [has:" + keys.join(",") + "]", tip: null, threadId: "t", model: "gemini-3.5-flash" });
      }
      // the dashboard chat: report whether the strategy data reached the AI
      if (/inside a personal Kalshi trading-bot dashboard/.test(b.message) && /ECHO_DATA/.test(b.message)) {
        const keys = ["strategyStats", "stopLossTakeProfitHindsight", "blockedBy", "byEntryHour", "moneyFlow", "recentTrades", "priceVsProbability", "tradeFiles", "latestDailyOverview"].filter((k) => b.message.includes('"' + k + '"'));
        if (b.message.includes('"missedByDisagreement":{"note"')) keys.push("missedMetals"); // metals bots exist: the skipped-because-they-disagreed estimate was sent
        if (b.message.includes('"pricesAround":[[') && b.message.includes('"checklistAtEntry"')) keys.push("tradeSeries"); // a trade file with its price series was sent
        if (b.message.includes("KALSHI CONTRACT RULES") && b.message.includes("Settlement Value")) keys.push("rules");
        // full per-trade detail: how each contract finally settled, what holding would have made, and what happened after an early exit
        if (b.message.includes('"finalResult"') && b.message.includes('"ifHeldPnl"') && b.message.includes('"amount"') && b.message.includes('"afterExit"')) keys.push("tradeDetail");
        if (/TRADING PROHIBITIONS|CONFIDENTIAL/.test(b.message)) keys.push("LEAK");
        const trades = (b.message.match(/"asset":"[A-Z]+","side"/g) || []).length;
        return Response.json({ reply: "MOCK CHAT [has:" + keys.join(",") + "] trades:" + trades, tip: null, threadId: "t", model: "gemini-3.5-flash" });
      }
      // same shape as the real business coach (handleChat returns `reply`, not `response`)
      if (/FAIL_AI/.test(b.message)) return Response.json({ reply: "I'm having trouble connecting right now. Please try again in a moment.", tip: null, threadId: "t", model: "gemini-3.5-flash" });
      return Response.json({ reply: "MOCK AI ANSWER", tip: null, threadId: "t", model: "gemini-3.5-flash" });
    }
    if (url.pathname === "/_seen") return Response.json({ sent, chats });
    return new Response("nope", { status: 404 });
  },
};
