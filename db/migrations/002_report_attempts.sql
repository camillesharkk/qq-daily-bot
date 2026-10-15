ALTER TABLE daily_reports ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE daily_sends ADD COLUMN IF NOT EXISTS segments_sent integer NOT NULL DEFAULT 0;
ALTER TABLE daily_sends ADD COLUMN IF NOT EXISTS receipts text;
ALTER TABLE daily_sends ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE daily_reports DROP CONSTRAINT IF EXISTS daily_reports_state_check;
ALTER TABLE daily_reports DROP CONSTRAINT IF EXISTS daily_reports_content_ready;
ALTER TABLE daily_reports ADD CONSTRAINT daily_reports_state_check CHECK (state IN ('generating', 'ready', 'failed'));
ALTER TABLE daily_reports ADD CONSTRAINT daily_reports_content_ready CHECK (
  (state = 'generating' AND content IS NULL)
  OR (state IN ('ready', 'failed') AND content IS NOT NULL AND length(btrim(content)) > 0)
);
ALTER TABLE daily_sends DROP CONSTRAINT IF EXISTS daily_sends_state_check;
ALTER TABLE daily_sends ADD CONSTRAINT daily_sends_state_check CHECK (state IN ('sending', 'sent', 'failed', 'uncertain', 'partial'));
