# EVSU-OC Enrollment Administration Frontend

This is a Bootstrap 5 frontend for the FastAPI backend in `../backend`. It uses the backend's `/` health check and `/api/v1` endpoints for administrator and faculty authentication, account management, subject browsing/management, and audit activity.

## Run

1. Configure the backend's Supabase and JWT values in `backend/.env`, then start it from the `backend` directory:

   ```bash
   uvicorn app.main:app --reload
   ```

2. Serve this directory with any static web server. For example, from the project root:

   ```bash
   python -m http.server 5500 --directory frontend
   ```

3. Open `http://127.0.0.1:5500` for administrator sign-in, `http://127.0.0.1:5500/faculty-login.html` for faculty sign-in, or `http://127.0.0.1:5500/student-login.html` for the student portal. Students can sign in or create an account there. The frontend connects to the backend at `http://127.0.0.1:8000`.

The API must permit the frontend origin through CORS. The current backend allows all origins. Administrator and faculty sign-in are available on separate pages, and both roles continue to the shared enrollment workspace after authentication. Instructor accounts open a read-only My classes view showing only their assigned subjects, sections, rooms, and schedules. Student accounts use a separate student portal and student-scoped token. On sign-in, the dashboard checks the student's session for their current year and semester. If no session exists, the student must upload an FHE form before current-term schedules are shown. Once the upload creates an `enrollment_session`, matching schedules are displayed immediately regardless of the FHE review status. Schedule matching uses the student's year and semester on both the linked section and subject. Students can replace a rejected form. Uploads accept PDF, JPEG, PNG, or WebP files up to 10 MB. Each administrator and faculty account has an ID number. A `super_admin` can manage admin accounts and department head/instructor accounts; faculty account management is available from the Faculty page. Faculty deletion deactivates the account to preserve its history. Faculty password changes are not available through the management UI. All authenticated staff accounts can browse subjects and sections; only the department head can add, edit, or permanently delete subjects, create student sections, and create class schedules.

Apply `backend/migrations/20261012_student_fhe_storage_bucket.sql` and `backend/migrations/20261012_student_fhe_storage_service_policy.sql` in the Supabase SQL editor to create the private `student-fhe-forms` bucket and grant the backend service role access to objects in that bucket. The backend Supabase service-role key must be configured in `backend/.env` and must never be exposed in the frontend. The API stores private object paths in `enrollment_session.fhe_form_url` and issues one-hour signed links to the authenticated student when displaying their dashboard. Optionally set `SUPABASE_FHE_BUCKET` to the bucket name if using a different bucket.

Apply `backend/migrations/20261011_audit_log_faculty_actor.sql` to Supabase before deploying the audit changes. It allows audit entries to identify either an administrator or faculty actor. Administrators can review system audit activity; the department head can review their own account, subject, section, and scheduling activity.

Department heads can manage the active school year, semester, and enrollment opening/closing timestamps from the Enrollment configuration page. Enrollment dates are entered in Philippine time (UTC+08:00), including seconds. The page reads and updates the seeded master row (`id = 1`) in the Supabase `system_settings` table. Both configuration endpoints require a department-head faculty token, and changes are recorded in the audit log.

Student FHE uploads are permitted only during that configured window: uploads open at the configured start timestamp and stop at the end timestamp. The student dashboard displays the configured dates and disables upload controls when the window is not open; the API enforces the same restriction independently. If the `system_settings` row is missing or invalid, the dashboard and upload endpoint fail closed.

## Backend routes used

- `GET /` — health check
- `POST /api/v1/auth/login`
- `GET /api/v1/auth/me`, `PUT /api/v1/auth/change-password`
- `POST /api/v1/auth/faculty-login`, `GET /api/v1/auth/faculty/me`
- `POST /api/v1/auth/student-signup`, `POST /api/v1/auth/student-login`, `GET /api/v1/auth/student/me`
- `GET /api/v1/student/enrollment-session/current`
- `POST /api/v1/student/enrollment-session/fhe-form` (multipart `fhe_form`)
- `GET /api/v1/admins/`, `GET /api/v1/admins/{public_id}`, `POST /api/v1/admins/`
- `PATCH /api/v1/admins/{public_id}`, `DELETE /api/v1/admins/{public_id}`
- `GET /api/v1/faculty/`, `GET /api/v1/faculty/{public_id}`, `POST /api/v1/faculty/`
- `PATCH /api/v1/faculty/{public_id}`, `DELETE /api/v1/faculty/{public_id}` (deactivates)
- `GET /api/v1/subjects/` (optional `year_level` and `semester` filters)
- `GET /api/v1/subjects/{public_id}`, `POST /api/v1/subjects/`
- `PATCH /api/v1/subjects/{public_id}`, `DELETE /api/v1/subjects/{public_id}`
- `GET /api/v1/class-schedules/`, `GET /api/v1/class-schedules/options`, `POST /api/v1/class-schedules/`
- `GET /api/v1/class-schedules/{public_id}/enrollments` (instructor assigned to that schedule only)

- `GET /api/v1/enrollment-config/current`, `PUT /api/v1/enrollment-config/current` (department head only)
- `GET /api/v1/sections/`, `POST /api/v1/sections/`, `PATCH /api/v1/sections/{public_id}`, `DELETE /api/v1/sections/{public_id}`
- `GET /api/v1/audit-logs/`, `GET /api/v1/audit-logs/{log_id}`

Authenticated requests use the bearer token returned by the login endpoint. The UI stores that token in browser local storage and removes it on sign out or when the API reports an unauthorized session. Faculty account management is available only to `super_admin` accounts. Faculty role values are `department_head` and `instructor`; deleting a faculty account deactivates it to preserve its history. Password edits are not supported from the faculty management UI.

The faculty API role values must match the Supabase `check_faculty_role` constraint. The unique department-head index in Supabase currently also counts inactive department heads; update that index predicate if a replacement head should be allowed after deactivation.

Instructors can open a subject from My classes to view students with pending or approved enrollment records for that assigned class schedule. Cancelled enrollments are omitted.

Subject creation and updates require course number, title, lecture/lab/total units, prerequisite, year level, and semester. Course numbers must be unique. Subject deletion is permanent.

Department heads can create, edit, and delete class schedules from the Class scheduling page, selecting an existing section, subject, and active instructor and providing the room, days, and start/end times. The semester comes from the selected section. The backend rejects room bookings that overlap on at least one day within the same semester, excluding the schedule being edited from its conflict check.

The separate Sections page lists and lets department heads create, edit, and delete student sections with a name, year level, capacity (default 40), and semester in the `sections` table. Deleting a section permanently deletes its linked class schedules through the database cascade; the UI asks for confirmation and explains this consequence. Class schedules use `section_id` to reference those sections.
