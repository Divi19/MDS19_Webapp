"use client";

import { useEffect, useRef, useState } from "react";
import { answer, INTRO_MESSAGE, QUICK_QUESTIONS } from "@/lib/agent";
import type { Prediction } from "@/lib/mockPrediction";

interface Message {
  role: "bot" | "user";
  text: string;
  time: string;
}

function replyDelay() {
  return 650 + Math.random() * 400;
}

function clockNow() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

export default function ChatPanel({ pred }: { pred: Prediction | null }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [typing, setTyping] = useState(false);
  const [quickHidden, setQuickHidden] = useState(false);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);

  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    setMessages([{ role: "bot", text: INTRO_MESSAGE, time: clockNow() }]);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typing]);

  function send(raw: string) {
    const text = raw.trim();
    if (!text) return;
    setMessages((m) => [...m, { role: "user", text, time: clockNow() }]);
    setQuickHidden(true);
    setTyping(true);
    window.setTimeout(
      () => {
        setTyping(false);
        setMessages((m) => [...m, { role: "bot", text: answer(text, pred), time: clockNow() }]);
      },
      replyDelay(),
    );
  }

  return (
    <div className="col col-3">
      <div className="chat-header">
        <div className="avatar">AL</div>
        <div>
          <div className="chat-name">Agentic layer</div>
          <div className="chat-status">
            {pred
              ? "translating prediction · GeneCards / GO"
              : "translates predictions into biological meaning"}
          </div>
        </div>
      </div>

      <div className="chat-messages" ref={scrollRef}>
        {messages.map((m, i) => (
          <div key={i}>
            <div className={m.role === "bot" ? "msg msg-bot" : "msg msg-user"}>{m.text}</div>
            <div className={m.role === "bot" ? "msg-time" : "msg-time user"}>
              {m.role === "bot" ? "Agentic layer" : "You"} · {m.time}
            </div>
          </div>
        ))}
        {typing && (
          <div className="typing">
            <span />
            <span />
            <span />
          </div>
        )}
      </div>

      <div className={`quick-questions${quickHidden ? " hidden" : ""}`}>
        {QUICK_QUESTIONS.map((q) => (
          <button key={q} className="quick-q" onClick={() => send(q)}>
            {q}
          </button>
        ))}
      </div>

      <div className="chat-input-row">
        <textarea
          className="chat-input"
          rows={1}
          placeholder="Ask about clusters, genes, or biomarkers…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
              setInput("");
            }
          }}
        />
        <button
          className="send-btn"
          title="Send"
          onClick={() => {
            send(input);
            setInput("");
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
