import logging
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, UploadFile, status
from postgrest.exceptions import APIError
from storage3.utils import StorageException
from supabase import Client

from app.core.config import get_settings
from app.core.security import get_current_student
from app.core.supabase import get_supabase
from app.schemas import (
    AvailableScheduleResponse,
    EnrollmentSessionResponse,
    StudentDashboardResponse,
    StudentEnrollmentWindowResponse,
)

router = APIRouter(prefix="/student", tags=["Student Enrollment"])
logger = logging.getLogger(__name__)
FHE_MAX_FILE_SIZE = 10 * 1024 * 1024
FHE_FILE_TYPES = {
    "application/pdf": (".pdf", b"%PDF-"),
    "image/jpeg": (".jpg", b"\xff\xd8\xff"),
    "image/png": (".png", b"\x89PNG\r\n\x1a\n"),
    "image/webp": (".webp", None),
}
SIGNED_URL_TTL_SECONDS = 60 * 60


def _is_valid_file(mime_type: str, contents: bytes) -> bool:
    if mime_type == "image/webp":
        return (
            len(contents) >= 12
            and contents[:4] == b"RIFF"
            and contents[8:12] == b"WEBP"
        )
    signature = FHE_FILE_TYPES[mime_type][1]
    return signature is not None and contents.startswith(signature)


def _signed_session(
    db: Client,
    session: dict,
) -> EnrollmentSessionResponse:
    bucket_name = get_settings().supabase_fhe_bucket
    try:
        signed = db.storage.from_(bucket_name).create_signed_url(
            session["fhe_form_url"],
            SIGNED_URL_TTL_SECONDS,
        )
    except StorageException as error:
        logger.exception("Could not create a private link for an FHE form")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The FHE form is saved, but its private download link is temporarily unavailable",
        ) from error

    return EnrollmentSessionResponse(
        **{
            **session,
            "fhe_form_url": signed.get("signedURL") or signed["signedUrl"],
        }
    )


def _get_current_session(db: Client, student: dict) -> dict | None:
    result = (
        db.table("enrollment_session")
        .select("*")
        .eq("student_id", student["id"])
        .eq("year_level", student["year_level"])
        .eq("semester", student["semester"])
        .execute()
    )
    return result.data[0] if result.data else None


def _get_enrollment_window(db: Client) -> StudentEnrollmentWindowResponse:
    try:
        result = (
            db.table("system_settings")
            .select(
                "active_school_year,active_semester,enrollment_start,enrollment_end"
            )
            .eq("id", 1)
            .execute()
        )
    except APIError as error:
        logger.exception("Could not read enrollment dates for student FHE upload")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The enrollment window is unavailable; contact the department head",
        ) from error

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The enrollment window has not been configured; contact the department head",
        )

    settings = result.data[0]
    try:
        enrollment_start = datetime.fromisoformat(
            settings["enrollment_start"].replace("Z", "+00:00")
        )
        enrollment_end = datetime.fromisoformat(
            settings["enrollment_end"].replace("Z", "+00:00")
        )
    except (KeyError, TypeError, ValueError) as error:
        logger.exception("The configured student enrollment window is invalid")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The enrollment window configuration is invalid; contact the department head",
        ) from error

    if (
        enrollment_start.tzinfo is None
        or enrollment_start.utcoffset() is None
        or enrollment_end.tzinfo is None
        or enrollment_end.utcoffset() is None
        or enrollment_start >= enrollment_end
    ):
        logger.error("The configured student enrollment window has invalid timestamps")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The enrollment window configuration is invalid; contact the department head",
        )

    now = datetime.now(timezone.utc)
    if now < enrollment_start:
        upload_state = "not_started"
    elif now >= enrollment_end:
        upload_state = "closed"
    else:
        upload_state = "open"
    return StudentEnrollmentWindowResponse(
        **settings,
        fhe_upload_open=upload_state == "open",
        fhe_upload_state=upload_state,
    )


