/**
 * Rendu Markdown sûr pour les réponses de l'assistant : paragraphes, titres, listes,
 * gras, italique, code, blocs de code et liens http(s). Aucun HTML brut n'est interprété :
 * tout est construit en éléments React, le texte reste du texte.
 */
import { Fragment, type ReactNode } from "react";

function safeHref(href: string): string | null {
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Ordre : code, lien, gras, italique.
  const re = /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|(?<![\p{L}\p{N}])_[^_\n]+_(?![\p{L}\p{N}]))/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    const tok = m[0];
    if (m[1]) out.push(<code key={k} className="md__code">{tok.slice(1, -1)}</code>);
    else if (m[2]) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const href = safeHref(mm[2]);
      out.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer nofollow">
            {mm[1]}
          </a>
        ) : (
          <Fragment key={k}>{mm[1]}</Fragment>
        ),
      );
    } else if (m[3]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[4]) out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
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

export function Markdown({ source }: { source: string }) {
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
                    {inline(ln, `${k}-${j}`)}
                  </Fragment>
                ))}
              </p>
            );
          case "h":
            return <p key={k} className={`md__h md__h${Math.min(b.level, 3)}`}>{inline(b.text, k)}</p>;
          case "ul":
            return <ul key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ul>;
          case "ol":
            return <ol key={k}>{b.items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</ol>;
          case "code":
            return <pre key={k} className="md__pre"><code>{b.code}</code></pre>;
          case "quote":
            return <blockquote key={k}>{inline(b.text, k)}</blockquote>;
        }
      })}
    </div>
  );
}
