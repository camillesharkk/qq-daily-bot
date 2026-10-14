CREATE TABLE IF NOT EXISTS daily_reports (
  report_date date PRIMARY KEY,
  content text,
  state text NOT NULL CHECK (state IN ('generating', 'ready')),
  claim_id text,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_reports_content_ready CHECK (
    (state = 'generating' AND content IS NULL)
    OR (state = 'ready' AND content IS NOT NULL AND length(btrim(content)) > 0)
  )
);

CREATE TABLE IF NOT EXISTS daily_sends (
  report_date date NOT NULL REFERENCES daily_reports (report_date),
  group_openid text NOT NULL,
  state text NOT NULL CHECK (state IN ('sending', 'sent', 'failed', 'uncertain')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_date, group_openid)
);
