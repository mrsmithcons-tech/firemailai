const TAGS = new Set('p div span br hr b strong i em u s small blockquote pre code h1 h2 h3 h4 h5 h6 ul ol li table thead tbody tfoot tr th td a img center'.split(' '));
const DROP = new Set('script style iframe object embed form input button textarea select option svg math link meta base template noscript'.split(' '));
const STYLES = new Set('color background-color font-family font-size font-weight font-style line-height text-align text-decoration white-space word-break overflow-wrap border border-width border-style border-color border-collapse border-spacing border-radius padding padding-top padding-right padding-bottom padding-left margin margin-top margin-right margin-bottom margin-left width height min-width max-width min-height max-height display vertical-align'.split(' '));
export function safeEmailURL(raw, { image = false, allowRemote = false } = {}) {
  if (typeof raw !== 'string' || /[\x00-\x1f\x7f]/.test(raw)) return null;
  const value = raw.trim();
  if (image && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+$/i.test(value) && value.length <= 1500000) return value;
  if (!/^https?:\/\//i.test(value) && !(value.startsWith('mailto:') && !image)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:', ...(!image ? ['mailto:'] : [])].includes(url.protocol)) return null;
    if (image && !allowRemote) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
export function safeStyleValue(property, value) {
  return STYLES.has(property) && typeof value === 'string' && value.length < 200 && !/url\s*\(|expression\s*\(|@|\\|[<>]/i.test(value) && /^[a-zA-Z0-9\s#.,()%+\-_:!"']+$/.test(value);
}
export function sanitizeEmailHTML(html, { allowRemote = false, inlineImages = {} } = {}) {
  // Template contents are inert: do not parse raw mail into a resource-loading document.
  const source = document.createElement('template');
  source.innerHTML = String(html || '');
  const target = document.createElement('div');
  const links = new Map(); let nodes = 0, remoteImages = false;
  function copy(node, parent) {
    if (++nodes > 15000) return;
    if (node.nodeType === Node.TEXT_NODE) { parent.appendChild(document.createTextNode(node.textContent)); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (DROP.has(tag)) return;
    if (!TAGS.has(tag)) { for (const child of node.childNodes) copy(child, parent); return; }
    const clean = document.createElement(tag);
    if (node.style) {
      for (let i = 0; i < node.style.length; i++) {
        const property = node.style[i];
        const value = node.style.getPropertyValue(property);
        if (safeStyleValue(property, value)) clean.style.setProperty(property, value);
      }
    }
    for (const attribute of ['colspan', 'rowspan', 'width', 'height', 'border', 'cellpadding', 'cellspacing']) {
      const value = node.getAttribute(attribute);
      if (value && /^\d{1,4}%?$/.test(value)) clean.setAttribute(attribute, value);
    }
    if (tag === 'a') {
      const href = safeEmailURL(node.getAttribute('href'));
      if (href) { clean.setAttribute('href', href); clean.setAttribute('target', '_blank'); clean.setAttribute('rel', 'noopener noreferrer'); links.set(href, (node.textContent || new URL(href).hostname).trim().slice(0, 120)); }
    }
    if (tag === 'img') {
      let src = node.getAttribute('src') || '';
      if (/^cid:/i.test(src)) src = inlineImages[src.slice(4).replace(/[<>]/g, '')] || '';
      if (/^https?:/i.test(src)) remoteImages = true;
      const allowed = safeEmailURL(src, { image: true, allowRemote });
      if (allowed) clean.src = allowed;
      clean.alt = String(node.getAttribute('alt') || (allowed ? '' : 'Image blocked')).slice(0, 180);
      clean.style.maxWidth = '100%'; clean.style.height = 'auto'; clean.referrerPolicy = 'no-referrer';
    }
    parent.appendChild(clean);
    for (const child of node.childNodes) copy(child, clean);
  }
  for (const node of source.content.childNodes) copy(node, target);
  const policy = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:${allowRemote ? ' https: http:' : ''}; font-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>body{margin:0;color:#28352c;font:13px/1.8 Arial,sans-serif;overflow-wrap:anywhere}img{max-width:100%}table{max-width:100%}a{color:#507445}pre{white-space:pre-wrap}</style></head><body>${target.innerHTML}</body></html>`;
  return { srcdoc, links: [...links].map(([href, text]) => ({ href, text })), remoteImages, limited: nodes > 15000 };
}
export function emailPlainText(html) {
  const template = document.createElement('template'); template.innerHTML = String(html || '');
  template.content.querySelectorAll([...DROP].join(',')).forEach(node => node.remove());
  return template.content.textContent || '';
}
