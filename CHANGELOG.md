# Changelog

## 1.6.0

- `delete_link` deletes a traceable link with every recipient's opens,
  downloads and copy; `remove_link_recipient` deletes one recipient's
  records and copy and returns the link without them. Both are marked destructive, say that the
  action can't be undone and that detection will no longer name the
  recipient, and need `links:write` and `assets:delete` with an owner or admin
  role. `get_link` returns each recipient's `id`.

## 1.5.0

- Traceable links: `create_link` shares a source asset so each recipient
  opens their own watermarked copy (`recipients` or `allowed_domains`,
  `expires_at`, `prepare`, `download_limit`, `webhook_id` and a required
  `idempotency_key`); `list_links` and `get_link` are read-only; `revoke_link`
  is marked destructive. Scopes `links:write` and `links:read`.
- `watermark_media` and `detect_media` take the file as exactly one of
  `input_path`, `input_url`, `upload_id` or `asset_id`. `input_url` is
  downloaded by the server over HTTPS from public addresses only, following at
  most 3 redirects, each checked again, within the operation's upload limit.
  `asset_id` submits an existing asset again. An optional `filename` sets the
  name of a URL or asset input.
- New `create_upload` tool: returns an `upload_id` and a signed upload URL, so
  a client can upload a file itself and pass `upload_id`.
- Without `output_path`, sync `watermark_media`, `get_job_result` and
  `download_asset` return `download_url` and `download_expires_at`, a
  short-lived link to the asset, instead of refusing. Creating a link needs the
  `assets:read` scope.
- Every tool has a title, in its definition and in its annotations.
- `createServer` takes `mode: "hosted"` for a remote server: no files root,
  no local file arguments, no `watermark_batch` or `download_batch`, and
  instructions and capabilities that describe that mode. The `etchv-mcp`
  command stays local.

## 1.4.0

- `watermark_media` and `watermark_batch` take `active_content` (`keep`, the
  default, or `remove_auto_run`) to remove what a PDF viewer runs by itself.
  Other media are refused before any request; a batch with `remove_auto_run`
  must contain only PDFs.
- Batch PDFs may be up to 50 MiB, as the API allows; DOCX and PPTX stay at 20 MiB.
- The capabilities resource and README state the PDF limits: 1 to 2,000 pages
  and 50 MiB to embed, 95 MiB for the watermarked copy (48 KiB per page) and
  95 MiB to detect.

## 1.3.0

- `watermark_media` and `detect_media` take DOCX and PPTX as `documents`, and
  WebM, Matroska (`.mkv`), MPEG (`.mpg`, `.mpeg`), MPEG transport stream (`.ts`)
  and AVI as `videos`, besides PDF, MP4 and MOV.
- `watermark_batch` takes the same new files, including DOCX and PPTX.

## 1.2.0

- New `watermark_batch` tool: watermark up to 100 local files in one batch,
  named by `input_paths`, `input_dir` with `glob`, or `items` with their own
  data. `data_template` values may use `{filename}`, `{stem}` and `{index}`.
  Files are uploaded to signed URLs without the API key, the batch is started,
  and with `wait` it is polled at the pace the API asks for (`Retry-After`).
  `wait_seconds` bounds the wait, progress notifications report uploads and
  checks, and a canceled call stops waiting. A retry resumes the same batch
  (sending only files not yet received); a batch that expired unstarted or
  whose results expired is reported with a request for a new
  `idempotency_key`. The 100-file cap is checked before anything is sent, and
  globs cannot leave `input_dir` (braces and `..` are refused).
  Directory listings filter by file type while walking and refuse a directory
  too large to walk rather than return part of it. Uploads to signed URLs time
  out (45 s plus time for the file at 128 KiB/s).
- New `get_batch` tool to follow a batch, and `download_batch` to save each
  successful result (named as in the batch zip) or the batch's zip and report failed items with their
  error codes.

## 1.1.0

- `watermark_media` and `detect_media` send files over 40 MiB
  (`ETCHV_LARGE_FILE_THRESHOLD`) through an upload session, without the API
  key, and submit its `upload_id`.
- Detection reads delivered files up to 192 MiB; image or PDF detection above
  95 MiB returns a job receipt for `get_job_result`.
