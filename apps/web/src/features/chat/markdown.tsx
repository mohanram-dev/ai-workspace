"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { isValidElement, memo, useRef, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { useCopy } from "./use-copy";

function CodeBlock({ className, children, ...props }: ComponentProps<"pre">) {
  const preRef = useRef<HTMLPreElement>(null);
  const { copied, copy } = useCopy();
  const codeClassName =
    isValidElement<{ className?: string }>(children) ? (children.props.className ?? "") : "";
  const language = /language-([\w-]+)/.exec(codeClassName)?.[1];

  return (
    <div className="group/code relative my-3 overflow-hidden rounded-xl border bg-muted/40">
      <div className="flex h-9 items-center justify-between border-b bg-muted/60 px-3 text-xs text-muted-foreground">
        <span className="font-mono">{language ?? "text"}</span>
        <button
          type="button"
          onClick={() => copy(preRef.current?.textContent ?? "")}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-background hover:text-foreground"
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        ref={preRef}
        className={cn("scrollbar-thin overflow-x-auto p-4 font-mono text-[0.8125rem] leading-6", className)}
        {...props}
      >
        {children}
      </pre>
    </div>
  );
}

const components: Components = {
  pre: ({ node, ...props }) => <CodeBlock {...props} />,
  a: ({ node, href, children, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" {...props}>
      {children}
    </a>
  ),
  // External images are blocked by CSP and could be used for tracking; show them as links.
  img: ({ src, alt }) =>
    typeof src === "string" ? (
      <a href={src} target="_blank" rel="noopener noreferrer nofollow">
        {alt || "image"}
      </a>
    ) : null,
};

export const Markdown = memo(function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("markdown", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
