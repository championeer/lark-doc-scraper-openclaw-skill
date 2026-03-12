#!/usr/bin/env node

/**
 * Scrape a Feishu/Lark docx via the client_vars API and convert to Markdown.
 *
 * This version is much more reliable than DOM innerText scraping because it
 * reads the structured block data used by the docx frontend.
 *
 * Usage:
 *   node scripts/scrape_lark_doc_api.js <doc-url-or-token> [output-dir]
 *
 * Examples:
 *   node scripts/scrape_lark_doc_api.js \
 *     "https://bytedance.larkoffice.com/docx/MFK7dDFLFoVlOGxWCv5cTXKmnMh" \
 *     ./output/lark-doc-api
 *
 * Optional env:
 *   HEADLESS=false
 *   STORAGE_STATE=state.json   # Playwright storage state for private docs
 */

const fs = require('fs');
const path = require('path');

async function main() {
  const { chromium } = require('playwright');

  const input = process.argv[2];
  const outDir = path.resolve(process.argv[3] || './output/lark-doc-api');
  if (!input) {
    console.error('Usage: node scripts/scrape_lark_doc_api.js <doc-url-or-token> [output-dir]');
    process.exit(1);
  }

  const { token, url } = parseInput(input);
  fs.mkdirSync(outDir, { recursive: true });

  const headless = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';
  const storageState = process.env.STORAGE_STATE;

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext(storageState ? { storageState } : {});
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
  await page.waitForTimeout(2500);

  const metaResp = await page.evaluate(async (token) => {
    const r = await fetch(`/space/api/meta/?token=${token}&type=22&need_extra_fields=3`, { credentials: 'include' });
    return await r.json();
  }, token);

  const meta = metaResp && metaResp.data ? metaResp.data : {};
  const title = meta.title || token;
  const docDir = path.join(outDir, safeSlug(title));
  fs.mkdirSync(docDir, { recursive: true });

  const allBlocks = new Map();
  const allOrder = [];
  let cursor = null;
  let pageCount = 0;

  while (true) {
    const payload = await page.evaluate(async ({ token, cursor }) => {
      const params = new URLSearchParams({ id: token, mode: '7', limit: '239' });
      if (cursor) params.set('cursor', cursor);
      const r = await fetch(`/space/api/docx/pages/client_vars?${params.toString()}`, { credentials: 'include' });
      const j = await r.json();
      return j;
    }, { token, cursor });

    if (!payload || payload.code !== 0 || !payload.data) {
      throw new Error(`client_vars fetch failed at page ${pageCount + 1}: ${JSON.stringify(payload).slice(0, 400)}`);
    }

    pageCount += 1;
    const data = payload.data;

    for (const id of data.block_sequence || []) allOrder.push(id);
    for (const [id, block] of Object.entries(data.block_map || {})) allBlocks.set(id, block);

    if (data.has_more && Array.isArray(data.next_cursors) && data.next_cursors.length > 0) {
      cursor = data.next_cursors[0];
    } else {
      break;
    }
  }

  const rootId = token;
  const dedupOrder = [...new Set(allOrder)];
  const rootChildren = dedupOrder.filter(id => {
    const b = allBlocks.get(id);
    return b && b.data && b.data.parent_id === rootId;
  });

  const ctx = { blocks: allBlocks, images: [], files: [] };

  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`- 原文链接: ${url}`);
  lines.push(`- 抓取方式: client_vars API`);
  lines.push(`- 抓取时间: ${new Date().toISOString()}`);
  lines.push(`- 抓取页数: ${pageCount}`);
  lines.push('');

  for (const id of rootChildren) renderBlock(id, ctx, lines, 0);

  await downloadAssets(page, ctx, docDir);

  const markdown = cleanupMarkdown(lines.join('\n'));
  const prefix = path.join(docDir, safeSlug(title));

  fs.writeFileSync(`${prefix}.md`, markdown, 'utf8');
  fs.writeFileSync(`${prefix}.raw.blocks.json`, JSON.stringify(Object.fromEntries(allBlocks), null, 2), 'utf8');
  fs.writeFileSync(`${prefix}.order.json`, JSON.stringify(dedupOrder, null, 2), 'utf8');
  fs.writeFileSync(`${prefix}.meta.json`, JSON.stringify({ title, url, token, pageCount, scrapedAt: new Date().toISOString(), images: ctx.images, files: ctx.files }, null, 2), 'utf8');

  console.log(JSON.stringify({ ok: true, title, token, pageCount, outDir: docDir }, null, 2));

  await context.close();
  await browser.close();
}

