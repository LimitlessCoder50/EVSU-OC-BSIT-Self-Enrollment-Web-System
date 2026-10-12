drop policy if exists "Backend service role manages student FHE forms"
on storage.objects;

create policy "Backend service role manages student FHE forms"
on storage.objects
for all
to service_role
using (bucket_id = 'student-fhe-forms')
with check (bucket_id = 'student-fhe-forms');