def _get_available_schedules(db: Client, student: dict) -> list[dict]:
    """Find scheduled subjects and sections matching the student's current term."""
    year_level = student["year_level"]
    semester = student["semester"]
    sections = (
        db.table("sections")
        .select("id,section_name")
        .eq("year_level", year_level)
        .eq("semester", semester)
        .execute()
        .data
    )
    subjects = (
        db.table("subject")
        .select("id,course_no,title,lec_units,lab_units,total_units")
        .eq("year_level", year_level)
        .eq("semester", semester)
        .execute()
        .data
    )
    if not sections or not subjects:
        return []

    section_by_id = {section["id"]: section for section in sections}
    subject_by_id = {subject["id"]: subject for subject in subjects}
    schedules = (
        db.table("class_schedule")
        .select("*")
        .in_("section_id", list(section_by_id))
        .in_("subject_id", list(subject_by_id))
        .order("days")
        .order("start_time")
        .execute()
        .data
    )
    if not schedules:
        return []

    instructor_ids = {schedule["instructor_id"] for schedule in schedules}
    instructors = (
        db.table("faculty")
        .select("id,fname,mname,lname")
        .in_("id", list(instructor_ids))
        .execute()
        .data
    )
    instructor_names = {
        instructor["id"]: " ".join(
            part
            for part in (
                instructor.get("fname"),
                instructor.get("mname"),
                instructor.get("lname"),
            )
            if part
        )
        for instructor in instructors
    }

    available = []
    for schedule in schedules:
        subject = subject_by_id.get(schedule["subject_id"])
        section = section_by_id.get(schedule["section_id"])
        instructor_name = instructor_names.get(schedule["instructor_id"])
        if not subject or not section or not instructor_name:
            logger.warning(
                "Omitting schedule %s from student dashboard because a linked record is unavailable",
                schedule.get("public_id", schedule.get("id")),
            )
            continue
        available.append(
            AvailableScheduleResponse(
                public_id=schedule["public_id"],
                section_name=section["section_name"],
                course_no=subject["course_no"],
                subject_title=subject["title"],
                instructor_name=instructor_name,
                days=schedule["days"],
                start_time=schedule["start_time"],
                end_time=schedule["end_time"],
                room=schedule["room"],
                lec_units=subject["lec_units"],
                lab_units=subject["lab_units"],
                total_units=subject["total_units"],
            ).model_dump()
        )
    return available


@router.get(
    "/enrollment-session/current",
    response_model=StudentDashboardResponse,
    summary="Get student dashboard and current-term schedules",
)
def get_student_dashboard(
    current_student: dict = Depends(get_current_student),
    db: Client = Depends(get_supabase),
):
    """Return the student's current session and schedules after an FHE upload."""
    enrollment_window = _get_enrollment_window(db)
    session = _get_current_session(db, current_student)
    return {
        "student": current_student,
        "enrollment_window": enrollment_window,
        "enrollment_session": _signed_session(db, session) if session else None,
        "available_schedules": (
            _get_available_schedules(db, current_student) if session else []
        ),
    }


@router.post(
    "/enrollment-session/fhe-form",
    response_model=EnrollmentSessionResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Upload an FHE form for the current term",
)
def upload_current_fhe_form(
    fhe_form: UploadFile,
    current_student: dict = Depends(get_current_student),
    db: Client = Depends(get_supabase),
):
    """Store the student's PDF/image privately and create or refresh their term session."""
    enrollment_window = _get_enrollment_window(db)
    if not enrollment_window.fhe_upload_open:
        if enrollment_window.fhe_upload_state == "not_started":
            detail = "FHE form uploads are not available until the enrollment window opens"
        else:
            detail = "The enrollment window is closed; FHE form uploads are no longer available"
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=detail,
        )

    contents = fhe_form.file.read(FHE_MAX_FILE_SIZE + 1)
    if not contents:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Choose a non-empty FHE form file",
        )
    if len(contents) > FHE_MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="FHE form files must be 10 MB or smaller",
        )

    mime_type = fhe_form.content_type or ""
    if mime_type not in FHE_FILE_TYPES or not _is_valid_file(mime_type, contents):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Upload a valid PDF, JPEG, PNG, or WebP file",
        )

    year_level = current_student["year_level"]
    semester = current_student["semester"]
    previous_session = _get_current_session(db, current_student)
    if previous_session and previous_session["fhe_status"] != "REJECTED":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An FHE form is already submitted for this term; resubmission is available only after rejection",
        )
    object_path = (
        f"{current_student['public_id']}/{year_level}/{semester}/"
        f"{uuid4().hex}{FHE_FILE_TYPES[mime_type][0]}"
    )
    bucket_name = get_settings().supabase_fhe_bucket
    try:
        db.storage.from_(bucket_name).upload(
            object_path,
            contents,
            {"content-type": mime_type, "upsert": "false"},
        )
    except StorageException as error:
        logger.exception("Could not upload the student's FHE form")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The FHE form could not be uploaded to secure storage",
        ) from error

    session_data = {
        "student_id": current_student["id"],
        "year_level": year_level,
        "semester": semester,
        "fhe_form_url": object_path,
        "fhe_status": "PENDING",
    }
    try:
        result = (
            db.table("enrollment_session")
            .upsert(
                session_data,
                on_conflict="student_id,year_level,semester",
            )
            .execute()
        )
    except APIError as error:
        try:
            db.storage.from_(bucket_name).remove([object_path])
        except StorageException:
            logger.exception("Could not clean up an FHE object after its session write failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="The file was uploaded, but its enrollment session could not be saved",
        ) from error

    if not result.data:
        try:
            db.storage.from_(bucket_name).remove([object_path])
        except StorageException:
            logger.exception("Could not clean up an FHE object after an empty session response")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="The file was uploaded, but no enrollment session was created",
        )
    previous_path = previous_session.get("fhe_form_url") if previous_session else None
    if previous_path and previous_path != object_path:
        try:
            db.storage.from_(bucket_name).remove([previous_path])
        except StorageException:
            logger.exception("Could not remove a replaced FHE form from private storage")
    return _signed_session(db, result.data[0])
