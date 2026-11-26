import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Bot, Check, LoaderCircle, Square, Trash2 } from "lucide-react";
import type { ChatEvent, ChatMessage, ChatRequest, ChatState, SiteSummary } from "../lib/types";
import { keys, useChat } from "../lib/queries";
import { request, sendJSON, toAppError, type AppError } from "../lib/api";
import { readSSE } from "../lib/sse";
import { setQueryData } from "../lib/cache";
import { takeDraft } from "../lib/draft";
import { sitePath } from "../lib/router";
import { fmtDateTime } from "../lib/format";
import { PageHeader } from "../ui/Section";
import { Markdown } from "../ui/Markdown";
import { Button, ButtonLink } from "../ui/Button";
import { ConfirmButton } from "../ui/ConfirmButton";
import { EmptyState, ErrorState } from "../ui/States";
import { Skeleton, SkeletonText, LoadingLabel } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { QueryError } from "./common";

interface Pending {
  question: string;
  tools: { label: string; done: boolean }[];
  text: string;
  error: AppError | null;
}

function Sources({ sources }: { sources: string[] }) {
  if (!sources.length) return null;
  return (
    <div className="msg__sources">
      <span className="msg__sources-label">Données consultées</span>
      {sources.map((s) => <span key={s} className="tag">{s}</span>)}
    </div>
  );
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === "user") {
    return (
      <div className="msg msg--user">
        <p className="msg__bubble">{m.content}</p>
      </div>
    );
  }
  return (
    <div className="msg msg--assistant">
      <span className="msg__avatar" aria-hidden><Bot size={15} /></span>
      <div className="msg__body">
        <Markdown source={m.content} />
        <Sources sources={m.sources} />
        <time className="msg__time" dateTime={m.createdAt}>{fmtDateTime(m.createdAt)}</time>
      </div>
    </div>
  );
}

