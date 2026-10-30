/* LLM 答复的 Markdown 渲染：marked 解析 + DOMPurify 消毒（LLM 输出不可信，防 XSS）。
 * 只在消息定稿（sealed）后渲染；流式增量期间保持纯文本（半张表格无法解析）。 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre',
    'ul', 'ol', 'li', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'span',
  ],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
};

export function renderMarkdown(text: string): string {
  if (!text) return '';
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}
