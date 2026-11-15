-- 001 — Scale & hardening for ~10M users
-- Apply in Supabase SQL editor (one shot, or via `supabase db push`).
-- Idempotent: safe to re-run. Run as postgres / service_role.
--
-- Summary of changes
-- 1. Extensions + helper updated_at trigger
-- 2. Missing columns on profiles / projects / generation_tasks / dependencies
-- 3. Uniqueness + FK + hot-path indexes (dashboard, messages, versions, builds)
-- 4. updated_at triggers on every mutable table
-- 5. RLS rewritten with (SELECT auth.uid()) — evaluated once per query, not per row
-- 6. Anonymous share reads moved to security-definer RPC (no more list-all-shared)
-- 7. Partial/trigram indexes for public share + search

-- ── 0. Extensions ───────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;         -- fast ILIKE on project names
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;  -- slow-query visibility

-- ── 1. Helper trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ── 2. Missing columns ──────────────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS company text,
  ADD COLUMN IF NOT EXISTS onboarding_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_active_at timestamptz,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_opened_at timestamptz;

ALTER TABLE public.generation_tasks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.dependencies      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.builds            ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.deployments       ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- ── 3. Constraints (guarded) ────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_plan_check') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_plan_check
      CHECK (plan IN ('free', 'pro', 'team'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_role_check') THEN
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
      CHECK (role IN ('user', 'admin'));
  END IF;
END $$;

-- Every project must have exactly one (project, path) — required for upserts
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'project_files_project_path_unq') THEN
    CREATE UNIQUE INDEX project_files_project_path_unq ON public.project_files (project_id, path);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'projects_share_slug_unq') THEN
    CREATE UNIQUE INDEX projects_share_slug_unq ON public.projects (share_slug) WHERE share_slug IS NOT NULL;
  END IF;
END $$;

