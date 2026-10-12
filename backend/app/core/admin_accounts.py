from fastapi import HTTPException, status
from supabase import Client

from app.core.security import hash_password
from app.schemas import AdminCreate


def create_admin_account(
    payload: AdminCreate,
    actor_id: int,
    ip_address: str | None,
    action: str,
    db: Client,
) -> dict:
    """Create a regular admin account and record the action."""
    existing = db.table("admin").select("id").eq("email", payload.email).execute()
    if existing.data:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An admin with this email already exists",
        )

    existing_id_number = (
        db.table("admin").select("id").eq("id_number", payload.id_number).execute()
    )
    if existing_id_number.data:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An admin with this ID number already exists",
        )

    new_admin = {
        "fname": payload.fname,
        "mname": payload.mname,
        "lname": payload.lname,
        "id_number": payload.id_number,
        "email": payload.email,
        "hashed_password": hash_password(payload.password),
        "role": "admin",
    }
    result = db.table("admin").insert(new_admin).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create admin",
        )

    db.table("audit_log").insert(
        {"admin_id": actor_id, "action": action, "ip_address": ip_address}
    ).execute()
    return result.data[0]
