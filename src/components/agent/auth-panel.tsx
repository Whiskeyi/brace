"use client";

import { FormEvent, useState } from "react";
import { APP_NAME } from "@/lib/branding";
import { SparkIcon } from "./icons";

type AuthPanelProps = {
  configured: boolean;
  configurationError?: string | null;
  onSignIn: (email: string, password: string) => Promise<void>;
  onSignUp: (email: string, password: string) => Promise<{ needsConfirmation: boolean }>;
};

function readableAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : "操作失败，请稍后重试";
  if (/invalid login credentials/i.test(message)) return "邮箱或密码不正确";
  if (/email not confirmed/i.test(message)) return "请先前往邮箱完成验证";
  if (/already registered/i.test(message)) return "该邮箱已注册，请直接登录";
  if (/password/i.test(message) && /characters/i.test(message)) return "密码至少需要 6 位字符";
  return message;
}

export function AuthPanel({ configured, configurationError, onSignIn, onSignUp }: AuthPanelProps) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        await onSignIn(email.trim(), password);
      } else {
        const result = await onSignUp(email.trim(), password);
        if (result.needsConfirmation) {
          setNotice("验证邮件已发送，请完成验证后回来登录。若未收到，请检查垃圾邮件。 ");
          setMode("signin");
        }
      }
    } catch (nextError) {
      setError(readableAuthError(nextError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-intro" aria-label="产品介绍">
        <div className="brand brand--light">
          <span className="brand-mark"><SparkIcon size={21} /></span>
          <span>{APP_NAME}</span>
        </div>
        <div className="auth-intro-copy">
          <p className="eyebrow">YOUR EVERYDAY AI PARTNER</p>
          <h1>把复杂问题，<br />变成清晰行动。</h1>
          <p>思考、创作、分析、计算——一个可靠的通用智能体，陪你从想法走到结果。</p>
        </div>
        <div className="auth-proof">
          <div className="proof-orb"><SparkIcon size={18} /></div>
          <div><strong>安全连接你的专属数据</strong><span>会话由 RDS Supabase 隔离存储</span></div>
        </div>
      </section>

      <section className="auth-card-wrap">
        <div className="auth-card">
          <div className="mobile-brand brand">
            <span className="brand-mark"><SparkIcon size={19} /></span>
            <span>{APP_NAME}</span>
          </div>
          <div>
            <p className="auth-kicker">{mode === "signin" ? "欢迎回来" : "创建账号"}</p>
            <h2>{mode === "signin" ? "继续你的思考" : "开启智能协作"}</h2>
            <p className="auth-subtitle">{mode === "signin" ? "登录后即可访问你的历史会话。" : "只需邮箱和密码，即刻开始。"}</p>
          </div>

          {!configured ? (
            <div className="config-alert" role="alert">
              <strong>需要完成 Supabase 配置</strong>
              <span>{configurationError || "请配置 NEXT_PUBLIC_SUPABASE_URL 和 NEXT_PUBLIC_SUPABASE_ANON_KEY。"}</span>
            </div>
          ) : (
            <form className="auth-form" onSubmit={submit}>
              <label>
                <span>邮箱</span>
                <input
                  autoComplete="email"
                  inputMode="email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@example.com"
                  required
                  type="email"
                  value={email}
                />
              </label>
              <label>
                <span>密码</span>
                <input
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  minLength={6}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="至少 6 位字符"
                  required
                  type="password"
                  value={password}
                />
              </label>
              {error && <p className="form-message form-message--error" role="alert">{error}</p>}
              {notice && <p className="form-message form-message--notice" role="status">{notice}</p>}
              <button className="primary-button" disabled={busy} type="submit">
                {busy ? <span className="button-spinner" /> : null}
                {busy ? "请稍候…" : mode === "signin" ? "登录" : "注册账号"}
              </button>
            </form>
          )}

          {configured && (
            <p className="auth-switch">
              {mode === "signin" ? "还没有账号？" : "已经有账号？"}
              <button onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(null); setNotice(null); }} type="button">
                {mode === "signin" ? "立即注册" : "返回登录"}
              </button>
            </p>
          )}
          <p className="auth-legal">继续即表示你同意我们以安全方式处理会话数据。</p>
        </div>
      </section>
    </main>
  );
}
