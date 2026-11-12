"use client";

import { useEffect, useRef, useState } from "react";

// Ad-hoc buy form: type a company name (or a ticker) and pick the
// match, enter the amount, enter the PIN, tap Buy. The buy itself
// is still a plain form POST to /api/trade/buy — the server gates
// on the PIN, validates the ticker and the amount, and redirects
// home with a visible result notice. This component only resolves
// names to tickers; it never places a trade on its own.
//
// Search: debounced, 2+ characters, against /api/ticker/search
// (SPY universe — live FMP constituents, static 503 fallback).
// Names outside SPY are not in that list; the ticker field still
// accepts any typed symbol directly. Picking a suggestion fills
// the ticker; typing a valid ticker fills it too. Submitting with
// a company name and no pick is blocked here with a hint, instead
// of failing server-side as buy_invalid.
export default function BuyForm() {
  const [text, setText] = useState("");
  const [ticker, setTicker] = useState("");
  const [results, setResults] = useState<Array<{ ticker: string; company: string }>>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/ticker/search?q=${encodeURIComponent(q)}`);
        const json = await res.json().catch(() => ({}));
        if (reqId.current !== id) return;
        setResults(Array.isArray(json.results) ? json.results : []);
        setOpen(true);
      } catch {
        if (reqId.current === id) {
          setResults([]);
          setOpen(false);
        }
      } finally {
        if (reqId.current === id) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [text]);

  function onChange(v: string) {
    setText(v);
    setHint(null);
    const t = v.trim().toUpperCase();
    setTicker(/^[A-Z0-9]{1,5}(\.[A-Z0-9]{1,2})?$/.test(t) ? t : "");
  }

  function pick(r: { ticker: string; company: string }) {
    setText(r.ticker);
    setTicker(r.ticker);
    setResults([]);
    setOpen(false);
    setHint(null);
  }

  function onSubmit(e: React.FormEvent) {
    if (!ticker) {
      e.preventDefault();
      setHint("Pick a company from the list, or type its ticker symbol (e.g. MRNA).");
    }
  }

  const inputStyle = { padding: "10px 12px", borderRadius: 10, border: "1px solid #ccc", fontSize: 14 };

  return (
    <form method="post" action="/api/trade/buy" onSubmit={onSubmit} style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: 220, maxWidth: "100%" }}>
        <input
          type="text"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Company or ticker, e.g. Moderna"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          style={{ ...inputStyle, width: "100%", textTransform: "uppercase" }}
        />
        <input type="hidden" name="ticker" value={ticker} />
        {open && (
          <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 20, background: "#fff", border: "1px solid #ccc", borderRadius: 10, marginTop: 4, maxHeight: 220, overflowY: "auto", boxShadow: "0 4px 16px rgba(0,0,0,0.12)" }}>
            {searching && results.length === 0 ? (
              <div style={{ padding: "10px 12px", color: "#5f6368" }}>Searching…</div>
            ) : results.length === 0 ? (
              <div style={{ padding: "10px 12px", color: "#5f6368" }}>No match — type the ticker directly.</div>
            ) : (
              results.map((r) => (
                <div
                  key={r.ticker}
                  onMouseDown={() => pick(r)}
                  style={{ padding: "10px 12px", cursor: "pointer", borderBottom: "1px solid #eee" }}
                >
                  <b>{r.ticker}</b> <span style={{ color: "#5f6368" }}>{r.company}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
        $
        <input type="number" name="amount" defaultValue="100" min="1" max="10000" step="0.01" required style={{ ...inputStyle, width: 110 }} />
      </label>
      <input type="password" name="pin" placeholder="Approval PIN" autoComplete="off" inputMode="numeric" required style={{ ...inputStyle, width: 140 }} />
      <button type="submit" style={{ padding: "12px 20px", borderRadius: 999, border: "none", background: "#137333", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer" }}>
        Buy now
      </button>
      {hint && <div style={{ width: "100%", color: "#a50e0e", fontSize: 13 }}>{hint}</div>}
    </form>
  );
}
