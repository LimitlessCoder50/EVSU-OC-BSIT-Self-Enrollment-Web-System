from datetime import time

from fastapi import APIRouter, Depends, HTTPException, Request, status
from postgrest.exceptions import APIError
from supabase import Client

from app.core.security import get_current_department_head, get_current_user
from app.core.supabase import get_supabase
from app.schemas import (
    ClassScheduleCreate,
    ClassScheduleOptionsResponse,
    ClassScheduleResponse,
    ClassScheduleUpdate,
    MessageResponse,
    ScheduleEnrolledStudentResponse,
)

router = APIRouter(prefix="/class-schedules", tags=["Class Scheduling"])
_DAY_TOKENS = ("TH", "SU", "M", "T", "W", "F", "S")


def _parse_days(days: str) -> set[str]:
    """Parse comma-separated weekdays or compact values such as MW and TTH."""
    value = days.strip().upper().replace(" ", "")
    if not value:
        return set()
    if "," in value:
        tokens = value.split(",")
        if any(token not in _DAY_TOKENS for token in tokens):
            return set()
    else:
        tokens = []
        index = 0
        while index < len(value):
            token = next(
                (candidate for candidate in _DAY_TOKENS if value.startswith(candidate, index)),
                None,
            )
            if token is None:
                return set()
            tokens.append(token)
            index += len(token)
    return set(tokens) if len(set(tokens)) == len(tokens) else set()


def _time_value(value: str | time) -> time:
    return value if isinstance(value, time) else time.fromisoformat(value)


def _log_audit(db: Client, faculty_id: int, action: str, ip_address: str | None) -> None:
    db.table("audit_log").insert(
        {"faculty_id": faculty_id, "action": action, "ip_address": ip_address}
    ).execute()


def _check_room_conflict(
    db: Client,
    schedule: dict,
    target_semester: int,
    exclude_schedule_id: int | None = None,
    semester_overrides: dict[int, int] | None = None,
) -> None:
    existing_schedules = (
        db.table("class_schedule")
        .select("id,section_id,room,days,start_time,end_time")
        .execute()
        .data
    )
    section_ids = {item["section_id"] for item in existing_schedules}
    section_ids.add(schedule["section_id"])
    sections = (
        db.table("sections")
        .select("id,semester")
        .in_("id", list(section_ids))
        .execute()
        .data
    )
    semester_by_section_id = {item["id"]: item["semester"] for item in sections}
    if semester_overrides:
        semester_by_section_id.update(semester_overrides)
    days = _parse_days(schedule["days"])
    if not days:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Days must be valid weekday abbreviations, such as M,W or TTH",
        )

    for existing in existing_schedules:
        if existing["id"] == exclude_schedule_id:
            continue
        if (
            existing["room"].strip().casefold() != schedule["room"].strip().casefold()
            or semester_by_section_id.get(existing["section_id"]) != target_semester
        ):
            continue
        existing_days = _parse_days(existing["days"])
        if not existing_days:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="An existing class schedule has invalid days",
            )
        existing_start = _time_value(existing["start_time"])
        existing_end = _time_value(existing["end_time"])
        if (
            days.intersection(existing_days)
            and schedule["start_time"] < existing_end
            and existing_start < schedule["end_time"]
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    f"Room {schedule['room']} is already booked during an overlapping "
                    "day and time in this semester"
                ),
            )


@router.get(
    "/",
    response_model=list[ClassScheduleResponse],
    summary="List scheduled classes",
)
def list_class_schedules(
    current_user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase),
):
    """List schedules, limiting instructors to their own assigned classes."""
    query = db.table("class_schedule").select("*")
    account = current_user["account"]
    if current_user["account_type"] == "faculty" and account.get("role") == "instructor":
        query = query.eq("instructor_id", account["id"])
    return query.order("created_at", desc=True).execute().data


