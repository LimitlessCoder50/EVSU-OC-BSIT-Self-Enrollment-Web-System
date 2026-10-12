from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from postgrest.exceptions import APIError
from supabase import Client

from app.core.security import get_current_department_head, get_current_user
from app.core.supabase import get_supabase
from app.schemas import MessageResponse, SubjectCreate, SubjectResponse, SubjectUpdate

router = APIRouter(prefix="/subjects", tags=["Subjects"])


def _log_audit(db: Client, faculty_id: int, action: str, ip_address: str | None) -> None:
    db.table("audit_log").insert(
        {"faculty_id": faculty_id, "action": action, "ip_address": ip_address}
    ).execute()


def _raise_duplicate_course_number(error: APIError) -> None:
    if error.code == "23505":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A subject with this course number already exists",
        ) from error
    raise error


@router.get(
    "/",
    response_model=List[SubjectResponse],
    summary="List subjects",
)
def list_subjects(
    year_level: int | None = Query(default=None, ge=1, le=4),
    semester: int | None = Query(default=None, ge=1, le=3),
    current_user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase),
):
    """List curriculum subjects for any authenticated account."""
    query = db.table("subject").select("*")
    if year_level is not None:
        query = query.eq("year_level", year_level)
    if semester is not None:
        query = query.eq("semester", semester)
    return (
        query
        .order("year_level")
        .order("semester")
        .order("course_no")
        .execute()
        .data
    )


@router.get(
    "/{public_id}",
    response_model=SubjectResponse,
    summary="Get subject by public ID",
)
def get_subject(
    public_id: str,
    current_user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase),
):
    result = db.table("subject").select("*").eq("public_id", public_id).execute()
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Subject not found",
        )
    return result.data[0]


@router.post(
    "/",
    response_model=SubjectResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a subject",
)
def create_subject(
    payload: SubjectCreate,
    request: Request,
    current_department_head: dict = Depends(get_current_department_head),
    db: Client = Depends(get_supabase),
):
    """Create a curriculum subject; only the department head may do this."""
    try:
        result = db.table("subject").insert(payload.model_dump()).execute()
    except APIError as error:
        _raise_duplicate_course_number(error)

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create subject",
        )
    created = result.data[0]
    _log_audit(
        db,
        current_department_head["id"],
        f"Created subject ({created['course_no']})",
        request.client.host if request.client else None,
    )
    return created


@router.patch(
    "/{public_id}",
    response_model=SubjectResponse,
    summary="Update a subject",
)
def update_subject(
    public_id: str,
    payload: SubjectUpdate,
    request: Request,
    current_department_head: dict = Depends(get_current_department_head),
    db: Client = Depends(get_supabase),
):
    """Update curriculum subject details; only the department head may do this."""
    update_data = payload.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    if "course_no" in update_data:
        existing = (
            db.table("subject")
            .select("id")
            .eq("course_no", update_data["course_no"])
            .neq("public_id", public_id)
            .execute()
        )
        if existing.data:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A subject with this course number already exists",
            )

    try:
        result = (
            db.table("subject")
            .update(update_data)
            .eq("public_id", public_id)
            .execute()
        )
    except APIError as error:
        _raise_duplicate_course_number(error)

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Subject not found",
        )
    _log_audit(
        db,
        current_department_head["id"],
        f"Updated subject ({result.data[0]['course_no']})",
        request.client.host if request.client else None,
    )
    return result.data[0]


@router.delete(
    "/{public_id}",
    response_model=MessageResponse,
    summary="Delete a subject",
)
def delete_subject(
    public_id: str,
    request: Request,
    current_department_head: dict = Depends(get_current_department_head),
    db: Client = Depends(get_supabase),
):
    """Permanently delete a subject; only the department head may do this."""
    existing = db.table("subject").select("id,course_no").eq("public_id", public_id).execute()
    if not existing.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Subject not found",
        )
    db.table("subject").delete().eq("public_id", public_id).execute()
    _log_audit(
        db,
        current_department_head["id"],
        f"Deleted subject ({existing.data[0]['course_no']})",
        request.client.host if request.client else None,
    )
    return MessageResponse(message="Subject deleted successfully")
