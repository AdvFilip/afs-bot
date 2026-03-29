-- =============================================================================
-- Migration 002: Cases Schema (eCourts sync)
-- Replaces the bigint stub `cases` table with a full eCourts-compatible schema.
-- Adds case_contacts junction table and case_cino FK on reminders.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Step 1: Drop FK on wa_messages_outbound before dropping cases
-- ---------------------------------------------------------------------------
ALTER TABLE public.wa_messages_outbound DROP COLUMN IF EXISTS case_id;

-- ---------------------------------------------------------------------------
-- Step 2: Drop stub cases table (no real data yet)
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS public.cases;

-- ---------------------------------------------------------------------------
-- Step 3: New cases table — cino (CNR) as text primary key
-- ---------------------------------------------------------------------------
CREATE TABLE public.cases (
  cino                  text        PRIMARY KEY,               -- CNR e.g. "TNTP050007832023"
  reference             text,                                  -- caseNumber e.g. "OS 597/2023"
  title                 text,                                  -- derived: petitioners[0] vs respondents[0]
  case_type             text,                                  -- caseType e.g. "OS", "RFA"
  case_status           text        NOT NULL DEFAULT 'open'
                          CHECK (case_status IN ('open','closed','archived')),
  filing_date           date,
  registration_date     date,
  first_hearing_date    date,
  next_hearing_date     date,                                  -- KEY field for reminders
  decision_date         date,
  petitioners           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  respondents           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  petitioner_advocates  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  respondent_advocates  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  judges                jsonb       NOT NULL DEFAULT '[]'::jsonb,
  acts_and_sections     text,
  court_name            text,
  state_name            text,
  district_name         text,
  court_no              integer,
  bench_name            text,
  purpose_name          text,
  judicial_section      text,
  court_code            text,                                  -- cnrCourtCode e.g. "TNTP05"
  filing_number         text,
  raw_api_payload       jsonb,                                 -- full API response for auditing
  last_synced_at        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Step 4: Re-add case link on wa_messages_outbound as text FK
-- ---------------------------------------------------------------------------
ALTER TABLE public.wa_messages_outbound
  ADD COLUMN IF NOT EXISTS case_cino text REFERENCES public.cases(cino) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Step 5: Add case_cino to reminders (for reminder rescheduling on sync)
-- ---------------------------------------------------------------------------
ALTER TABLE public.reminders
  ADD COLUMN IF NOT EXISTS case_cino text REFERENCES public.cases(cino) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Step 6: case_contacts — links a phone contact to a CNR case
-- ---------------------------------------------------------------------------
CREATE TABLE public.case_contacts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cino              text        NOT NULL REFERENCES public.cases(cino) ON DELETE CASCADE,
  client_contact_id uuid        NOT NULL REFERENCES public.client_contacts(id) ON DELETE CASCADE,
  role              text        NOT NULL DEFAULT 'petitioner'
                      CHECK (role IN ('petitioner','respondent','other')),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cino, client_contact_id)
);

-- ---------------------------------------------------------------------------
-- Step 7: Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_cases_next_hearing     ON public.cases(next_hearing_date);
CREATE INDEX IF NOT EXISTS idx_cases_last_synced      ON public.cases(last_synced_at);
CREATE INDEX IF NOT EXISTS idx_cases_status           ON public.cases(case_status);
CREATE INDEX IF NOT EXISTS idx_case_contacts_cino     ON public.case_contacts(cino);
CREATE INDEX IF NOT EXISTS idx_case_contacts_contact  ON public.case_contacts(client_contact_id);
CREATE INDEX IF NOT EXISTS idx_reminders_case_cino    ON public.reminders(case_cino);
