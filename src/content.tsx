import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
const HISTORY_TAB_SELECTOR = '[data-testid="issue-activity-feed.ui.buttons.History"]';
const SORT_BUTTON_SELECTOR = '[data-testid="issue-activity-feed.ui.activity-sorting-toggle.sorting-button"]';
const ENHANCED_ATTR = 'data-jira-readable-diff-enhanced';
const EMPTY_VALUE_TOKENS = new Set(['none', 'no value', 'empty']);

type HistoryChange = {
  fieldName: string;
  before: string;
  after: string;
  originalElements: HTMLElement[];
};

type AdfNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
};

type ListTag = 'ul' | 'ol';
type EnhancedItem = {
  change: HistoryChange;
  diffHost: HTMLElement;
  diffRoot: Root;
};

const enhancedItems = new Map<HTMLElement, EnhancedItem>();
let showReadableDiff = false;
let toggleHost: HTMLElement | null = null;
let toggleRoot: Root | null = null;

function getReactProps(element: Element): Record<string, unknown> | undefined {
  const key = Object.keys(element).find((property) => property.startsWith('__reactProps$'));
  return key ? (element as unknown as Record<string, Record<string, unknown>>)[key] : undefined;
}

function isEmptyValueText(text: string): boolean {
  return EMPTY_VALUE_TOKENS.has(text.trim().toLowerCase());
}

function normalizeExtractedValue(value: string): string {
  return isEmptyValueText(value) ? '' : value;
}

function maybeExtractValue(value: unknown): string | undefined {
  if (typeof value === 'string') return normalizeExtractedValue(value);
  if (value == null) return '';
  return undefined;
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
      const oldValue = maybeExtractValue(record[oldKey]);
      const newValue = maybeExtractValue(record[newKey]);
      if (oldValue !== undefined && newValue !== undefined) {
        return [oldValue, newValue];
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

function findValueBlocks(item: HTMLElement): HTMLElement[] {
  const isLikelyValueBlock = (element: HTMLElement): boolean => {
    const text = textFromNode(element);
    return (
      !element.closest('.jrd-toggle-host, .jrd-diff-host') &&
      ((text.length > 80 && text.includes('\n')) || isEmptyValueText(text))
    );
  };

  const spans = Array.from(item.querySelectorAll<HTMLElement>('span')).filter(isLikelyValueBlock);
  if (spans.length >= 2) return spans;

  return Array.from(item.querySelectorAll<HTMLElement>('div, p')).filter(isLikelyValueBlock);
}

function findOriginalElements(valueBlocks: HTMLElement[]): HTMLElement[] {
  const pair = valueBlocks.slice(-2);
  if (pair.length < 2) return pair;

  const [beforeElement, afterElement] = pair;
  const originalElements: HTMLElement[] = [beforeElement];

  if (beforeElement.parentElement && beforeElement.parentElement === afterElement.parentElement) {
    let sibling = beforeElement.nextElementSibling;
    while (sibling && sibling !== afterElement) {
      if (sibling instanceof HTMLElement) originalElements.push(sibling);
      sibling = sibling.nextElementSibling;
    }
  }

  originalElements.push(afterElement);
  return originalElements;
}

function extractChange(item: HTMLElement): HistoryChange | undefined {
  const header = textFromNode(item);
  const fieldMatch = header.match(/updated the\s+([^\n]+?)(?:last|yesterday|today|\d|$)/i);
  const fieldName = fieldMatch?.[1]?.trim() ?? 'field';
  const valueBlocks = findValueBlocks(item);
  const originalElements = findOriginalElements(valueBlocks);

  const props = getReactProps(item);
  const reactPair = findStringPair(props);
  if (reactPair && reactPair[0] !== reactPair[1]) {
    return { fieldName, before: reactPair[0], after: reactPair[1], originalElements };
  }

  if (valueBlocks.length >= 2) {
    return {
      fieldName,
      before: normalizeExtractedValue(textFromNode(valueBlocks[valueBlocks.length - 2])),
      after: normalizeExtractedValue(textFromNode(valueBlocks[valueBlocks.length - 1])),
      originalElements
    };
  }

  return undefined;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
}

function sanitizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.origin);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function anchorHtml(label: string, url: string): string {
  const safeUrl = sanitizeUrl(url);
  if (!safeUrl) return label;
  return `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noreferrer noopener">${label}</a>`;
}

function replaceWithPlaceholders(
  input: string,
  pattern: RegExp,
  replacer: (...args: string[]) => string
): { text: string; placeholders: Map<string, string> } {
  const placeholders = new Map<string, string>();
  let index = 0;

  const text = input.replace(pattern, (...args) => {
    const token = `__JRD_PLACEHOLDER_${index}__`;
    index += 1;
    placeholders.set(token, replacer(...(args.slice(1, -2) as string[])));
    return token;
  });

  return { text, placeholders };
}

function restorePlaceholders(text: string, placeholders: Map<string, string>): string {
  return Array.from(placeholders.entries()).reduce(
    (value, [token, replacement]) => value.replaceAll(token, replacement),
    text
  );
}

function inlineMarkup(text: string): string {
  let html = escapeHtml(text);
  const placeholderGroups: Map<string, string>[] = [];

  const jiraLinks = replaceWithPlaceholders(
    html,
    /\[([^\]\n|]+)\|((?:https?:\/\/|mailto:)[^\]\s]+)\]/g,
    (label, url) => anchorHtml(label, url)
  );
  html = jiraLinks.text;
  placeholderGroups.push(jiraLinks.placeholders);

  const markdownLinks = replaceWithPlaceholders(
    html,
    /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g,
    (label, url) => anchorHtml(label, url)
  );
  html = markdownLinks.text;
  placeholderGroups.push(markdownLinks.placeholders);

  const bareLinks = replaceWithPlaceholders(
    html,
    /(^|[\s(>])((?:https?:\/\/|mailto:)[^\s<]+)/g,
    (prefix, url) => `${prefix}${anchorHtml(url, url)}`
  );
  html = bareLinks.text;
  placeholderGroups.push(bareLinks.placeholders);

  html = html.replace(/\{\{([^]+?)\}\}/g, '<code>$1</code>');
  html = html.replace(/\*([^*\n][^\n]*?)\*/g, '<strong>$1</strong>');
  html = html.replace(/_([^_\n][^\n]*?)_/g, '<em>$1</em>');
  for (const placeholders of placeholderGroups) {
    html = restorePlaceholders(html, placeholders);
  }
  return html;
}

