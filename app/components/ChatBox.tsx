"use client";

import { useState } from "react";

// Chat about the scanner's decisions, on the dashboard itself.
// Sends only the question to /api/chat; the server grounds the answer
// in the latest leaderboard, shortlist and paper trades, and the LLM
// (OpenRouter free model) explains — it cannot place trades or invent
// picks. No login, no secret in the browser: /api/chat is public and
// only uses data already shown on this page.
export default function ChatBox() {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggestions = [
    "Why is AMD ranked #1?",
    "Why was no trade bought today?",
    "Why is AVGO in the sector leaders?",
  ];

  async function ask(q: string) {
    const text = q.trim();
    if (!text || loading) return;
    setQuestion("");
    setError(null);
    setMessages((m) => [...m, { role: "user", text }]);
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `Chat failed (${res.status})`);
      setMessages((m) => [...m, { role: "assistant", text: String(json.answer ?? "") }]);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => ask(s)}
            disabled={loading}
            style={{
              border: "1px solid #c8d6e5", background: "#eef4fb", borderRadius: 999, padding: "8px 12px",
              fontSize: 13, cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1,
            }}
          >
            {s}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 420, overflowY: "auto" }}>
        {messages.length === 0 ? (
          <p style={{ color: "#666", fontSize: 14, margin: 0 }}>
            Ask about a ranking, a catalyst, a trade, or a sector leader — for example, why a ticker is on top, or why a position was closed.
            Answers explain the scanner&apos;s data only; they are not trading advice.
          </p>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                background: m.role === "user" ? "#1a73e8" : "#f1f3f4",
                color: m.role === "user" ? "#fff" : "#202124",
                borderRadius: 14, padding: "10px 14px", fontSize: 14, lineHeight: 1.5,
                maxWidth: "92%", whiteSpace: "pre-wrap",
              }}
            >
              {m.text}
            </div>
          ))
        )}
        {loading ? <p style={{ color: "#666", fontSize: 14, margin: 0 }}>Thinking…</p> : null}
        {error ? <p style={{ color: "#b3261e", fontSize: 14, margin: 0 }}>{error}</p> : null}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
        style={{ display: "flex", gap: 8, marginTop: 12 }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about a decision…"
          maxLength={500}
          style={{
            flex: 1, minWidth: 0, fontSize: 16, padding: "12px 14px",
            border: "1px solid #dadce0", borderRadius: 24, outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={loading || !question.trim()}
          style={{
            background: "#1a73e8", color: "#fff", border: "none", borderRadius: 24,
            padding: "12px 20px", fontSize: 16, cursor: loading ? "default" : "pointer",
            opacity: loading || !question.trim() ? 0.6 : 1,
          }}
        >
          Ask
        </button>
      </form>
    </div>
  );
}