-- ── 4. Hot-path indexes ─────────────────────────────────────────────────────
-- Dashboard list: owner's recent projects
CREATE INDEX IF NOT EXISTS projects_user_updated_idx ON public.projects (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS projects_user_pinned_idx  ON public.projects (user_id, pinned_at DESC NULLS LAST);

-- AI conversation timeline (per project, newest first)
CREATE INDEX IF NOT EXISTS ai_conversations_project_idx ON public.ai_conversations (project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ai_messages_conversation_idx ON public.ai_messages (conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS ai_messages_conversation_id_created_idx ON public.ai_messages (conversation_id, created_at DESC);
-- Partial: user's own last-10-messages lookups without scanning the table

-- Builds & deployments history
CREATE INDEX IF NOT EXISTS builds_project_created_idx ON public.builds (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deployments_project_created_idx ON public.deployments (project_id, created_at DESC);

-- Task monitoring (agent runs)
CREATE INDEX IF NOT EXISTS generation_tasks_project_status_idx ON public.generation_tasks (project_id, status, updated_at DESC);

-- Version restore / diff
CREATE INDEX IF NOT EXISTS project_versions_project_number_idx ON public.project_versions (project_id, version_number DESC);

-- Dependencies + embeddings lookups
CREATE INDEX IF NOT EXISTS dependencies_project_idx ON public.dependencies (project_id);
CREATE INDEX IF NOT EXISTS project_file_embeddings_project_idx ON public.project_file_embeddings (project_id);
CREATE INDEX IF NOT EXISTS project_file_embeddings_path_idx ON public.project_file_embeddings (project_id, file_path);

-- Public share + name search
CREATE INDEX IF NOT EXISTS projects_share_slug_idx ON public.projects (share_slug) WHERE is_shared;
CREATE INDEX IF NOT EXISTS projects_name_trgm_idx ON public.projects USING gin (name gin_trgm_ops);

-- ── 5. updated_at triggers everywhere mutable ───────────────────────────────
DROP TRIGGER IF EXISTS profiles_touch  ON public.profiles;
CREATE TRIGGER profiles_touch  BEFORE UPDATE ON public.profiles  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();
DROP TRIGGER IF EXISTS projects_touch  ON public.projects;
CREATE TRIGGER projects_touch  BEFORE UPDATE ON public.projects  FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();
DROP TRIGGER IF EXISTS project_files_touch ON public.project_files;
CREATE TRIGGER project_files_touch BEFORE UPDATE ON public.project_files FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();
DROP TRIGGER IF EXISTS generation_tasks_touch ON public.generation_tasks;
CREATE TRIGGER generation_tasks_touch BEFORE UPDATE ON public.generation_tasks FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();
DROP TRIGGER IF EXISTS builds_touch ON public.builds;
CREATE TRIGGER builds_touch BEFORE UPDATE ON public.builds FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();
DROP TRIGGER IF EXISTS deployments_touch ON public.deployments;
CREATE TRIGGER deployments_touch BEFORE UPDATE ON public.deployments FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();
DROP TRIGGER IF EXISTS dependencies_touch ON public.dependencies;
CREATE TRIGGER dependencies_touch BEFORE UPDATE ON public.dependencies FOR EACH ROW EXECUTE FUNCTION public._touch_updated_at();

-- ── 6. RLS: evaluate auth.uid() once per statement instead of per row ───────
-- The common "select own X" policy, rewritten with an initplan.
DO $$ DECLARE
  policy record;
BEGIN
  FOR policy IN
    SELECT tablename, policyname
    FROM pg_policies WHERE schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy.policyname, policy.tablename);
  END LOOP;
END $$;

CREATE POLICY select_own_profile ON public.profiles FOR SELECT
  USING (id = (SELECT auth.uid()));
CREATE POLICY insert_own_profile ON public.profiles FOR INSERT
  WITH CHECK (id = (SELECT auth.uid()));
CREATE POLICY update_own_profile ON public.profiles FOR UPDATE
  USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));

CREATE POLICY select_own_projects ON public.projects FOR SELECT
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY insert_own_projects ON public.projects FOR INSERT
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY update_own_projects ON public.projects FOR UPDATE
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY delete_own_projects ON public.projects FOR DELETE
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY select_own_project_files ON public.project_files FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_project_files ON public.project_files FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY update_own_project_files ON public.project_files FOR UPDATE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())))
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY delete_own_project_files ON public.project_files FOR DELETE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY select_own_project_versions ON public.project_versions FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_project_versions ON public.project_versions FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY delete_own_project_versions ON public.project_versions FOR DELETE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY select_own_conversations ON public.ai_conversations FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_conversations ON public.ai_conversations FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY update_own_conversations ON public.ai_conversations FOR UPDATE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY delete_own_conversations ON public.ai_conversations FOR DELETE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY select_own_messages ON public.ai_messages FOR SELECT
  USING (conversation_id IN (
    SELECT ac.id FROM public.ai_conversations ac
    JOIN public.projects p ON p.id = ac.project_id
    WHERE p.user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_messages ON public.ai_messages FOR INSERT
  WITH CHECK (conversation_id IN (
    SELECT ac.id FROM public.ai_conversations ac
    JOIN public.projects p ON p.id = ac.project_id
    WHERE p.user_id = (SELECT auth.uid())));
CREATE POLICY delete_own_messages ON public.ai_messages FOR DELETE
  USING (conversation_id IN (
    SELECT ac.id FROM public.ai_conversations ac
    JOIN public.projects p ON p.id = ac.project_id
    WHERE p.user_id = (SELECT auth.uid())));

CREATE POLICY select_own_tasks ON public.generation_tasks FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_tasks ON public.generation_tasks FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY update_own_tasks ON public.generation_tasks FOR UPDATE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY select_own_builds ON public.builds FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_builds ON public.builds FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY update_own_builds ON public.builds FOR UPDATE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY select_own_dependencies ON public.dependencies FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_dependencies ON public.dependencies FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY update_own_dependencies ON public.dependencies FOR UPDATE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())))
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY delete_own_dependencies ON public.dependencies FOR DELETE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY select_own_deployments ON public.deployments FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY insert_own_deployments ON public.deployments FOR INSERT
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));
CREATE POLICY update_own_deployments ON public.deployments FOR UPDATE
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

CREATE POLICY embeddings_owner ON public.project_file_embeddings FOR SELECT
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

-- Shared projects: no blanket anon SELECT — reads go through SECURITY DEFINER
CREATE OR REPLACE FUNCTION public.get_shared_project(p_slug text)
RETURNS SETOF public.projects LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.projects
  WHERE is_shared AND share_slug = p_slug AND archived_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.get_shared_project_files(p_slug text)
RETURNS TABLE (path text, content text, file_type text, updated_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT pf.path, pf.content, pf.file_type, pf.updated_at
  FROM public.project_files pf
  JOIN public.projects p ON p.id = pf.project_id
  WHERE p.is_shared AND p.share_slug = p_slug AND p.archived_at IS NULL;
$$;

-- Grant anon/authenticated the RPC but nothing else beyond their own rows
GRANT EXECUTE ON FUNCTION public.get_shared_project(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_shared_project_files(text) TO anon, authenticated;

-- ── Restore policies dropped in the sweep above ────────────────────────────
-- code_patterns feeds the retriever. Writes are service-role only: the pattern
-- library is seeded by migrations/backfills, never by end users.
CREATE POLICY "Public read code patterns" ON public.code_patterns FOR SELECT USING (true);

-- Vector embeddings: full owner access (matches the previous blanket grant)
CREATE POLICY "Owner write file embeddings" ON public.project_file_embeddings FOR ALL
  USING (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())))
  WITH CHECK (project_id IN (SELECT id FROM public.projects WHERE user_id = (SELECT auth.uid())));

-- Analyze so the planner has fresh statistics after the rewrite
ANALYZE public.projects;
ANALYZE public.ai_messages;
ANALYZE public.ai_conversations;
ANALYZE public.project_files;
