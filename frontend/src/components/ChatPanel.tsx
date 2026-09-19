"use client";

import { useState, type FormEvent } from "react";
import { answer, INTRO_MESSAGE, QUICK_QUESTIONS } from "@/lib/agent";
import type { PredictionResponse } from "@/lib/types";

interface Message {
  role: "reader" | "user";
  text: string;
}

export default function ChatPanel({ prediction }: { prediction: PredictionResponse }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([{ role: "reader", text: INTRO_MESSAGE }]);

  function routeQuestion(question: string) {
    const text = question.trim();
    if (!text) return;
    setMessages((items) => [
      ...items,
      { role: "user", text },
      { role: "reader", text: answer(text, prediction) },
    ]);
    setInput("");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    routeQuestion(input);
  }

  return (
    <aside className={`rule-preview${open ? " open" : ""}`}>
      <button className="rule-preview-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span><strong>Evidence reader</strong><small>Evidence-only · deterministic · rule-based</small></span>
        <i aria-hidden="true">{open ? "−" : "+"}</i>
      </button>
      {open && (
        <div className="rule-preview-body">
          <div className="rule-reader-notice">Uses only the loaded response. No generative model or external annotation.</div>
          <div className="chat-messages rule-reader-messages" aria-live="polite">
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`msg ${message.role === "user" ? "msg-user" : "msg-bot"}`}>{message.text}</div>
            ))}
          </div>
          <div className="quick-questions">
            {QUICK_QUESTIONS.map((question) => <button type="button" className="quick-q" key={question} onClick={() => routeQuestion(question)}>{question}</button>)}
          </div>
          <form className="chat-input-row" onSubmit={submit}>
            <input className="chat-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask about returned evidence" aria-label="Ask the evidence reader" />
            <button className="send-btn" type="submit" disabled={!input.trim()}>Send</button>
          </form>
        </div>
      )}
    </aside>
  );
}
