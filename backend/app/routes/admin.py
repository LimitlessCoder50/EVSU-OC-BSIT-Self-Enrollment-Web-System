from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from supabase import Client

from app.core.admin_accounts import create_admin_account
from app.core.supabase import get_supabase
from app.core.security import get_current_admin, get_current_super_admin
from app.schemas import AdminCreate, AdminResponse, AdminUpdate, MessageResponse

router = APIRouter(prefix="/admins", tags=["Admins"])


def _log_audit(db: Client, admin_id: int, action: str, ip: str | None):
    """Helper to insert an audit log entry."""
    db.table("audit_log").insert(
        {"admin_id": admin_id, "action": action, "ip_address": ip}
    ).execute()


# ---------------------------------------------------------------------------
# POST /admins/  — create an admin
# ---------------------------------------------------------------------------

@router.post(
    "/",
    response_model=AdminResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create an admin account",
)
def create_admin(
    payload: AdminCreate,
    request: Request,
    current_admin: dict = Depends(get_current_super_admin),
    db: Client = Depends(get_supabase),
):
    """Create a regular admin account; only super admins may do this."""
    return create_admin_account(
        payload,
        current_admin["id"],
        request.client.host if request.client else None,
        "CREATE_ADMIN",
        db,
    )


# ---------------------------------------------------------------------------
# GET /admins  — list all admins
# ---------------------------------------------------------------------------

@router.get(
    "/",
    response_model=List[AdminResponse],
    summary="List all admins",
)
def list_admins(
    is_active: Optional[bool] = None,
    current_admin: dict = Depends(get_current_admin),
    db: Client = Depends(get_supabase),
):
    """Return a list of all admins. Optionally filter by active status."""
    query = db.table("admin").select("*").order("created_at", desc=True)

    if is_active is not None:
        query = query.eq("is_active", is_active)

    result = query.execute()
    return result.data


# ---------------------------------------------------------------------------
# GET /admins/{public_id}  — get a single admin
# ---------------------------------------------------------------------------

@router.get(
    "/{public_id}",
    response_model=AdminResponse,
    summary="Get admin by public ID",
)
def get_admin(
    public_id: str,
    current_admin: dict = Depends(get_current_admin),
    db: Client = Depends(get_supabase),
):
    """Return a single admin by their public UUID."""
    result = db.table("admin").select("*").eq("public_id", public_id).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Admin not found",
        )

    return result.data[0]


# ---------------------------------------------------------------------------
# PATCH /admins/{public_id}  — update an admin
# ---------------------------------------------------------------------------

@router.patch(
    "/{public_id}",
    response_model=AdminResponse,
    summary="Update admin details",
)
def update_admin(
    public_id: str,
    payload: AdminUpdate,
    request: Request,
    current_admin: dict = Depends(get_current_super_admin),
    db: Client = Depends(get_supabase),
):
    """Update an admin's profile fields; only super admins may do this."""
    update_data = payload.model_dump(exclude_none=True)

    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    # Check if email is being changed and is already taken
    if "email" in update_data:
        existing = (
            db.table("admin")
            .select("id")
            .eq("email", update_data["email"])
            .neq("public_id", public_id)
            .execute()
        )
        if existing.data:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Email already in use by another admin",
            )

    if "id_number" in update_data:
        existing = (
            db.table("admin")
            .select("id")
            .eq("id_number", update_data["id_number"])
            .neq("public_id", public_id)
            .execute()
        )
        if existing.data:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="ID number already in use by another admin",
            )

    result = (
        db.table("admin")
        .update(update_data)
        .eq("public_id", public_id)
        .execute()
    )

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Admin not found",
        )

    target_name = " ".join(
        part for part in (
            result.data[0].get("fname"),
            result.data[0].get("mname"),
            result.data[0].get("lname"),
        ) if part
    )
    # Audit log
    _log_audit(
        db, current_admin["id"],
        f"Updated administrator account ({target_name})",
        request.client.host if request.client else None,
    )

    return result.data[0]


# ---------------------------------------------------------------------------
# DELETE /admins/{public_id}  — deactivate (soft delete)
# ---------------------------------------------------------------------------

@router.delete(
    "/{public_id}",
    response_model=MessageResponse,
    summary="Deactivate an admin (soft delete)",
)
def deactivate_admin(
    public_id: str,
    request: Request,
    current_admin: dict = Depends(get_current_super_admin),
    db: Client = Depends(get_supabase),
):
    """Deactivate an admin; only super admins may do this."""
    result = (
        db.table("admin")
        .update({"is_active": False})
        .eq("public_id", public_id)
        .execute()
    )

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Admin not found",
        )

    target_name = " ".join(
        part for part in (
            result.data[0].get("fname"),
            result.data[0].get("mname"),
            result.data[0].get("lname"),
        ) if part
    )
    # Audit log
    _log_audit(
        db, current_admin["id"],
        f"Deactivated administrator account ({target_name})",
        request.client.host if request.client else None,
    )

    return MessageResponse(message="Admin deactivated successfully")
