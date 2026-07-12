"use client";

import { BrainIcon, CodeIcon, GlobeIcon, SparkIcon, ToolIcon } from "./icons";

const suggestions = [
  { icon: BrainIcon, title: "深度分析", prompt: "帮我分析一个复杂问题，并给出可执行的分步方案" },
  { icon: CodeIcon, title: "代码协作", prompt: "帮我设计一个可靠的 API，并说明关键技术取舍" },
  { icon: GlobeIcon, title: "知识问答", prompt: "用简单清晰的方式解释一个我不熟悉的概念" },
  { icon: ToolIcon, title: "工具执行", prompt: "计算 (128 × 36 + 720) ÷ 12，并展示计算过程" },
];

export function EmptyState({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return (
    <section className="empty-state">
      <div className="empty-orb"><span><SparkIcon size={30} /></span></div>
      <p className="eyebrow">UNIVERSAL AGENT</p>
      <h1>今天想一起解决什么？</h1>
      <p className="empty-lead">我能理解上下文、拆解任务并使用工具，从第一问陪你走到最终结果。</p>
      <div className="suggestion-grid">
        {suggestions.map(({ icon: Icon, title, prompt }) => (
          <button key={title} onClick={() => onPrompt(prompt)} type="button">
            <span className="suggestion-icon"><Icon size={19} /></span>
            <span><strong>{title}</strong><small>{prompt}</small></span>
            <span className="suggestion-arrow">↗</span>
          </button>
        ))}
      </div>
    </section>
  );
}
