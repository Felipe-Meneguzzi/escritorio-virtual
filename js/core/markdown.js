// Markdown SEGURO (quadro de anotações, READMEs, resultados dos funcionários) — sem dependências. Estratégia "escapa primeiro, formata depois":
// todo texto do usuário passa por esc() ANTES de qualquer regex; as únicas tags da saída são as que este
// arquivo escreve; href só http(s)/mailto/#âncora. Não existe HTML cru nem <img> (pixel de rastreio/offline).
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);
const unesc = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

function safeHref(escapedUrl) {
  const raw = unesc(escapedUrl).trim();
  // remove controle/espaço que o navegador ignora ao interpretar o esquema ("java\tscript:")
  const probe = raw.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  if (/^(https?:\/\/|mailto:)/.test(probe) || /^#[\w-]*$/.test(probe)) return esc(raw);
  return null;
}

function inline(src) {
  // 1) separa os trechos de código (conteúdo literal), 2) escapa o resto, 3) formata
  return src.split(/(`[^`\n]+`)/).map((part, i) => {
    if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
    let s = esc(part);
    s = s.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, (m, text, url) => {
      const href = safeHref(url);
      return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${text}</a>` : text;
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]{3,300})/g, (m, pre, url) => {
      const href = safeHref(url);
      return href ? `${pre}<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>` : m;
    });
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
         .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
         .replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
         .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    return s;
  }).join('');
}

// checkboxes: data-line = nº da linha no fonte → o editor alterna "[ ]"/"[x]" no texto e salva (com etag)
export function renderMarkdown(text, { maxChars = 300000 } = {}) {
  const lines = String(text ?? '').slice(0, maxChars).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [], list = null, quote = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`); list = null; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`); quote = []; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/))) {                   // bloco de código
      flushAll();
      const fence = m[1], body = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*>/.test(line)) { flushPara(); flushList(); quote.push(line.replace(/^\s*>\s?/, '')); continue; }
    flushQuote();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/))) { flushAll(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }
    if ((m = line.match(/^\s*([-*+]|\d{1,6}[.)])\s+(.*)$/))) {
      flushPara();
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      const t = m[2].match(/^\[([ xX])\]\s+(.*)$/);
      list.items.push(t
        ? `<li class="task"><input type="checkbox" data-line="${i}"${t[1] !== ' ' ? ' checked' : ''}> ${inline(t[2])}</li>`
        : `<li>${inline(m[2])}</li>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] || '')) {   // tabela GFM simples
      flushAll();
      const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      const head = cells(line); i++;
      const rows = [];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
        rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (list) flushList();
    para.push(line);
  }
  flushAll();
  return out.join('\n');
}
