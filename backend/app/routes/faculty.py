from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from postgrest.exceptions import APIError
from supabase import Client

from app.core.security import get_current_super_admin, hash_password
from app.core.supabase import get_supabase
from app.schemas import FacultyCreate, FacultyResponse, FacultyRole, FacultyUpdate, MessageResponse

router = APIRouter(prefix="/faculty", tags=["Faculty"])


def _raise_faculty_conflict(error: APIError, role: str | None = None) -> None:
    if error.code == "23505":
        database_error = " ".join(
            part for part in (error.message, error.details, error.hint) if part
        ).lower()
        detail = (
            "An active department head already exists"
            if role == "department_head"
            and "role" in database_error
            and "department_head" in database_error
            else "A faculty account already uses that email or ID number"
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=detail,
        ) from error
    raise error


def _log_audit(db: Client, admin_id: int, action: str, ip_address: str | None) -> None:
    db.table("audit_log").insert(
        {"admin_id": admin_id, "action": action, "ip_address": ip_address}
    ).execute()


@router.post(
    "/",
    response_model=FacultyResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a department head or instructor",
)
def create_faculty(
    payload: FacultyCreate,
    request: Request,
    current_admin: dict = Depends(get_current_super_admin),
    db: Client = Depends(get_supabase),
):
    """Create a faculty account; only super admins may do this."""
    for field, value, label in (
        ("id_number", payload.id_number, "ID number"),
        ("email", str(payload.email), "Email"),
    ):
        existing = db.table("faculty").select("id").eq(field, value).execute()
        if existing.data:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"{label} already in use by another faculty member",
            )

    faculty_data = payload.model_dump(exclude={"password"})
    faculty_data["email"] = str(payload.email)
    faculty_data["hashed_password"] = hash_password(payload.password)
    try:
        result = db.table("faculty").insert(faculty_data).execute()
    except APIError as error:
        _raise_faculty_conflict(error, payload.role)
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create faculty account",
        )

    created = result.data[0]
    target_name = " ".join(
        part for part in (created.get("fname"), created.get("mname"), created.get("lname"))
        if part
    )
    _log_audit(
        db,
        current_admin["id"],
        f"Created faculty account ({target_name})",
        request.client.host if request.client else None,
    )
    return created


@router.get(
    "/",
    response_model=List[FacultyResponse],
    summary="List faculty accounts",
)
def list_faculty(
    is_active: Optional[bool] = None,
    role: Optional[FacultyRole] = Query(None),
    current_admin: dict = Depends(get_current_super_admin),
    db: Client = Depends(get_supabase),
):
    """List department heads and instructors; only super admins may view them."""
    query = db.table("faculty").select("*").order("created_at", desc=True)
    if is_active is not None:
        query = query.eq("is_active", is_active)
    if role is not None:
        query = query.eq("role", role)
    return query.execute().data


@router.get(
    "/{public_id}",
    response_model=FacultyResponse,
    summary="Get faculty account by public ID",
)
def get_faculty(
    public_id: str,
    current_admin: dict = Depends(get_current_super_admin),
    db: Client = Depends(get_supabase),
):
    result = db.table("faculty").select("*").eq("public_id", public_id).execute()
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Faculty account not found",
        )
    return result.data[0]


@router.patch(
    "/{public_id}",
    response_model=FacultyResponse,
    summary="Update faculty account",
)
def update_faculty(
    public_id: str,
    payload: FacultyUpdate,
    request: Request,
    current_admin: dict = Depends(get_current_super_admin),
    db: Client = Depends(get_supabase),
):
    """Update faculty details without changing the password."""
    update_data = payload.model_dump(exclude_none=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    for field, label in (("email", "Email"), ("id_number", "ID number")):
        if field not in update_data:
            continue
        existing = (
            db.table("faculty")
            .select("id")
            .eq(field, str(update_data[field]))
            .neq("public_id", public_id)
            .execute()
        )
        if existing.data:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"{label} already in use by another faculty member",
            )

    try:
        result = (
            db.table("faculty")
            .update(update_data)
            .eq("public_id", public_id)
            .execute()
        )
    except APIError as error:
        _raise_faculty_conflict(error, update_data.get("role"))
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Faculty account not found",
        )

    target_name = " ".join(
        part for part in (
            result.data[0].get("fname"),
            result.data[0].get("mname"),
            result.data[0].get("lname"),
        ) if part
    )
    _log_audit(
        db,
        current_admin["id"],
        f"Updated faculty account ({target_name})",
        request.client.host if request.client else None,
    )
    return result.data[0]


@router.delete(
    "/{public_id}",
    response_model=MessageResponse,
    summary="Deactivate faculty account",
)
def deactivate_faculty(
    public_id: str,
    request: Request,
    current_admin: dict = Depends(get_current_super_admin),
    db: Client = Depends(get_supabase),
):
    """Deactivate a faculty account while preserving its history."""
    result = (
        db.table("faculty")
        .update({"is_active": False})
        .eq("public_id", public_id)
        .execute()
    )
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Faculty account not found",
        )

    target_name = " ".join(
        part for part in (
            result.data[0].get("fname"),
            result.data[0].get("mname"),
            result.data[0].get("lname"),
        ) if part
    )
    _log_audit(
        db,
        current_admin["id"],
        f"Deactivated faculty account ({target_name})",
        request.client.host if request.client else None,
    )
    return MessageResponse(message="Faculty account deactivated successfully")
