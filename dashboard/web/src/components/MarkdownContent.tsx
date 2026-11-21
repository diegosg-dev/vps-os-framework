import { useState, type ReactNode } from "react";
import { CheckCircleIcon, CopyIcon } from "./Icons";

interface MarkdownContentProps {
  content: string;
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="my-2.5 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-inset)]">
      <div className="flex items-center justify-between border-b border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
        <span className="font-mono text-[10.5px] uppercase tracking-wider">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        >
          {copied ? (
            <>
              <CheckCircleIcon className="h-3 w-3 text-[var(--success)]" />
              <span className="text-[var(--success)]">Copied</span>
            </>
          ) : (
            <>
              <CopyIcon className="h-3 w-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-relaxed text-[var(--text-primary)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function isSafeHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenRegex =
    /(`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code
          key={key++}
          className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--accent)]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (linkMatch && isSafeHttpUrl(linkMatch[2]!)) {
        nodes.push(
          <a
            key={key++}
            href={linkMatch[2]}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-[var(--accent)] underline decoration-[var(--accent-border)] underline-offset-2 transition hover:decoration-[var(--accent)]"
          >
            {linkMatch[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={key++} className="font-semibold text-[var(--text-primary)]">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(
        <em key={key++} className="italic text-[var(--text-primary)]">
          {token.slice(1, -1)}
        </em>,
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes;
}

function splitTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Safe, zero-dependency Markdown renderer (never uses dangerouslySetInnerHTML).
 * Supports headings, lists, blockquotes, tables, horizontal rules, safe links,
 * inline formatting, and fenced code blocks.
 */
export function MarkdownContent({ content }: MarkdownContentProps) {
  const blocks: ReactNode[] = [];
  const lines = content.split(/\r?\n/);
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block
    const fenceMatch = line.match(/^```([a-zA-Z0-9_+-]*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      i++; // consume closing fence
      blocks.push(
        <CodeBlock key={blockKey++} language={lang} code={codeLines.join("\n")} />,
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push(
        <hr key={blockKey++} className="my-3 border-[var(--border-subtle)]" />,
      );
      i++;
      continue;
    }

    // Pipe Table
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] ?? "")
    ) {
      const headers = splitTableRow(line);
      i += 2; // skip header & separator
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        rows.push(splitTableRow(lines[i] ?? ""));
        i++;
      }
      blocks.push(
        <div
          key={blockKey++}
          className="my-2.5 overflow-x-auto rounded-xl border border-[var(--border-subtle)]"
        >
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--border-subtle)] bg-[var(--bg-inset)] text-[11px] font-semibold text-[var(--text-secondary)]">
                {headers.map((h, hIdx) => (
                  <th key={hIdx} className="px-3 py-2">
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {rows.map((cells, rIdx) => (
                <tr key={rIdx} className="hover:bg-[var(--bg-hover)]">
                  {headers.map((_, cIdx) => (
                    <td key={cIdx} className="px-3 py-2 text-[var(--text-primary)]">
                      {renderInline(cells[cIdx] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!;
      const cls =
        level === 1
          ? "mt-3.5 mb-1.5 text-base font-semibold text-[var(--text-primary)]"
          : level === 2
            ? "mt-3 mb-1 text-[14px] font-semibold text-[var(--text-primary)]"
            : "mt-2.5 mb-1 text-[13px] font-semibold text-[var(--text-primary)]";
      blocks.push(
        <div key={blockKey++} className={cls}>
          {renderInline(text)}
        </div>,
      );
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i] ?? "").startsWith("> ")) {
        quoteLines.push((lines[i] ?? "").slice(2));
        i++;
      }
      blocks.push(
        <blockquote
          key={blockKey++}
          className="my-2 rounded-r-lg border-l-2 border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-1.5 text-[12.5px] text-[var(--text-secondary)]"
        >
          {quoteLines.map((qLine, idx) => (
            <p key={idx}>{renderInline(qLine)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul
          key={blockKey++}
          className="my-1.5 list-disc space-y-1 pl-5 text-[13.5px] leading-relaxed text-[var(--text-primary)] marker:text-[var(--text-muted)]"
        >
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol
          key={blockKey++}
          className="my-1.5 list-decimal space-y-1 pl-5 text-[13.5px] leading-relaxed text-[var(--text-primary)] marker:text-[var(--text-muted)]"
        >
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() &&
      !(lines[i] ?? "").startsWith("```") &&
      !/^(#{1,3})\s+/.test(lines[i] ?? "") &&
      !(lines[i] ?? "").startsWith("> ") &&
      !/^\s*[-*]\s+/.test(lines[i] ?? "") &&
      !/^\s*\d+\.\s+/.test(lines[i] ?? "") &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test((lines[i] ?? "").trim())
    ) {
      paraLines.push(lines[i] ?? "");
      i++;
    }
    blocks.push(
      <p
        key={blockKey++}
        className="my-1.5 text-[13.5px] leading-relaxed text-[var(--text-primary)]"
      >
        {renderInline(paraLines.join(" "))}
      </p>,
    );
  }

  return <div className="space-y-0.5 break-words">{blocks}</div>;
}
