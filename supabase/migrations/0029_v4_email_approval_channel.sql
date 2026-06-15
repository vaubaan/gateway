-- =============================================================================
-- 0029_v4_email_approval_channel.sql
--
-- Phase 6 of the v4 risk-based pivot — adds the `email` approval channel as a
-- third option alongside `manual` and `telegram` (migration 0013). An email
-- channel sends a signed JWT link that the operator clicks to approve.
--
-- Multi-channel : a project can configure several channels simultaneously
-- (Telegram + Email fan-out for redundancy). The previous PRIMARY KEY on
-- `project_id` only allowed ONE channel per project — we relax to a composite
-- (project_id, channel) primary key.
--
-- Backward compatibility : projects with an existing single row are preserved
-- as-is (the migration adds the column and replaces the PK without data loss).
--
-- Spec : docs/spec/gateway-risk-model.md §10 + ADR pivot-to-risk-based §D7.
-- =============================================================================

-- 1. Add email column.
alter table project_approval_channels
  add column email_address text
    check (email_address is null
           or email_address ~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$');

-- 2. Extend the channel check + the coherence constraints.
alter table project_approval_channels
  drop constraint if exists project_approval_channels_channel_check;

alter table project_approval_channels
  add constraint project_approval_channels_channel_check
    check (channel in ('manual', 'telegram', 'email'));

alter table project_approval_channels
  drop constraint if exists approval_channel_telegram_needs_chat;

alter table project_approval_channels
  add constraint approval_channel_targets
    check (
      (channel = 'manual') or
      (channel = 'telegram' and telegram_chat_id is not null) or
      (channel = 'email'    and email_address is not null)
    );

-- 3. Relax PK from `project_id` to `(project_id, channel)` so a project can
--    have one row per channel.
alter table project_approval_channels
  drop constraint project_approval_channels_pkey;

alter table project_approval_channels
  add primary key (project_id, channel);

-- 4. Index for the by-project lookup that pickChannel() does.
create index project_approval_channels_project_idx
  on project_approval_channels (project_id);