@router.get(
    "/options",
    response_model=ClassScheduleOptionsResponse,
    summary="Get section, subject, and instructor choices",
)
def get_class_schedule_options(
    current_department_head: dict = Depends(get_current_department_head),
    db: Client = Depends(get_supabase),
):
    """Return sections, subjects, and instructor accounts for scheduling."""
    sections = (
        db.table("sections")
        .select("*")
        .order("year_level")
        .order("section_name")
        .execute()
        .data
    )
    subjects = (
        db.table("subject")
        .select("*")
        .order("year_level")
        .order("semester")
        .order("course_no")
        .execute()
        .data
    )
    instructors = (
        db.table("faculty")
        .select("*")
        .eq("role", "instructor")
        .order("lname")
        .order("fname")
        .execute()
        .data
    )
    return {"sections": sections, "subjects": subjects, "instructors": instructors}


@router.get(
    "/{public_id}/enrollments",
    response_model=list[ScheduleEnrolledStudentResponse],
    summary="List students enrolled in an instructor's scheduled class",
)
def list_schedule_enrollments(
    public_id: str,
    current_user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase),
):
    """Return active enrollment records for a schedule assigned to this instructor."""
    account = current_user["account"]
    if current_user["account_type"] != "faculty" or account.get("role") != "instructor":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Instructor privileges are required",
        )

    schedule = (
        db.table("class_schedule")
        .select("id,section_id,instructor_id")
        .eq("public_id", public_id)
        .eq("instructor_id", account["id"])
        .execute()
        .data
    )
    if not schedule:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Assigned class schedule not found",
        )

    section = (
        db.table("sections")
        .select("year_level,semester")
        .eq("id", schedule[0]["section_id"])
        .execute()
        .data
    )
    if not section:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="The class schedule's section is unavailable",
        )

    enrollments = (
        db.table("enrollment")
        .select("session_id,enrollment_status,created_at")
        .eq("schedule_id", schedule[0]["id"])
        .neq("enrollment_status", "CANCELLED")
        .order("created_at")
        .execute()
        .data
    )
    if not enrollments:
        return []

    session_ids = {enrollment["session_id"] for enrollment in enrollments}
    sessions = (
        db.table("enrollment_session")
        .select("id,student_id")
        .in_("id", list(session_ids))
        .eq("year_level", section[0]["year_level"])
        .eq("semester", section[0]["semester"])
        .execute()
        .data
    )
    if not sessions:
        return []

    session_by_id = {session["id"]: session for session in sessions}
    student_ids = {session["student_id"] for session in sessions}
    students = (
        db.table("student")
        .select("id,id_number,fname,mname,lname,year_level,semester")
        .in_("id", list(student_ids))
        .execute()
        .data
    )
    student_by_id = {student["id"]: student for student in students}

    result = []
    for enrollment in enrollments:
        session = session_by_id.get(enrollment["session_id"])
        student = student_by_id.get(session["student_id"]) if session else None
        if student:
            result.append(
                ScheduleEnrolledStudentResponse(
                    **student,
                    enrollment_status=enrollment["enrollment_status"],
                    enrolled_at=enrollment["created_at"],
                )
            )
    return result


@router.post(
    "/",
    response_model=ClassScheduleResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a class schedule",
)
def create_class_schedule(
    payload: ClassScheduleCreate,
    request: Request,
    current_department_head: dict = Depends(get_current_department_head),
    db: Client = Depends(get_supabase),
):
    """Schedule a subject for a section and instructor, rejecting room conflicts."""
    days = _parse_days(payload.days)
    if not days:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Days must be valid weekday abbreviations, such as M,W or TTH",
        )

    section = (
        db.table("sections")
        .select("id,section_name,semester")
        .eq("id", payload.section_id)
        .execute()
        .data
    )
    if not section:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Selected section was not found",
        )

    subject = (
        db.table("subject")
        .select("id,course_no")
        .eq("id", payload.subject_id)
        .execute()
        .data
    )
    if not subject:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Selected subject was not found",
        )

    instructor = (
        db.table("faculty")
        .select("id,fname,mname,lname,role,is_active")
        .eq("id", payload.instructor_id)
        .execute()
        .data
    )
    if (
        not instructor
        or instructor[0].get("role") != "instructor"
        or not instructor[0].get("is_active")
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Select an active instructor",
        )

    _check_room_conflict(
        db,
        payload.model_dump(),
        section[0]["semester"],
    )

    try:
        result = (
            db.table("class_schedule")
            .insert(payload.model_dump(mode="json"))
            .execute()
        )
    except APIError as error:
        if error.code == "23503":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="The selected section, subject, or instructor is no longer available",
            ) from error
        raise

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create class schedule",
        )

    created = result.data[0]
    _log_audit(
        db,
        current_department_head["id"],
        (
            f"Scheduled {subject[0]['course_no']} for "
            f"{section[0]['section_name']} with "
            f"{' '.join(part for part in (instructor[0].get('fname'), instructor[0].get('mname'), instructor[0].get('lname')) if part)}"
        ),
        request.client.host if request.client else None,
    )
    return created


