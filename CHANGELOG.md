# Changelog

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