function parseInput(input) {
  const s = String(input).trim();
  const m = s.match(/\/docx\/([A-Za-z0-9]+)/);
  const token = m ? m[1] : s;
  const url = m ? s : `https://bytedance.larkoffice.com/docx/${token}`;
  return { token, url };
}

function renderBlock(id, ctx, lines, depth) {
  const block = ctx.blocks.get(id);
  if (!block || !block.data) return;
  const data = block.data;
  const type = data.type;

  switch (type) {
    case 'heading1':
    case 'heading2':
    case 'heading3':
    case 'heading4':
    case 'heading5':
    case 'heading6': {
      const level = Number(type.replace('heading', '')) || 1;
      const text = extractText(data.text).trim();
      if (text) {
        lines.push('');
        lines.push(`${'#'.repeat(level)} ${text}`);
        lines.push('');
      }
      renderChildren(data.children, ctx, lines, depth + 1);
      return;
    }
    case 'text': {
      const text = extractText(data.text).trim();
      if (text) {
        lines.push(text);
        lines.push('');
      }
      renderChildren(data.children, ctx, lines, depth + 1);
      return;
    }
    case 'bullet': {
      const text = extractText(data.text).trim();
      if (text) lines.push(`${'  '.repeat(depth)}- ${text}`);
      renderChildren(data.children, ctx, lines, depth + 1);
      if (depth === 0) lines.push('');
      return;
    }
    case 'ordered': {
      const seq = data.seq && data.seq !== 'auto' ? data.seq : '1';
      const text = extractText(data.text).trim();
      if (text) lines.push(`${'  '.repeat(depth)}${seq}. ${text}`);
      renderChildren(data.children, ctx, lines, depth + 1);
      if (depth === 0) lines.push('');
      return;
    }
    case 'code': {
      lines.push('');
      lines.push('```' + normalizeCodeLang(data.language || ''));
      lines.push(extractText(data.text, { preserveNewlines: true }));
      lines.push('```');
      lines.push('');
      return;
    }
    case 'callout':
    case 'quote_container': {
      const childLines = [];
      renderChildren(data.children, ctx, childLines, depth + 1);
      const cleaned = childLines.join('\n').trim();
      if (cleaned) {
        lines.push('');
        for (const line of cleaned.split('\n')) lines.push(`> ${line}`);
        lines.push('');
      }
      return;
    }
    case 'divider': {
      lines.push('');
      lines.push('---');
      lines.push('');
      return;
    }
    case 'image': {
      const img = data.image || {};
      const name = img.name || 'image';
      const token = img.token || '';
      const ext = extFromMimeOrName(img.mimeType, name, '.bin');
      const fileName = `images/${safeFileBase(name || token || 'image')}-${token.slice(0,8)}${ext}`;
      ctx.images.push({ token, name, mimeType: img.mimeType || '', fileName });
      lines.push(`![${escapeMd(name)}](${encodeURI(fileName)})`);
      lines.push('');
      return;
    }
    case 'file': {
      const file = data.file || {};
      const name = file.name || 'file';
      const token = file.token || '';
      const ext = extFromMimeOrName(file.mimeType, name, '.bin');
      const fileName = `files/${safeFileBase(name || token || 'file')}-${token.slice(0,8)}${ext}`;
      ctx.files.push({ token, name, mimeType: file.mimeType || '', fileName });
      lines.push(`[附件: ${escapeMd(name)}](${encodeURI(fileName)})`);
      lines.push('');
      return;
    }
    case 'table': {
      renderTable(block, ctx, lines);
      lines.push('');
      return;
    }
    case 'grid':
    case 'grid_column':
    case 'table_cell':
      renderChildren(data.children, ctx, lines, depth);
      return;
    case 'chat_card':
      lines.push(`[聊天卡片: ${data.chat_id || data.chat_token || block.id}]`);
      lines.push('');
      return;
    default: {
      const text = extractText(data.text).trim();
      if (text) {
        lines.push(text);
        lines.push('');
      } else if (Array.isArray(data.children) && data.children.length) {
        renderChildren(data.children, ctx, lines, depth + 1);
      }
    }
  }
}

function renderChildren(children, ctx, lines, depth) {
  for (const childId of children || []) renderBlock(childId, ctx, lines, depth);
}

