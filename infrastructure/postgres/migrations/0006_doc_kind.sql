-- Kind de editor por documento (Etapa UI editor de código).
-- prose = TipTap actual; code = Monaco sobre Y.Text. Inmutable tras crear.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'prose';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS code_language TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_kind_check'
  ) THEN
    ALTER TABLE documents ADD CONSTRAINT documents_kind_check CHECK (kind IN ('prose', 'code'));
  END IF;
END $$;
