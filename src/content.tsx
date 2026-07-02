import React from 'react';
import { createRoot } from 'react-dom/client';
import { htmlDiff } from '@benedicte/html-diff';
import styles from './styles.css?inline';

function injectStyles(): void {
  if (document.getElementById('jira-readable-diff-styles')) return;
  const style = document.createElement('style');
  style.id = 'jira-readable-diff-styles';
  style.textContent = styles;
  document.documentElement.append(style);
}

injectStyles();

const HISTORY_ITEM_SELECTOR = '[data-testid="issue-history.ui.history-items.generic-history-item.history-item"]';
const ENHANCED_ATTR = 'data-jira-readable-diff-enhanced';

type HistoryChange = {
  fieldName: string;
  before: string;
  after: string;
};

type AdfNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
};

function getReactProps(element: Element): Record<string, unknown> | undefined {
  const key = Object.keys(element).find((property) => property.startsWith('__reactProps$'));
  return key ? (element as unknown as Record<string, Record<string, unknown>>)[key] : undefined;
}

function findStringPair(value: unknown, seen = new WeakSet<object>()): [string, string] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  const record = value as Record<string, unknown>;
  const likelyOld = ['fromString', 'oldString', 'previousValue', 'from', 'oldValue'];
  const likelyNew = ['toString', 'newString', 'currentValue', 'to', 'newValue'];
  for (const oldKey of likelyOld) {
    for (const newKey of likelyNew) {
      if (typeof record[oldKey] === 'string' && typeof record[newKey] === 'string') {
        return [record[oldKey], record[newKey]];
      }
    }
  }

  for (const child of Object.values(record)) {
    const pair = findStringPair(child, seen);
    if (pair) return pair;
  }

  return undefined;
}

function textFromNode(element: Element): string {
  return element.textContent?.replace(/\u00a0/g, ' ').trim() ?? '';
}

function extractChange(item: HTMLElement): HistoryChange | undefined {
  const header = textFromNode(item);
  const fieldMatch = header.match(/updated the\s+([^\n]+?)(?:last|yesterday|today|\d|$)/i);
  const fieldName = fieldMatch?.[1]?.trim() ?? 'field';

  const props = getReactProps(item);
  const reactPair = findStringPair(props);
  if (reactPair && reactPair[0] !== reactPair[1]) {
    return { fieldName, before: reactPair[0], after: reactPair[1] };
  }

  const valueBlocks = Array.from(item.querySelectorAll('span')).filter((span) => {
    const text = textFromNode(span);
    return text.length > 80 && text.includes('\n');
  });
  if (valueBlocks.length >= 2) {
    return {
      fieldName,
      before: textFromNode(valueBlocks[valueBlocks.length - 2]),
      after: textFromNode(valueBlocks[valueBlocks.length - 1])
    };
  }

  return undefined;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
}

function inlineMarkup(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/\{\{([^]+?)\}\}/g, '<code>$1</code>');
  html = html.replace(/\*([^*\n][^\n]*?)\*/g, '<strong>$1</strong>');
  html = html.replace(/_([^_\n][^\n]*?)_/g, '<em>$1</em>');
  return html;
}

function jiraWikiToHtml(markup: string): string {
  const lines = markup.split(/\r?\n/);
  const html: string[] = [];
  let listDepth = 0;
  let orderedDepth = 0;

  const closeLists = () => {
    while (listDepth > 0) { html.push('</ul>'); listDepth -= 1; }
    while (orderedDepth > 0) { html.push('</ol>'); orderedDepth -= 1; }
  };

  for (const line of lines) {
    const heading = line.match(/^h([1-6])\.\s+(.*)$/);
    if (heading) {
      closeLists();
      html.push(`<h${heading[1]}>${inlineMarkup(heading[2])}</h${heading[1]}>`);
      continue;
    }

    const bullet = line.match(/^(\*+)\s+(.*)$/);
    const numbered = line.match(/^(#+)\s+(.*)$/);
    if (bullet || numbered) {
      const marker = bullet?.[1] ?? numbered?.[1] ?? '';
      const targetDepth = marker.length;
      const isOrdered = Boolean(numbered);
      const currentDepth = isOrdered ? orderedDepth : listDepth;
      const tag = isOrdered ? 'ol' : 'ul';
      while ((isOrdered ? orderedDepth : listDepth) < targetDepth) { html.push(`<${tag}>`); isOrdered ? orderedDepth++ : listDepth++; }
      while ((isOrdered ? orderedDepth : listDepth) > targetDepth) { html.push(`</${tag}>`); isOrdered ? orderedDepth-- : listDepth--; }
      html.push(`<li>${inlineMarkup(bullet?.[2] ?? numbered?.[2] ?? '')}</li>`);
      continue;
    }

    closeLists();
    if (line.trim()) html.push(`<p>${inlineMarkup(line)}</p>`);
  }
  closeLists();
  return html.join('');
}

function adfToHtml(node: AdfNode): string {
  const children = () => node.content?.map(adfToHtml).join('') ?? '';
  if (node.type === 'doc') return children();
  if (node.type === 'paragraph') return `<p>${children()}</p>`;
  if (node.type === 'heading') return `<h${Number(node.attrs?.level) || 2}>${children()}</h${Number(node.attrs?.level) || 2}>`;
  if (node.type === 'bulletList') return `<ul>${children()}</ul>`;
  if (node.type === 'orderedList') return `<ol>${children()}</ol>`;
  if (node.type === 'listItem') return `<li>${children()}</li>`;
  if (node.type === 'hardBreak') return '<br>';
  if (node.type === 'text') return applyMarks(escapeHtml(node.text ?? ''), node.marks ?? []);
  return children();
}

function applyMarks(html: string, marks: NonNullable<AdfNode['marks']>): string {
  return marks.reduce((value, mark) => mark.type === 'strong' ? `<strong>${value}</strong>` : mark.type === 'em' ? `<em>${value}</em>` : mark.type === 'code' ? `<code>${value}</code>` : value, html);
}

function renderValue(value: string): string {
  try {
    const parsed = JSON.parse(value) as AdfNode;
    if (parsed?.type === 'doc') return adfToHtml(parsed);
  } catch {
    // Not JSON ADF; Jira history often exposes wiki markup or plain text.
  }
  return jiraWikiToHtml(value);
}

function DiffView({ change }: { change: HistoryChange }) {
  const beforeHtml = renderValue(change.before);
  const afterHtml = renderValue(change.after);
  const diff = htmlDiff(beforeHtml, afterHtml);
  return (
    <section className="jrd-card" aria-label={`Readable diff for ${change.fieldName}`}>
      <div className="jrd-title">Readable {change.fieldName} diff</div>
      <div className="jrd-diff" dangerouslySetInnerHTML={{ __html: diff }} />
    </section>
  );
}

function enhance(item: HTMLElement): void {
  if (item.hasAttribute(ENHANCED_ATTR)) return;
  const change = extractChange(item);
  if (!change) return;
  item.setAttribute(ENHANCED_ATTR, 'true');
  const host = document.createElement('div');
  host.className = 'jrd-host';
  item.append(host);
  createRoot(host).render(<DiffView change={change} />);
}

function scan(): void {
  document.querySelectorAll<HTMLElement>(HISTORY_ITEM_SELECTOR).forEach(enhance);
}

const observer = new MutationObserver(() => scan());
observer.observe(document.body, { childList: true, subtree: true });
scan();