@router.patch(
    "/{public_id}",
    response_model=ClassScheduleResponse,
    summary="Update a class schedule",
)
def update_class_schedule(
    public_id: str,
    payload: ClassScheduleUpdate,
    request: Request,
    current_department_head: dict = Depends(get_current_department_head),
    db: Client = Depends(get_supabase),
):
    """Update a schedule after revalidating its references and room booking."""
    current = (
        db.table("class_schedule")
        .select("*")
        .eq("public_id", public_id)
        .execute()
        .data
    )
    if not current:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Class schedule not found",
        )

    updates = payload.model_dump(exclude_unset=True, mode="json")
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )
    schedule = {**current[0], **updates}
    start_time = _time_value(schedule["start_time"])
    end_time = _time_value(schedule["end_time"])
    if start_time >= end_time:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Start time must be earlier than end time",
        )
    days = _parse_days(schedule["days"])
    if not days:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Days must be valid weekday abbreviations, such as M,W or TTH",
        )

    section = (
        db.table("sections")
        .select("id,section_name,semester")
        .eq("id", schedule["section_id"])
        .execute()
        .data
    )
    subject = (
        db.table("subject")
        .select("id,course_no")
        .eq("id", schedule["subject_id"])
        .execute()
        .data
    )
    instructor = (
        db.table("faculty")
        .select("id,fname,mname,lname,role,is_active")
        .eq("id", schedule["instructor_id"])
        .execute()
        .data
    )
    if not section or not subject:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Selected section or subject was not found",
        )
    if (
        not instructor
        or instructor[0].get("role") != "instructor"
        or not instructor[0].get("is_active")
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Select an active instructor",
        )

    _check_room_conflict(
        db,
        {
            **schedule,
            "start_time": start_time,
            "end_time": end_time,
        },
        section[0]["semester"],
        exclude_schedule_id=current[0]["id"],
    )

    try:
        result = (
            db.table("class_schedule")
            .update(updates)
            .eq("public_id", public_id)
            .execute()
        )
    except APIError as error:
        if error.code == "23503":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="The selected section, subject, or instructor is no longer available",
            ) from error
        raise
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Class schedule not found",
        )

    instructor_name = " ".join(
        part
        for part in (
            instructor[0].get("fname"),
            instructor[0].get("mname"),
            instructor[0].get("lname"),
        )
        if part
    )
    _log_audit(
        db,
        current_department_head["id"],
        (
            f"Updated schedule for {subject[0]['course_no']} in "
            f"{section[0]['section_name']} with {instructor_name}"
        ),
        request.client.host if request.client else None,
    )
    return result.data[0]


@router.delete(
    "/{public_id}",
    response_model=MessageResponse,
    summary="Delete a class schedule",
)
def delete_class_schedule(
    public_id: str,
    request: Request,
    current_department_head: dict = Depends(get_current_department_head),
    db: Client = Depends(get_supabase),
):
    """Delete a class schedule without removing its section or subject."""
    existing = (
        db.table("class_schedule")
        .select("id,section_id,subject_id")
        .eq("public_id", public_id)
        .execute()
        .data
    )
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Class schedule not found",
        )
    section = (
        db.table("sections")
        .select("section_name")
        .eq("id", existing[0]["section_id"])
        .execute()
        .data
    )
    subject = (
        db.table("subject")
        .select("course_no")
        .eq("id", existing[0]["subject_id"])
        .execute()
        .data
    )
    db.table("class_schedule").delete().eq("public_id", public_id).execute()
    _log_audit(
        db,
        current_department_head["id"],
        (
            f"Deleted schedule for {subject[0]['course_no']} in "
            f"{section[0]['section_name']}"
            if section and subject
            else "Deleted class schedule"
        ),
        request.client.host if request.client else None,
    )
    return MessageResponse(message="Class schedule deleted successfully")
