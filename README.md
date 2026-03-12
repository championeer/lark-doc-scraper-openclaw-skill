# lark-doc-scraper-openclaw-skill

OpenClaw skill for scraping Feishu/Lark docx documents into local Markdown folders with downloaded images.

## What it does

- fetches Feishu/Lark docx content via `client_vars` API
- exports Markdown
- downloads embedded images to `images/`
- stores outputs in a subdirectory named after the document title

## Skill contents

- `SKILL.md`
- `scripts/scrape_lark_doc_api.js`

## Typical use

Ask an OpenClaw agent something like:

- `把这篇飞书文档爬下来`
- `导出成 markdown`
- `下载文档和图片`

## Script usage

```bash
node scripts/scrape_lark_doc_api.js "https://bytedance.larkoffice.com/docx/<TOKEN>" ./output
```

## Output shape

```text
output/
  <document-title>/
    <document-title>.md
    <document-title>.meta.json
    <document-title>.order.json
    <document-title>.raw.blocks.json
    images/
    files/
```

## Notes

- public docs work directly
- private docs may require browser login state
- complex formatting may still need light manual cleanup
