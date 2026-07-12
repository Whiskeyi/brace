"use client";

import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { APP_NAME } from "@/lib/branding";
import { SendIcon, StopIcon } from "./icons";

const MAX_LENGTH = 16_000;

type ComposerProps = {
  busy: boolean;
  initialValue?: string;
  onSend: (content: string) => void;
  onStop: () => void;
};

export function Composer({ busy, initialValue, onSend, onStop }: ComposerProps) {
  const [value, setValue] = useState(initialValue ?? "");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!initialValue) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [initialValue]);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [value]);

  function submit() {
    const content = value.trim();
    if (!content || busy) return;
    setValue("");
    onSend(content);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="composer-wrap">
      <div className={`composer ${busy ? "is-busy" : ""}`}>
        <textarea
          aria-label="输入消息"
          maxLength={MAX_LENGTH}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={keyDown}
          placeholder={`给 ${APP_NAME} 发消息…`}
          ref={textareaRef}
          rows={1}
          value={value}
        />
        <div className="composer-footer">
          <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
          {value.length > MAX_LENGTH * 0.85 ? <span className="character-count">{value.length.toLocaleString()} / {MAX_LENGTH.toLocaleString()}</span> : null}
          {busy ? (
            <button className="send-button stop-button" aria-label="停止生成" onClick={onStop} title="停止生成" type="button"><StopIcon size={19} /></button>
          ) : (
            <button className="send-button" aria-label="发送消息" disabled={!value.trim()} onClick={submit} title="发送" type="button"><SendIcon size={19} /></button>
          )}
        </div>
      </div>
      <p className="composer-disclaimer">AI 可能会犯错，重要信息请核实。</p>
    </div>
  );
}
