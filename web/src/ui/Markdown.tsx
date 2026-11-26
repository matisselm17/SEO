/**
 * Rendu Markdown sûr pour les réponses de l'assistant : paragraphes, titres, listes,
 * gras, italique, code, blocs de code et liens http(s) (directs vers le site analysé seulement ; images ignorées). Aucun HTML brut n'est interprété :
 * tout est construit en éléments React, le texte reste du texte.
 */
import { Fragment, type ReactNode } from "react";

function safeUrl(href: string): URL | null {
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, "");

/**
 * Lien écrit par l'assistant. Seuls les liens vers le site analysé s'ouvrent directement ;
 * un lien externe est montré comme du texte suivi de son domaine (adresse complète au survol),
 * pour qu'on sache où il mène avant de le recopier.
 */
function MdLink({ label, href, siteHost }: { label: ReactNode; href: string; siteHost?: string }) {
  const u = safeUrl(href);
  if (!u) return <>{label}</>;
  const host = bareHost(u.hostname);
  if (siteHost && host === bareHost(siteHost)) {
    return (
      <a href={u.href} target="_blank" rel="noopener noreferrer nofollow">
        {label}
      </a>
    );
  }
  return (
    <span className="md__ext" title={u.href}>
      {label} <span className="md__domain">({host})</span>
    </span>
  );
}

function inline(text: string, keyBase: string, siteHost?: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Ordre : code, image (ignorée), lien, gras, italique. « __ » et « _ » au milieu d'un mot restent du texte.
  const re = /(`[^`\n]+`)|(!\[[^\]\n]*\]\([^)\n]*\))|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*|(?<![\p{L}\p{N}_])__[^_\n]+__(?![\p{L}\p{N}_]))|(\*[^*\n]+\*|(?<![\p{L}\p{N}_])_[^_\n]+_(?![\p{L}\p{N}_]))/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    const tok = m[0];
    if (m[1]) out.push(<code key={k} className="md__code">{tok.slice(1, -1)}</code>);
    else if (m[2]) {
      /* image : rien n'est chargé ni affiché */
    } else if (m[3]) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      out.push(<MdLink key={k} label={inline(mm[1], k, siteHost)} href={mm[2]} siteHost={siteHost} />);
    } else if (m[4]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k, siteHost)}</strong>);
    else if (m[5]) out.push(<em key={k}>{inline(tok.slice(1, -1), k, siteHost)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "code"; code: string }
  | { t: "quote"; text: string };

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: "p", text: para.join("\n") });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      blocks.push({ t: "code", code: code.join("\n") });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ t: "h", level: h[1].length, text: h[2] });
      continue;
    }
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flush();
      const type = ul ? "ul" : "ol";
      const prev = blocks[blocks.length - 1];
      const text = (ul ?? ol)![1];
      if (prev && prev.t === type) prev.items.push(text);
      else blocks.push({ t: type, items: [text] });
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      blocks.push({ t: "quote", text: q[1] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // Ligne faite d'une seule image : ignorée, sans laisser de paragraphe vide.
    if (/^\s*!\[[^\]\n]*\]\([^)\n]*\)\s*$/.test(line)) continue;
    // Ligne de suite d'un élément de liste
    const prev = blocks[blocks.length - 1];
    if (!para.length && prev && (prev.t === "ul" || prev.t === "ol") && /^\s{2,}/.test(line)) {
      prev.items[prev.items.length - 1] += " " + line.trim();
      continue;
    }
    para.push(line);
  }
  flush();
  return blocks;
}

export function Markdown({ source, siteHost }: { source: string; siteHost?: string }) {
  const blocks = parse(source);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.t) {
          case "p":
            return (
              <p key={k}>
                {b.text.split("\n").map((ln, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {inline(ln, `${k}-${j}`, siteHost)}
                  </Fragment>
                ))}
              </p>
            );
          case "h":
            return <p key={k} className={`md__h md__h${Math.min(b.level, 3)}`}>{inline(b.text, k, siteHost)}</p>;
          case "ul":
            return <ul key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`, siteHost)}</li>)}</ul>;
          case "ol":
            return <ol key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`, siteHost)}</li>)}</ol>;
          case "code":
            return <pre key={k} className="md__pre"><code>{b.code}</code></pre>;
          case "quote":
            return <blockquote key={k}>{inline(b.text, k, siteHost)}</blockquote>;
        }
      })}
    </div>
  );
}
