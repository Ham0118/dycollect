import { marked, type Token, type Tokens } from "marked";

export interface FeishuTextStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  inline_code?: boolean;
  link?: { url: string };
}

export interface FeishuTextElement {
  text_run: {
    content: string;
    text_element_style: FeishuTextStyle;
  };
}

export interface FeishuBlock {
  block_type: number;
  [key: string]: unknown;
}

export interface FeishuDocumentContent {
  title: string | null;
  blocks: FeishuBlock[];
}

const MAX_BLOCK_TEXT = 4_000;

export function markdownToFeishu(markdown: string): FeishuDocumentContent {
  const tokens = marked.lexer(markdown, { gfm: true });
  const blocks: FeishuBlock[] = [];
  let title: string | null = null;

  for (const token of tokens) {
    if (token.type === "space" || token.type === "def") continue;
    if (token.type === "heading") {
      if (token.depth === 1 && title === null) {
        title = plainText(token.tokens).trim() || token.text.trim() || null;
        continue;
      }
      blocks.push(...richBlocks(headingType(token.depth), inlineElements(token.tokens)));
      continue;
    }
    if (token.type === "paragraph") {
      blocks.push(...richBlocks("text", inlineElements(token.tokens)));
      continue;
    }
    if (token.type === "list") {
      blocks.push(...listBlocks(token as Tokens.List));
      continue;
    }
    if (token.type === "blockquote") {
      blocks.push(...richBlocks("quote", inlineElements(token.tokens)));
      continue;
    }
    if (token.type === "code") {
      blocks.push(...richBlocks("code", [textElement(token.text, { inline_code: false })]));
      continue;
    }
    if (token.type === "hr") {
      blocks.push({ block_type: 22, divider: {} });
      continue;
    }
    if (token.type === "table") {
      const table = token as Tokens.Table;
      const rows = [table.header, ...table.rows];
      for (const row of rows) {
        blocks.push(...richBlocks("text", [textElement(row.map((cell) => plainText(cell.tokens)).join(" | "))]));
      }
      continue;
    }

    const fallback = fallbackText(token);
    if (fallback) blocks.push(...richBlocks("text", [textElement(fallback)]));
  }

  return { title, blocks };
}

function listBlocks(list: Tokens.List): FeishuBlock[] {
  const type = list.ordered ? "ordered" : "bullet";
  const blocks: FeishuBlock[] = [];
  for (const item of list.items) {
    const inline = listItemElements(item);
    if (inline.length) blocks.push(...richBlocks(type, inline));
    for (const token of item.tokens) {
      if (token.type === "list") blocks.push(...listBlocks(token as Tokens.List));
    }
  }
  return blocks;
}

function listItemElements(item: Tokens.ListItem): FeishuTextElement[] {
  const elements: FeishuTextElement[] = [];
  for (const token of item.tokens) {
    if (token.type === "text" || token.type === "paragraph") {
      elements.push(...inlineElements(token.tokens ?? [token]));
    }
  }
  if (!elements.length && item.text) elements.push(textElement(item.text.replace(/\n+/g, " ").trim()));
  if (item.task) elements.unshift(textElement(item.checked ? "☑ " : "☐ "));
  return elements;
}

function inlineElements(tokens: Token[] | undefined, style: FeishuTextStyle = {}): FeishuTextElement[] {
  if (!tokens) return [];
  const elements: FeishuTextElement[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        if (token.tokens?.length) elements.push(...inlineElements(token.tokens, style));
        else if (token.text) elements.push(textElement(token.text, style));
        break;
      case "escape":
        elements.push(textElement(token.text, style));
        break;
      case "strong":
        elements.push(...inlineElements(token.tokens, { ...style, bold: true }));
        break;
      case "em":
        elements.push(...inlineElements(token.tokens, { ...style, italic: true }));
        break;
      case "del":
        elements.push(...inlineElements(token.tokens, { ...style, strikethrough: true }));
        break;
      case "codespan":
        elements.push(textElement(token.text, { ...style, inline_code: true }));
        break;
      case "link":
        elements.push(...inlineElements(token.tokens, { ...style, link: { url: encodeURI(token.href) } }));
        break;
      case "image":
        elements.push(textElement(`${token.text || "图片"}（${token.href}）`, style));
        break;
      case "br":
        elements.push(textElement("\n", style));
        break;
      case "paragraph":
      case "blockquote":
      case "heading":
        elements.push(...inlineElements(token.tokens, style));
        break;
      default: {
        const fallback = fallbackText(token);
        if (fallback) elements.push(textElement(fallback, style));
      }
    }
  }
  return elements;
}

function richBlocks(type: string, elements: FeishuTextElement[]): FeishuBlock[] {
  const normalized = splitElements(elements.filter((element) => element.text_run.content.length > 0));
  return normalized.map((part) => ({
    block_type: blockType(type),
    [type]: { elements: part, style: {} },
  }));
}

function splitElements(elements: FeishuTextElement[]): FeishuTextElement[][] {
  const result: FeishuTextElement[][] = [];
  let current: FeishuTextElement[] = [];
  let currentLength = 0;
  const flush = () => {
    if (current.length) result.push(current);
    current = [];
    currentLength = 0;
  };

  for (const element of elements) {
    let remaining = element.text_run.content;
    while (remaining.length) {
      if (currentLength >= MAX_BLOCK_TEXT) flush();
      const size = Math.min(MAX_BLOCK_TEXT - currentLength, remaining.length);
      current.push(textElement(remaining.slice(0, size), element.text_run.text_element_style));
      currentLength += size;
      remaining = remaining.slice(size);
    }
  }
  flush();
  return result;
}

function textElement(content: string, style: FeishuTextStyle = {}): FeishuTextElement {
  return { text_run: { content, text_element_style: style } };
}

function headingType(depth: number): string {
  return `heading${Math.min(9, Math.max(1, depth))}`;
}

function blockType(type: string): number {
  if (type === "text") return 2;
  if (type.startsWith("heading")) return 2 + Number(type.slice(7));
  if (type === "bullet") return 12;
  if (type === "ordered") return 13;
  if (type === "code") return 14;
  if (type === "quote") return 15;
  return 2;
}

function plainText(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  return tokens.map((token) => {
    if ("text" in token && typeof token.text === "string") return token.text;
    if (token.type === "br") return "\n";
    if ("tokens" in token && token.tokens) return plainText(token.tokens);
    return "";
  }).join("");
}

function fallbackText(token: Token): string {
  if ("text" in token && typeof token.text === "string") return token.text.trim();
  if ("tokens" in token && token.tokens) return plainText(token.tokens).trim();
  return token.raw.trim();
}