function renderTable(block, ctx, lines) {
  const data = block.data || {};
  const rows = data.rows_id || [];
  const cols = data.columns_id || [];
  const cellSet = data.cell_set || {};
  if (!rows.length || !cols.length) return;
  const matrix = rows.map(rowId => cols.map(colId => {
    const cell = cellSet[`${rowId}${colId}`];
    if (!cell || !cell.block_id) return '';
    return renderBlockToInline(cell.block_id, ctx).trim();
  }));
  const header = matrix[0] || cols.map((_, i) => `列${i + 1}`);
  lines.push('');
  lines.push('| ' + header.map(escapePipes).join(' | ') + ' |');
  lines.push('| ' + header.map(() => '---').join(' | ') + ' |');
  for (let i = 1; i < matrix.length; i++) lines.push('| ' + matrix[i].map(escapePipes).join(' | ') + ' |');
  lines.push('');
}

function renderBlockToInline(id, ctx) {
  const block = ctx.blocks.get(id);
  if (!block || !block.data) return '';
  const data = block.data;
  if (['text','heading1','heading2','heading3','heading4','heading5','heading6','bullet','ordered'].includes(data.type)) {
    let text = extractText(data.text).trim();
    const childText = (data.children || []).map(childId => renderBlockToInline(childId, ctx)).filter(Boolean).join(' ');
    if (childText) text = [text, childText].filter(Boolean).join(' ');
    return text;
  }
  if (data.type === 'code') return extractText(data.text, { preserveNewlines: true }).trim();
  if (data.type === 'image') return `[图片:${(data.image || {}).name || (data.image || {}).token || 'image'}]`;
  if (data.type === 'file') return `[附件:${(data.file || {}).name || (data.file || {}).token || 'file'}]`;
  if (Array.isArray(data.children)) return data.children.map(childId => renderBlockToInline(childId, ctx)).filter(Boolean).join(' ');
  return '';
}

function extractText(textObj, opts = {}) {
  if (!textObj || !textObj.initialAttributedTexts || !textObj.initialAttributedTexts.text) return '';
  const parts = Object.keys(textObj.initialAttributedTexts.text).sort((a,b) => Number(a)-Number(b)).map(k => textObj.initialAttributedTexts.text[k] || '');
  let text = parts.join('');
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\u00A0/g, ' ').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n');
  if (opts.preserveNewlines) return text.trim();
  return text.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function normalizeCodeLang(lang) {
  const m = { 'Plain Text':'', 'TypeScript':'ts', 'JavaScript':'js', 'Shell':'bash', 'Bash':'bash', 'JSON':'json' };
  return m[lang] !== undefined ? m[lang] : String(lang || '').toLowerCase();
}

async function downloadAssets(page, ctx, docDir) {
  fs.mkdirSync(path.join(docDir, 'images'), { recursive: true });
  fs.mkdirSync(path.join(docDir, 'files'), { recursive: true });
  for (const img of dedupeByToken(ctx.images)) {
    if (!img.token) continue;
    await downloadOne(page, `/space/api/box/stream/download/preview/${encodeURIComponent(img.token)}/?preview_type=16`, path.join(docDir, img.fileName));
  }
  for (const file of dedupeByToken(ctx.files)) {
    if (!file.token) continue;
    await downloadOne(page, `/space/api/box/stream/download/all/${encodeURIComponent(file.token)}/`, path.join(docDir, file.fileName));
  }
}

async function downloadOne(page, url, outPath) {
  try {
    const res = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      const ab = await r.arrayBuffer();
      return { ok: r.ok, bytes: Array.from(new Uint8Array(ab)) };
    }, url);
    if (!res || !res.ok) return;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(res.bytes));
  } catch {}
}

function dedupeByToken(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    if (!item || !item.token || seen.has(item.token)) continue;
    seen.add(item.token);
    out.push(item);
  }
  return out;
}

function extFromMimeOrName(mime, name, fallback='.bin') {
  const byMime = { 'image/png':'.png', 'image/jpeg':'.jpg', 'image/jpg':'.jpg', 'image/gif':'.gif', 'image/webp':'.webp', 'video/quicktime':'.mov', 'application/pdf':'.pdf' };
  if (mime && byMime[mime]) return byMime[mime];
  return path.extname(String(name || '')) || fallback;
}

function safeFileBase(input) {
  return String(input || 'file').replace(/\.[^.]+$/, '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 60) || 'file';
}

function cleanupMarkdown(md) {
  return md.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim() + '\n';
}

function escapeMd(s) { return String(s || '').replace(/[\[\]]/g, '\\$&'); }
function escapePipes(s) { return String(s || '').replace(/\|/g, '\\|').replace(/\n+/g, '<br>'); }
function safeSlug(input) { return String(input).trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 80) || 'lark-doc'; }

main().catch((err) => { console.error(err); process.exit(1); });