function renderListItem(content: string, listType: ListTag): string {
  return `<li data-jrd-list-type="${listType}">${content}</li>`;
}

function jiraWikiToHtml(markup: string): string {
  const lines = markup.split(/\r?\n/);
  const html: string[] = [];
  const listStack: { tag: ListTag; itemOpen: boolean }[] = [];

  const closeOpenItem = () => {
    const frame = listStack[listStack.length - 1];
    if (frame?.itemOpen) {
      html.push('</li>');
      frame.itemOpen = false;
    }
  };

  const closeListsToDepth = (targetDepth: number) => {
    while (listStack.length > targetDepth) {
      closeOpenItem();
      const frame = listStack.pop();
      if (frame) html.push(`</${frame.tag}>`);
    }
  };

  for (const line of lines) {
    const heading = line.match(/^h([1-6])\.\s+(.*)$/);
    if (heading) {
      closeListsToDepth(0);
      html.push(`<h${heading[1]}>${inlineMarkup(heading[2])}</h${heading[1]}>`);
      continue;
    }

    const listLine = line.match(/^([*#]+)\s+(.*)$/);
    if (listLine) {
      const markers = Array.from(listLine[1], (marker) => marker === '#' ? 'ol' : 'ul');
      let commonDepth = 0;
      while (
        commonDepth < listStack.length &&
        commonDepth < markers.length &&
        listStack[commonDepth].tag === markers[commonDepth]
      ) {
        commonDepth += 1;
      }

      closeListsToDepth(commonDepth);

      if (listStack.length === markers.length && commonDepth === markers.length) {
        closeOpenItem();
      }

      for (let index = commonDepth; index < markers.length; index += 1) {
        html.push(`<${markers[index]}>`);
        listStack.push({ tag: markers[index], itemOpen: false });
      }

      const currentList = listStack[listStack.length - 1];
      const itemHtml = inlineMarkup(listLine[2]);
      html.push(renderListItem(itemHtml, currentList?.tag ?? 'ul'));
      if (currentList) currentList.itemOpen = true;
      continue;
    }

    closeListsToDepth(0);
    if (line.trim()) html.push(`<p>${inlineMarkup(line)}</p>`);
  }
  closeListsToDepth(0);
  return html.join('');
}

function adfToHtml(node: AdfNode, activeListType?: ListTag): string {
  const children = (nextListType = activeListType) => node.content?.map((child) => adfToHtml(child, nextListType)).join('') ?? '';
  if (node.type === 'doc') return children();
  if (node.type === 'paragraph') return `<p>${children()}</p>`;
  if (node.type === 'heading') return `<h${Number(node.attrs?.level) || 2}>${children()}</h${Number(node.attrs?.level) || 2}>`;
  if (node.type === 'bulletList') return `<ul>${children('ul')}</ul>`;
  if (node.type === 'orderedList') return `<ol>${children('ol')}</ol>`;
  if (node.type === 'listItem') return renderListItem(children(), activeListType ?? 'ul');
  if (node.type === 'hardBreak') return '<br>';
  if (node.type === 'text') return applyMarks(escapeHtml(node.text ?? ''), node.marks ?? []);
  return children();
}

function applyMarks(html: string, marks: NonNullable<AdfNode['marks']>): string {
  return marks.reduce((value, mark) => {
    if (mark.type === 'strong') return `<strong>${value}</strong>`;
    if (mark.type === 'em') return `<em>${value}</em>`;
    if (mark.type === 'code') return `<code>${value}</code>`;
    if (mark.type === 'link' && typeof mark.attrs?.href === 'string') {
      return anchorHtml(value, mark.attrs.href);
    }
    return value;
  }, html);
}

function renderValue(value: string): string {
  if (!value.trim()) return '';
  try {
    const parsed = JSON.parse(value) as AdfNode;
    if (parsed?.type === 'doc') return adfToHtml(parsed);
  } catch {
    // Not JSON ADF; Jira history often exposes wiki markup or plain text.
  }
  return jiraWikiToHtml(value);
}

function normalizeListMarkup(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;

  let changed = true;
  while (changed) {
    changed = false;

    for (const list of Array.from(template.content.querySelectorAll('ul, ol'))) {
      for (const child of Array.from(list.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.tagName !== 'UL' && child.tagName !== 'OL') continue;

        const previousItem = child.previousElementSibling;
        if (previousItem?.tagName === 'LI') {
          previousItem.append(child);
          changed = true;
          continue;
        }

        const listItem = document.createElement('li');
        listItem.dataset.jrdListType = list.tagName.toLowerCase();
        list.insertBefore(listItem, child);
        listItem.append(child);
        changed = true;
      }
    }

    const orphanItems = Array.from(template.content.querySelectorAll('li')).filter((item) => {
      const parentTag = item.parentElement?.tagName;
      return parentTag !== 'UL' && parentTag !== 'OL';
    });

    for (const item of orphanItems) {
      const parent = item.parentElement;
      if (!parent) continue;

      const listTag = item.dataset.jrdListType === 'ol' ? 'ol' : 'ul';
      const wrapper = document.createElement(listTag);
      parent.insertBefore(wrapper, item);

      let cursor: ChildNode | null = item;
      while (cursor && cursor.parentNode === parent) {
        const next: ChildNode | null = cursor.nextSibling;
        if (cursor instanceof HTMLLIElement) {
          wrapper.append(cursor);
          cursor = next;
          continue;
        }

        if (cursor.nodeType === Node.TEXT_NODE && !cursor.textContent?.trim()) {
          wrapper.append(cursor);
          cursor = next;
          continue;
        }

        break;
      }

      changed = true;
    }
  }

  return template.innerHTML;
}

function toggleOriginalElements(elements: HTMLElement[], hidden: boolean): void {
  elements.forEach((element) => {
    element.classList.toggle('jrd-hidden-original', hidden);
  });
}

function findCommonAncestor(elements: HTMLElement[]): HTMLElement | null {
  const [first, ...rest] = elements;
  if (!first) return null;

  let current: HTMLElement | null = first;
  while (current) {
    if (rest.every((element) => current?.contains(element))) return current;
    current = current.parentElement;
  }

  return null;
}

function findDiffMount(item: HTMLElement, originalElements: HTMLElement[]): HTMLElement {
  const commonAncestor = findCommonAncestor(originalElements);
  if (commonAncestor && item.contains(commonAncestor)) return commonAncestor;
  return originalElements[0]?.parentElement ?? item;
}

function findGlobalToggleMount(): HTMLElement | null {
  const sortButton = document.querySelector<HTMLElement>(SORT_BUTTON_SELECTOR);
  if (!sortButton) return null;

  const presentationWrapper = sortButton.closest<HTMLElement>('[role="presentation"]');
  if (presentationWrapper?.parentElement) return presentationWrapper.parentElement;

  if (sortButton.parentElement?.parentElement) return sortButton.parentElement.parentElement;
  return sortButton.parentElement ?? sortButton;
}

function isHistoryTabActive(): boolean {
  const historyTab = document.querySelector<HTMLElement>(HISTORY_TAB_SELECTOR);
  return historyTab?.getAttribute('aria-checked') === 'true';
}

function ToggleView({ showReadable, onToggle }: { showReadable: boolean; onToggle: (value: boolean) => void }) {
  return (
    <div className="jrd-toolbar">
      <label className="jrd-toggle">
        <span className="jrd-toggle-label">Readable diff</span>
        <input
          type="checkbox"
          checked={showReadable}
          onChange={(event) => onToggle(event.target.checked)}
        />
        <span className="jrd-toggle-track" aria-hidden="true">
          <span className="jrd-toggle-thumb" />
        </span>
      </label>
    </div>
  );
}

function DiffView({ change }: { change: HistoryChange }) {
  const beforeHtml = renderValue(change.before);
  const afterHtml = renderValue(change.after);
  const diff = normalizeListMarkup(htmlDiff(beforeHtml, afterHtml));

  return (
    <section className="jrd-shell" aria-label={`Readable diff for ${change.fieldName}`}>
      <div className="jrd-diff" dangerouslySetInnerHTML={{ __html: diff }} />
    </section>
  );
}

function renderEnhancedItem(item: HTMLElement, enhanced: EnhancedItem): void {
  toggleOriginalElements(enhanced.change.originalElements, showReadableDiff);
  enhanced.diffRoot.render(showReadableDiff ? <DiffView change={enhanced.change} /> : null);
  item.classList.toggle('jrd-readable-diff-active', showReadableDiff);
}

function renderAllEnhancedItems(): void {
  for (const [item, enhanced] of enhancedItems) {
    if (!document.contains(item) || !document.contains(enhanced.diffHost)) {
      enhanced.diffRoot.unmount();
      enhancedItems.delete(item);
      continue;
    }

    renderEnhancedItem(item, enhanced);
  }
}

function renderGlobalToggle(): void {
  toggleRoot?.render(
    <ToggleView
      showReadable={showReadableDiff}
      onToggle={(value) => {
        showReadableDiff = value;
        renderGlobalToggle();
        renderAllEnhancedItems();
      }}
    />
  );
}

function removeGlobalToggle(): void {
  toggleRoot?.unmount();
  toggleRoot = null;

  if (toggleHost?.parentElement) {
    toggleHost.parentElement.classList.remove('jrd-global-toggle-mount');
  }

  toggleHost?.remove();
  toggleHost = null;
}

function ensureGlobalToggle(): void {
  if (!isHistoryTabActive()) {
    removeGlobalToggle();
    return;
  }

  const mount = findGlobalToggleMount();
  if (!mount) {
    removeGlobalToggle();
    return;
  }

  mount.classList.add('jrd-global-toggle-mount');

  if (toggleHost && toggleRoot && toggleHost.parentElement === mount) {
    renderGlobalToggle();
    return;
  }

  if (toggleRoot) {
    toggleRoot.unmount();
    toggleRoot = null;
  }

  toggleHost?.remove();

  toggleHost = document.createElement('div');
  toggleHost.className = 'jrd-global-toggle-host';
  mount.append(toggleHost);
  toggleRoot = createRoot(toggleHost);
  renderGlobalToggle();
}

function enhance(item: HTMLElement): void {
  if (enhancedItems.has(item) || item.hasAttribute(ENHANCED_ATTR)) return;
  const change = extractChange(item);
  if (!change) return;
  item.setAttribute(ENHANCED_ATTR, 'true');

  const diffMount = findDiffMount(item, change.originalElements);
  const diffHost = document.createElement('div');
  diffHost.className = 'jrd-diff-host';
  diffMount.prepend(diffHost);

  const diffRoot = createRoot(diffHost);
  const enhanced = { change, diffHost, diffRoot };
  enhancedItems.set(item, enhanced);
  renderEnhancedItem(item, enhanced);
}

function scan(): void {
  ensureGlobalToggle();
  document.querySelectorAll<HTMLElement>(HISTORY_ITEM_SELECTOR).forEach(enhance);
}

const observer = new MutationObserver(() => scan());
observer.observe(document.body, { childList: true, subtree: true });
scan();
