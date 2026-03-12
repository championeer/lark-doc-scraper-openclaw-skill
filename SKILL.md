---
name: lark-doc-scraper-openclaw-skill
description: Scrape Feishu/Lark docx documents into local Markdown folders with downloaded images and raw block JSON. Use when asked to download, archive, crawl, export, mirror, or convert a Feishu/Lark docx link (公开或私有) into Markdown, especially for requests like “把这篇飞书文档爬下来”, “导出成 markdown”, “下载文档和图片”, or “保存到本地目录”.
---

# Lark Doc Scraper

Use this skill to turn a Feishu/Lark docx page into a local folder containing:
- a Markdown export
- downloaded images in `images/`
- raw block data for debugging or later reprocessing

## Quick workflow

1. Ensure `playwright` is available in the current workspace.
   - If missing, run `npm install playwright` in the workspace.
2. Run `scripts/scrape_lark_doc_api.js` with a doc URL or doc token.
3. Put output under a user-chosen directory; the script creates a subdirectory named after the document title automatically.
4. If the document is private, provide login state with `STORAGE_STATE=...` or run with `HEADLESS=false` and let the browser session authenticate first.
5. Report back the output folder and note any remaining formatting limitations.

## Preferred command

```bash
node <skill-dir>/scripts/scrape_lark_doc_api.js "<feishu-docx-url>" <output-dir>
```

Example:

```bash
node /Users/qianli/.openclaw/workspace/skills/lark-doc-scraper/scripts/scrape_lark_doc_api.js \
  "https://bytedance.larkoffice.com/docx/MFK7dDFLFoVlOGxWCv5cTXKmnMh" \
  /Users/qianli/.openclaw/workspace/output/lark-docs
```

## Output contract

Expect a directory structure like:

```text
<output-dir>/
  <document-title>/
    <document-title>.md
    <document-title>.meta.json
    <document-title>.order.json
    <document-title>.raw.blocks.json
    images/
    files/
```

## Notes

- Prefer the API-based script over DOM text scraping. It uses `space/api/docx/pages/client_vars`, which is more stable and preserves document structure better.
- Images are downloaded via Feishu preview endpoints and rewritten to local Markdown image paths.
- Markdown is usable but not perfect. Mention that some inline links, callouts, or complex blocks may still need light cleanup.
- If asked to improve formatting further, iterate on the script instead of falling back to brittle HTML scraping.
