-- =============================================================================
-- Migration 003: WhatsApp Onboarding Sessions
-- Tracks multi-step conversation state for client self-registration via WA.
-- Flow: REGISTER → case_type → case_number → year → confirm → done
-- =============================================================================

CREATE TABLE public.wa_onboarding_sessions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164     text        NOT NULL UNIQUE,
  step           text        NOT NULL
                   CHECK (step IN ('case_type','case_number','year','confirm')),
  session_data   jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- collected inputs so far
  candidate_cino text,                                      -- CNR found from search
  candidate_case jsonb,                                     -- full search result object
  expires_at     timestamptz NOT NULL,                      -- session auto-expires (30 min)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_phone   ON public.wa_onboarding_sessions(phone_e164);
CREATE INDEX IF NOT EXISTS idx_onboarding_expires ON public.wa_onboarding_sessions(expires_at);
