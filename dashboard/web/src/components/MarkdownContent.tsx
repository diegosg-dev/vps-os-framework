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
    <div className="my-2.5 overflow-hidden rounded-xl border border-white/[0.08] bg-[#0a0c12]">
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[11px] text-slate-400">
        <span className="font-mono uppercase tracking-wider text-slate-500">
          {language || "code"}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-400 transition hover:bg-white/[0.06] hover:text-slate-200"
        >
          {copied ? (
            <>
              <CheckCircleIcon className="h-3 w-3 text-emerald-400" />
              <span className="text-emerald-300">Copied</span>
            </>
          ) : (
            <>
              <CopyIcon className="h-3 w-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[12px] leading-relaxed text-slate-200">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenRegex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
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
          className="rounded-md border border-white/[0.08] bg-white/[0.05] px-1.5 py-0.5 font-mono text-[12px] text-sky-200"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong key={key++} className="font-semibold text-slate-100">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      nodes.push(
        <em key={key++} className="italic text-slate-200">
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

/**
 * Safe, zero-dependency Markdown renderer (never uses dangerouslySetInnerHTML).
 * Supports headings, lists, blockquotes, inline formatting, and fenced code blocks.
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

    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = headingMatch[2]!;
      const cls =
        level === 1
          ? "mt-3 mb-1.5 text-base font-semibold text-slate-100"
          : level === 2
            ? "mt-3 mb-1 text-[14px] font-semibold text-slate-100"
            : "mt-2.5 mb-1 text-[13px] font-semibold text-slate-200";
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
          className="my-2 border-l-2 border-sky-500/40 bg-sky-500/[0.04] px-3 py-1.5 text-[12.5px] text-slate-300"
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
          className="my-1.5 list-disc space-y-1 pl-5 text-[13.5px] leading-relaxed text-slate-200 marker:text-slate-500"
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
          className="my-1.5 list-decimal space-y-1 pl-5 text-[13.5px] leading-relaxed text-slate-200 marker:text-slate-500"
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
      !/^\s*\d+\.\s+/.test(lines[i] ?? "")
    ) {
      paraLines.push(lines[i] ?? "");
      i++;
    }
    blocks.push(
      <p
        key={blockKey++}
        className="my-1.5 text-[13.5px] leading-relaxed text-slate-200"
      >
        {renderInline(paraLines.join(" "))}
      </p>,
    );
  }

  return <div className="space-y-0.5 break-words">{blocks}</div>;
}
