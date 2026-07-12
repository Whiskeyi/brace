"use client";

import { useMemo, useState } from "react";
import { APP_NAME } from "@/lib/branding";
import type { Conversation } from "./types";
import { CloseIcon, LogoutIcon, PlusIcon, SearchIcon, SparkIcon, TrashIcon } from "./icons";

type SidebarProps = {
  conversations: Conversation[];
  currentId: string | null;
  email: string;
  mobileOpen: boolean;
  loading?: boolean;
  onClose: () => void;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onSignOut: () => void;
};

function groupDate(value: string) {
  const timestamp = new Date(value).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (timestamp >= today) return "今天";
  if (timestamp >= today - 86_400_000) return "昨天";
  if (timestamp >= today - 7 * 86_400_000) return "最近 7 天";
  return "更早";
}

export function Sidebar(props: SidebarProps) {
  const { conversations, currentId, email, mobileOpen, loading, onClose, onCreate, onSelect, onDelete, onSignOut } = props;
  const [query, setQuery] = useState("");
  const grouped = useMemo(() => {
    const filtered = conversations.filter((item) => item.title.toLowerCase().includes(query.trim().toLowerCase()));
    return filtered.reduce<Record<string, Conversation[]>>((result, conversation) => {
      const group = groupDate(conversation.updatedAt);
      (result[group] ??= []).push(conversation);
      return result;
    }, {});
  }, [conversations, query]);

  const initials = email.slice(0, 1).toUpperCase() || "U";

  return (
    <>
      <button className={`sidebar-scrim ${mobileOpen ? "is-open" : ""}`} aria-label="关闭会话列表" onClick={onClose} type="button" />
      <aside className={`sidebar ${mobileOpen ? "is-open" : ""}`}>
        <div className="sidebar-header">
          <div className="brand"><span className="brand-mark"><SparkIcon size={19} /></span><span>{APP_NAME}</span></div>
          <button className="icon-button sidebar-close" aria-label="关闭侧栏" onClick={onClose} type="button"><CloseIcon /></button>
        </div>
        <button className="new-chat-button" onClick={() => { onCreate(); onClose(); }} type="button"><PlusIcon size={18} /><span>开启新对话</span></button>
        <label className="conversation-search">
          <SearchIcon size={17} />
          <input aria-label="搜索会话" onChange={(event) => setQuery(event.target.value)} placeholder="搜索历史会话" value={query} />
        </label>

        <div className="conversation-list" aria-label="历史会话">
          {loading && conversations.length === 0 ? (
            <div className="conversation-skeletons" aria-label="正在加载会话">
              <span /><span /><span />
            </div>
          ) : null}
          {!loading && conversations.length === 0 ? <p className="sidebar-empty">还没有历史会话<br />从一个新问题开始吧</p> : null}
          {!loading && conversations.length > 0 && Object.keys(grouped).length === 0 ? <p className="sidebar-empty">没有匹配的会话</p> : null}
          {Object.entries(grouped).map(([group, items]) => (
            <section className="conversation-group" key={group}>
              <h2>{group}</h2>
              {items.map((conversation) => (
                <div className={`conversation-item ${currentId === conversation.id ? "is-active" : ""}`} key={conversation.id}>
                  <button className="conversation-select" onClick={() => { onSelect(conversation.id); onClose(); }} title={conversation.title} type="button">
                    <span>{conversation.title}</span>
                  </button>
                  <button className="conversation-delete" aria-label={`删除会话：${conversation.title}`} onClick={() => onDelete(conversation.id)} type="button"><TrashIcon size={16} /></button>
                </div>
              ))}
            </section>
          ))}
        </div>

        <div className="account-row">
          <span className="account-avatar">{initials}</span>
          <span className="account-copy"><strong>{email.split("@")[0]}</strong><small>{email}</small></span>
          <button className="icon-button" aria-label="退出登录" onClick={onSignOut} title="退出登录" type="button"><LogoutIcon size={19} /></button>
        </div>
      </aside>
    </>
  );
}
