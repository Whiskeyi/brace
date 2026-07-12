"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ToolActivity } from "./types";
import { CheckIcon, ChevronIcon, RetryIcon, SparkIcon, ToolIcon } from "./icons";

type MessageListProps = {
  messages: ChatMessage[];
  loading?: boolean;
  onRetry: () => void;
};

function LinkedText({ children }: { children: string }) {
  const parts = children.split(/(https?:\/\/[^\s<>()]+)/g);
  return parts.map((part, index) =>
    /^https?:\/\//.test(part) ? (
      <a href={part} key={`${part}-${index}`} rel="noreferrer noopener" target="_blank">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

function ToolRow({ tool }: { tool: ToolActivity }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool-row tool-row--${tool.status}`}>
      <button aria-expanded={open} onClick={() => setOpen((value) => !value)} type="button">
        <span className="tool-status-icon">{tool.status === "running" ? <span className="mini-spinner" /> : tool.status === "complete" ? <CheckIcon size={14} /> : "!"}</span>
        <ToolIcon size={15} />
        <span>{tool.status === "running" ? `正在使用 ${tool.name}` : tool.status === "complete" ? `${tool.name} 已完成` : `${tool.name} 执行失败`}</span>
        <ChevronIcon className={open ? "is-rotated" : ""} size={15} />
      </button>
      {open ? (
        <pre>{JSON.stringify(tool.output ?? tool.input ?? "暂无详情", null, 2)}</pre>
      ) : null}
    </div>
  );
}

function AssistantMessage({ message, onRetry }: { message: ChatMessage; onRetry: () => void }) {
  return (
    <article className="message message--assistant">
      <div className="assistant-avatar"><SparkIcon size={15} /></div>
      <div className="message-body">
        {message.tools?.length ? <div className="tool-activities">{message.tools.map((tool) => <ToolRow key={tool.id} tool={tool} />)}</div> : null}
        {message.content ? <div className="message-content"><LinkedText>{message.content}</LinkedText></div> : message.status === "streaming" ? <div className="thinking-indicator"><i /><i /><i /><span>正在思考</span></div> : null}
        {message.status === "streaming" && message.content ? <span className="stream-caret" /> : null}
        {message.status === "stopped" ? <p className="message-note">回答已停止</p> : null}
        {message.status === "error" ? (
          <div className="message-error"><span>回答生成失败，请重试。</span><button onClick={onRetry} type="button"><RetryIcon size={15} />重新生成</button></div>
        ) : null}
      </div>
    </article>
  );
}

export function MessageList({ messages, loading, onRetry }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const lastContent = messages.at(-1)?.content;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: messages.some((item) => item.status === "streaming") ? "auto" : "smooth", block: "end" });
  }, [lastContent, messages.length, messages]);

  if (loading) {
    return (
      <div className="messages-loading" aria-label="正在加载消息">
        <span /><span /><span />
      </div>
    );
  }

  return (
    <div className="message-list" aria-live="polite">
      {messages.map((message) => message.role === "user" ? (
        <article className="message message--user" key={message.id}><div className="message-content">{message.content}</div></article>
      ) : <AssistantMessage key={message.id} message={message} onRetry={onRetry} />)}
      <div ref={endRef} />
    </div>
  );
}
