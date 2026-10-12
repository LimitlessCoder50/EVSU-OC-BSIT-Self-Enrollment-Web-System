DROP INDEX IF EXISTS public.only_one_faculty_department_head;

CREATE UNIQUE INDEX only_one_faculty_department_head
ON public.faculty (role)
WHERE role = 'department_head' AND is_active = true;