export function AssistantScreen({ site }: { site: SiteSummary }) {
  const q = useChat(site.id);
  const toast = useToast();
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [clearing, setClearing] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const state = q.data;
  const messages = state?.messages ?? [];
  const streaming = !!pending && !pending.error;

  // Question préparée depuis un autre écran.
  useEffect(() => {
    const d = takeDraft(site.id);
    if (d) {
      setInput(d);
      requestAnimationFrame(() => textarea.current?.focus());
    }
  }, [site.id]);

  useEffect(() => () => controller.current?.abort(), []);

  // Hauteur du champ selon son contenu.
  useLayoutEffect(() => {
    const t = textarea.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(220, t.scrollHeight)}px`;
  }, [input]);

  const scrollToEnd = useCallback(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
  }, []);
  useEffect(() => {
    if (pending) scrollToEnd();
  }, [pending, scrollToEnd]);

  const appendMessage = (m: ChatMessage) =>
    setQueryData<ChatState>(keys.chat(site.id), (prev) => (prev ? { ...prev, messages: prev.messages.some((x) => x.id === m.id) ? prev.messages : [...prev.messages, m] } : prev));

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || streaming) return;
    setInput("");
    const ctrl = new AbortController();
    controller.current = ctrl;
    setPending({ question, tools: [], text: "", error: null });
    // Les morceaux de texte sont regroupés et affichés une fois par image.
    let buffer = "";
    let raf = 0;
    const flush = () => {
      raf = 0;
      const chunk = buffer;
      buffer = "";
      if (chunk) setPending((p) => (p ? { ...p, text: p.text + chunk } : p));
    };
    let finished = false;
    try {
      const res = await request(keys.chat(site.id), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ message: question } satisfies ChatRequest),
        signal: ctrl.signal,
      });
      await readSSE(res, (msg) => {
        let ev: ChatEvent;
        try {
          ev = JSON.parse(msg.data) as ChatEvent;
        } catch {
          return;
        }
        switch (ev.type) {
          case "start":
            appendMessage(ev.userMessage);
            setPending((p) => (p ? { ...p, question: "" } : p));
            break;
          case "tool":
            setPending((p) => (p ? { ...p, tools: [...p.tools.map((t) => ({ ...t, done: true })), { label: ev.label, done: false }] } : p));
            break;
          case "delta":
            buffer += ev.text;
            if (!raf) raf = requestAnimationFrame(flush);
            break;
          case "done":
            finished = true;
            if (raf) cancelAnimationFrame(raf);
            appendMessage(ev.message);
            setPending(null);
            break;
          case "error":
            finished = true;
            if (raf) cancelAnimationFrame(raf);
            flush();
            setPending((p) => (p ? { ...p, error: { ...ev.error, status: 0 } } : p));
            break;
        }
      }, ctrl.signal);
      if (!finished && !ctrl.signal.aborted) {
        flush();
        setPending((p) => (p ? { ...p, error: { code: "chat_unavailable", message: "La réponse a été interrompue.", action: "Réessayez.", status: 0 } } : p));
      }
    } catch (err) {
      const e = toAppError(err);
      if (e.code === "aborted" || ctrl.signal.aborted) {
        setPending(null);
        return;
      }
      setPending((p) => (p ? { ...p, error: e } : { question, tools: [], text: "", error: e }));
    } finally {
      if (controller.current === ctrl) controller.current = null;
    }
  };

  const lastQuestion = () => {
    if (pending?.question) return pending.question;
    const users = (q.data?.messages ?? []).filter((m) => m.role === "user");
    return users[users.length - 1]?.content ?? "";
  };

  const stop = () => {
    controller.current?.abort();
    setPending(null);
    toast.show({ tone: "neutral", title: "Réponse arrêtée" });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  };

  const clear = async () => {
    setClearing(true);
    try {
      await sendJSON("DELETE", keys.chat(site.id));
      setQueryData<ChatState>(keys.chat(site.id), (prev) => (prev ? { ...prev, messages: [] } : prev));
    } catch (err) {
      const e = toAppError(err);
      toast.show({ tone: "error", title: e.message, text: e.action });
    } finally {
      setClearing(false);
    }
  };

  if (state && !state.available) {
    return (
      <>
        <PageHeader title="Assistant IA" description="Un assistant qui répond à vos questions à partir des résultats de l'analyse de votre site." />
        <EmptyState
          tone="framed"
          icon={<Bot size={20} />}
          title="L'assistant n'est pas activé sur ce serveur"
          actions={<ButtonLink to={sitePath(site.id, "settings")}>Voir les paramètres</ButtonLink>}
        >
          <p>Il a besoin d'une clé d'accès au modèle d'IA, configurée côté serveur par la personne qui gère l'installation. La clé n'est jamais transmise à votre navigateur.</p>
          <p>Le reste du logiciel fonctionne sans lui : note, problèmes, pages et recommandations.</p>
        </EmptyState>
      </>
    );
  }

  const empty = state && messages.length === 0 && !pending;

  return (
    <div className="chat">
      <PageHeader
        title="Assistant IA"
        description={<>Il répond à partir des résultats de l'analyse de <span className="mono-host">{site.host}</span>{site.searchConsole.available ? " et de votre export Search Console" : ""}. Le contenu de vos pages est lu comme une donnée, jamais comme une consigne.</>}
        actions={messages.length > 0 ? <ConfirmButton size="sm" icon={<Trash2 size={14} aria-hidden />} confirmLabel="Confirmer l'effacement" onConfirm={clear} loading={clearing}>Effacer la conversation</ConfirmButton> : undefined}
      />
      <QueryError q={q} />

      <div className="chat__log" aria-live="polite" aria-busy={streaming}>
        {!state && !q.error && (
          <>
            <LoadingLabel />
            <div className="msg msg--user"><Skeleton w={220} h={38} r={12} /></div>
            <div className="msg msg--assistant"><Skeleton w={28} h={28} r={8} /><div className="msg__body"><SkeletonText lines={4} /></div></div>
          </>
        )}

        {empty && (
          <div className="chat__start">
            <p className="chat__start-title">Que voulez-vous savoir sur votre site ?</p>
            {state.suggestions.length > 0 ? (
              <ul className="suggestions">
                {state.suggestions.map((s) => (
                  <li key={s}>
                    <button type="button" className="suggestion" onClick={() => void send(s)}>{s}</button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Les questions suggérées apparaîtront après la première analyse.</p>
            )}
          </div>
        )}

        {messages.map((m) => <Message key={m.id} m={m} />)}

        {pending && (
          <>
            {pending.question && (
              <div className="msg msg--user"><p className="msg__bubble">{pending.question}</p></div>
            )}
            <div className="msg msg--assistant">
              <span className="msg__avatar" aria-hidden><Bot size={15} /></span>
              <div className="msg__body">
                {pending.tools.length > 0 && (
                  <ul className="tools">
                    {pending.tools.map((t, i) => (
                      <li key={i} className={`tool ${t.done || pending.text ? "is-done" : ""}`}>
                        {t.done || pending.text ? <Check size={13} aria-hidden /> : <LoaderCircle size={13} className="btn__spin" aria-hidden />}
                        {t.label}
                      </li>
                    ))}
                  </ul>
                )}
                {pending.text ? (
                  <div className={pending.error ? "msg__partial" : undefined}><Markdown source={pending.text} /></div>
                ) : (
                  !pending.error && pending.tools.length === 0 && <p className="typing" aria-label="L'assistant réfléchit"><span /><span /><span /></p>
                )}
                {pending.error && (
                  <div className="chat__error">
                    <ErrorState
                      error={pending.error}
                      inline
                      onRetry={pending.error.code === "chat_not_configured" ? undefined : () => { const qn = lastQuestion(); setPending(null); void send(qn); }}
                    />
                  </div>
                )}
              </div>
            </div>
          </>
        )}
        <div ref={endRef} />
      </div>

      {state && (
        <form className="composer" onSubmit={onSubmit}>
          {!empty && state.suggestions.length > 0 && !streaming && messages.length < 3 && (
            <div className="composer__chips">
              {state.suggestions.filter((s) => !messages.some((m) => m.content === s)).slice(0, 3).map((s) => (
                <button key={s} type="button" className="chip" onClick={() => void send(s)}>{s}</button>
              ))}
            </div>
          )}
          <div className="composer__box">
            <label htmlFor="chat-input" className="sr-only">Votre question</label>
            <textarea
              id="chat-input"
              ref={textarea}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder="Posez une question sur votre site…"
              maxLength={4000}
            />
            {streaming ? (
              <Button variant="secondary" size="sm" icon={<Square size={11} fill="currentColor" aria-hidden />} onClick={stop}>Arrêter</Button>
            ) : (
              <Button type="submit" variant="primary" size="sm" disabled={!input.trim()} aria-label="Envoyer la question" icon={<ArrowUp size={16} aria-hidden />} />
            )}
          </div>
          <p className="composer__hint">Entrée pour envoyer, Maj + Entrée pour aller à la ligne. Vérifiez les conseils importants avant de les appliquer.</p>
        </form>
      )}
    </div>
  );
}
