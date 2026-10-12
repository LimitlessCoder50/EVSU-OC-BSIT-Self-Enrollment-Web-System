alter table public.audit_log
    alter column admin_id drop not null;

alter table public.audit_log
    add column faculty_id bigint references public.faculty(id);

alter table public.audit_log
    add constraint audit_log_single_actor
    check (num_nonnulls(admin_id, faculty_id) = 1);
